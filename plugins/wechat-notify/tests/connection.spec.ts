import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ClawbotFilesystemGateway,
  WechatConnectionAdapter,
  WechatConnectionError,
  type ClawbotConnectionGateway,
  type ClawbotCredentials,
  type ClawbotQrStatus,
  type ExternalBridgeObserver,
  type HostOwnedBridgeController,
} from '../src/connection.ts'

const tempDirectories: string[] = []

afterEach(async () => {
  vi.restoreAllMocks()
  while (tempDirectories.length > 0) await rm(tempDirectories.pop()!, { recursive: true, force: true })
})

function credentials(userId = 'wechat-user-12345678'): ClawbotCredentials {
  return {
    botToken: 'secret-token',
    baseUrl: 'https://ilinkai.weixin.qq.com',
    ilinkBotId: 'bot-1',
    ilinkUserId: userId,
  }
}

function gateway(overrides: Partial<ClawbotConnectionGateway> = {}): ClawbotConnectionGateway {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    inspectCredentials: vi.fn().mockResolvedValue({ auth: 'authenticated', delivery: 'needs-activation', maskedUserId: 'wech***5678' }),
    createLoginQr: vi.fn().mockResolvedValue({ qrcode: 'internal-qrcode', qrPayload: 'public-qr-payload' }),
    pollLogin: vi.fn().mockResolvedValue({ status: 'wait' }),
    replaceCredentials: vi.fn().mockResolvedValue(undefined),
    clearCredentials: vi.fn().mockResolvedValue(undefined),
    clearLegacyPendingLogin: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function hostBridge(overrides: Partial<HostOwnedBridgeController> = {}): HostOwnedBridgeController {
  return {
    inspect: vi.fn().mockResolvedValue({ state: 'running' }),
    stopAndWaitForExit: vi.fn().mockResolvedValue(undefined),
    startAndWaitUntilReady: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

describe('WechatConnectionAdapter', () => {
  it('keeps authentication, delivery, and process state orthogonal', async () => {
    const adapter = new WechatConnectionAdapter({ gateway: gateway(), externalBridge: { inspect: async () => 'none' } })
    const status = await adapter.status()

    expect(status).toMatchObject({
      auth: 'authenticated',
      delivery: 'needs-activation',
      process: 'none',
      identity: { maskedUserId: 'wech***5678' },
    })
    expect(status).not.toHaveProperty('connected')
    expect(JSON.stringify(status)).not.toContain('secret-token')
  })

  it('observes an external bridge but never signals or clears it', async () => {
    const external: ExternalBridgeObserver = { inspect: vi.fn().mockResolvedValue('external') }
    const service = gateway()
    const adapter = new WechatConnectionAdapter({ gateway: service, externalBridge: external })

    await expect(adapter.status()).resolves.toMatchObject({ process: 'external' })
    await expect(adapter.reconnect()).rejects.toMatchObject({ code: 'BRIDGE_NOT_OWNED' })
    await expect(adapter.disconnect(true)).rejects.toMatchObject({ code: 'BRIDGE_NOT_OWNED' })
    expect(service.clearCredentials).not.toHaveBeenCalled()
    expect(service.clearLegacyPendingLogin).not.toHaveBeenCalled()
  })

  it('restarts a Host-owned bridge in strict stop-then-start order', async () => {
    const calls: string[] = []
    const bridge = hostBridge({
      stopAndWaitForExit: async () => { calls.push('stop-complete') },
      startAndWaitUntilReady: async () => { calls.push('start-ready') },
    })
    const adapter = new WechatConnectionAdapter({ gateway: gateway(), hostBridge: bridge })

    await adapter.reconnect()
    expect(calls).toEqual(['stop-complete', 'start-ready'])
  })

  it('requires confirmation and clears credentials only after an owned bridge exits', async () => {
    const calls: string[] = []
    const service = gateway({
      clearCredentials: async () => { calls.push('clear-credentials') },
      clearLegacyPendingLogin: async () => { calls.push('clear-pending') },
    })
    const adapter = new WechatConnectionAdapter({
      gateway: service,
      hostBridge: hostBridge({ stopAndWaitForExit: async () => { calls.push('stop-complete') } }),
    })

    await expect(adapter.disconnect(false)).rejects.toMatchObject({ code: 'CONFIRMATION_REQUIRED' })
    expect(calls).toEqual([])
    await adapter.disconnect(true)
    expect(calls).toEqual(['stop-complete', 'clear-credentials', 'clear-pending'])
  })

  it('keeps QR secrets in memory, applies TTL, and persists only confirmed credentials', async () => {
    let now = 1_000
    const pollResults: ClawbotQrStatus[] = [
      { status: 'wait' },
      { status: 'scaned' },
      { status: 'confirmed', credentials: credentials() },
    ]
    const service = gateway({ pollLogin: vi.fn(async () => pollResults.shift()!) })
    const adapter = new WechatConnectionAdapter({
      gateway: service, now: () => now, loginTtlMs: 100, createSessionId: () => 'session-1',
    })

    const started = await adapter.login()
    expect(started.login).toEqual({ sessionId: 'session-1', expiresAt: 1_100, qrPayload: 'public-qr-payload' })
    expect(JSON.stringify(started.status)).not.toContain('internal-qrcode')
    await expect(adapter.confirmLogin('session-1')).resolves.toMatchObject({ result: 'waiting' })
    await expect(adapter.confirmLogin('session-1')).resolves.toMatchObject({ result: 'scanned' })
    await expect(adapter.confirmLogin('session-1')).resolves.toMatchObject({ result: 'confirmed' })
    expect(service.replaceCredentials).toHaveBeenCalledWith(credentials())

    await adapter.login()
    now = 1_100
    await expect(adapter.confirmLogin('session-1')).rejects.toMatchObject({ code: 'LOGIN_SESSION_EXPIRED' })
  })

  it('allows only one mutating operation at a time', async () => {
    let release!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const adapter = new WechatConnectionAdapter({
      gateway: gateway({ createLoginQr: vi.fn(async () => { await blocked; return { qrcode: 'internal-qrcode', qrPayload: 'payload' } }) }),
    })

    const first = adapter.login()
    await vi.waitFor(async () => expect((await adapter.status()).operation).toBe('login'))
    await expect(adapter.login()).rejects.toMatchObject({ code: 'OPERATION_IN_PROGRESS' })
    release()
    await first
  })

  it('retires a session when ClawBot reports the QR code expired', async () => {
    const adapter = new WechatConnectionAdapter({
      gateway: gateway({ pollLogin: vi.fn().mockResolvedValue({ status: 'expired' }) }),
      createSessionId: () => 'expired-session',
    })

    await adapter.login()
    await expect(adapter.confirmLogin('expired-session')).resolves.toMatchObject({
      result: 'expired',
      status: { auth: 'authenticated' },
    })
    await expect(adapter.confirmLogin('expired-session')).rejects.toMatchObject({ code: 'LOGIN_SESSION_EXPIRED' })
  })
})

describe('ClawbotFilesystemGateway', () => {
  async function fixture(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'wechat-connection-'))
    tempDirectories.push(directory)
    return directory
  }

  it('reports an empty CLI path as unsupported without attempting a module import', async () => {
    const importModule = vi.fn()
    const service = new ClawbotFilesystemGateway({ clawbotIndex: '  ', importModule })
    const adapter = new WechatConnectionAdapter({ gateway: service })

    await expect(service.isAvailable()).resolves.toBe(false)
    await expect(adapter.status()).resolves.toMatchObject({
      availability: 'unsupported', auth: 'unknown', delivery: 'unknown',
    })
    await expect(adapter.login()).rejects.toMatchObject({
      code: 'UNSUPPORTED', message: 'ClawBot 微信组件不可用',
    })
    await expect(service.createLoginQr()).rejects.toMatchObject({
      code: 'UNSUPPORTED', message: 'ClawBot 微信组件不可用',
    })
    expect(importModule).not.toHaveBeenCalled()
  })

  it('treats credentials without context tokens as authenticated but not delivery-ready', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'credentials.json'), JSON.stringify(credentials()), 'utf8')
    const instance = new ClawbotFilesystemGateway({ clawbotIndex: join(directory, 'index.js'), dataDirectory: directory })

    await expect(instance.inspectCredentials()).resolves.toEqual({
      auth: 'authenticated',
      delivery: 'needs-activation',
      maskedUserId: 'wech***5678',
    })
  })

  it('rejects malformed, oversized, and untrusted confirmed payloads', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'credentials.json'), '{broken', 'utf8')
    const malformed = new ClawbotFilesystemGateway({ clawbotIndex: join(directory, 'index.js'), dataDirectory: directory })
    await expect(malformed.inspectCredentials()).resolves.toMatchObject({ auth: 'unknown', lastError: { code: 'CREDENTIALS_INVALID' } })

    await writeFile(join(directory, 'credentials.json'), 'x'.repeat(64 * 1_024 + 1), 'utf8')
    await expect(malformed.inspectCredentials()).resolves.toMatchObject({ auth: 'unknown' })

    const hostile = new ClawbotFilesystemGateway({
      clawbotIndex: join(directory, 'index.js'),
      dataDirectory: directory,
      importModule: async () => ({ pollQRCodeStatus: async () => ({
        status: 'confirmed', bot_token: 'token', ilink_bot_id: 'bot', ilink_user_id: 'user-12345678',
        baseurl: 'https://attacker.example',
      }) }),
    })
    await expect(hostile.pollLogin('qrcode-value')).rejects.toMatchObject({ code: 'LOGIN_PROTOCOL_ERROR' })
  })

  it('reports structurally invalid context token files without exposing their values', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'credentials.json'), JSON.stringify(credentials()), 'utf8')
    await writeFile(join(directory, 'context_tokens.json'), JSON.stringify({ user: { token: 'context-secret' } }), 'utf8')
    const instance = new ClawbotFilesystemGateway({ clawbotIndex: join(directory, 'index.js'), dataDirectory: directory })

    const inspection = await instance.inspectCredentials()
    expect(inspection).toMatchObject({ auth: 'authenticated', delivery: 'unknown', lastError: { code: 'CONTEXT_TOKENS_INVALID' } })
    expect(JSON.stringify(inspection)).not.toContain('context-secret')
  })

  it('clears old context tokens before saving replacement credentials', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'context_tokens.json'), JSON.stringify({ old: 'context-secret' }), 'utf8')
    let contextAtSave = ''
    const instance = new ClawbotFilesystemGateway({
      clawbotIndex: join(directory, 'index.js'),
      dataDirectory: directory,
      importModule: async () => ({
        saveCredentials: async () => { contextAtSave = await readFile(join(directory, 'context_tokens.json'), 'utf8') },
      }),
    })

    await instance.replaceCredentials(credentials())
    expect(contextAtSave).toBe('{}\n')
  })

  it('never leaks a full identity through inspection', async () => {
    const directory = await fixture()
    await writeFile(join(directory, 'credentials.json'), JSON.stringify(credentials('full-user-id-87654321')), 'utf8')
    const instance = new ClawbotFilesystemGateway({ clawbotIndex: join(directory, 'index.js'), dataDirectory: directory })
    const inspection = await instance.inspectCredentials()
    expect(inspection.maskedUserId).toBe('full***4321')
    expect(JSON.stringify(inspection)).not.toContain('full-user-id-87654321')
  })
})
