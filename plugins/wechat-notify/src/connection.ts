import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Service } from '@deepseek-ai/cordis'
import type { Context } from '@deepseek-ai/cordis'

export const WECHAT_CONNECTION_SCHEMA_VERSION = 1 as const
export const DEFAULT_WECHAT_LOGIN_TTL_MS = 5 * 60 * 1_000

export type WechatAvailability = 'available' | 'unsupported'
export type WechatAuthState = 'unconfigured' | 'pending' | 'authenticated' | 'expired' | 'unknown'
export type WechatProcessState =
  | 'host-managed-running'
  | 'host-managed-stopped'
  | 'external'
  | 'none'
  | 'unknown'
export type WechatDeliveryState = 'ready' | 'needs-activation' | 'not-ready' | 'unknown'
export type WechatConnectionOperation = 'idle' | 'login' | 'confirm-login' | 'reconnect' | 'disconnect'

export interface WechatPendingLogin {
  sessionId: string
  phase: 'waiting' | 'scanned'
  expiresAt: number
}

export interface WechatRuntimeStatus {
  schemaVersion: typeof WECHAT_CONNECTION_SCHEMA_VERSION
  provider: 'clawbot-wechat'
  availability: WechatAvailability
  auth: WechatAuthState
  process: WechatProcessState
  delivery: WechatDeliveryState
  operation: WechatConnectionOperation
  capabilities: {
    canLogin: boolean
    canReconnect: boolean
    canDisconnect: boolean
  }
  pendingLogin?: WechatPendingLogin
  identity?: { maskedUserId: string }
  lastError?: { code: string; message: string }
  checkedAt: number
}

export interface WechatLoginStart {
  login: {
    sessionId: string
    expiresAt: number
    qrPayload: string
  }
  status: WechatRuntimeStatus
}

export interface WechatLoginConfirmation {
  result: 'waiting' | 'scanned' | 'confirmed' | 'expired'
  status: WechatRuntimeStatus
}

export type WechatConnectionErrorCode =
  | 'UNSUPPORTED'
  | 'OPERATION_IN_PROGRESS'
  | 'LOGIN_SESSION_NOT_FOUND'
  | 'LOGIN_SESSION_EXPIRED'
  | 'LOGIN_PROTOCOL_ERROR'
  | 'NEEDS_LOGIN'
  | 'BRIDGE_NOT_OWNED'
  | 'CONFIRMATION_REQUIRED'
  | 'OPERATION_FAILED'

/** Stable operation error safe to translate into an HTTP response. */
export class WechatConnectionError extends Error {
  constructor(readonly code: WechatConnectionErrorCode, message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'WechatConnectionError'
  }
}

/** Host-internal credential shape. Never expose this type through an HTTP response. */
export interface ClawbotCredentials {
  botToken: string
  baseUrl: string
  ilinkBotId: string
  ilinkUserId: string
}

export interface ClawbotCredentialInspection {
  auth: Exclude<WechatAuthState, 'pending'>
  delivery: WechatDeliveryState
  maskedUserId?: string
  lastError?: { code: string; message: string }
}

export type ClawbotQrStatus =
  | { status: 'wait' }
  | { status: 'scaned' }
  | { status: 'expired' }
  | { status: 'confirmed'; credentials: ClawbotCredentials }

/** ClawBot credential and QR operations. Implementations never return stored secrets. */
export interface ClawbotConnectionGateway {
  isAvailable(): Promise<boolean>
  inspectCredentials(): Promise<ClawbotCredentialInspection>
  createLoginQr(): Promise<{ qrcode: string; qrPayload: string }>
  pollLogin(qrcode: string): Promise<ClawbotQrStatus>
  replaceCredentials(credentials: ClawbotCredentials): Promise<void>
  clearCredentials(): Promise<void>
  clearLegacyPendingLogin(): Promise<void>
}

export interface HostOwnedBridgeInspection {
  state: 'running' | 'stopped' | 'unknown'
}

/** Lifecycle controller whose stop call resolves only after its whole process tree exits. */
export interface HostOwnedBridgeController {
  inspect(): Promise<HostOwnedBridgeInspection>
  stopAndWaitForExit(): Promise<void>
  startAndWaitUntilReady(): Promise<void>
}

export interface ExternalBridgeObserver {
  inspect(): Promise<'external' | 'none' | 'unknown'>
}

interface LoginSession {
  sessionId: string
  qrcode: string
  qrPayload: string
  phase: 'waiting' | 'scanned'
  expiresAt: number
}

class LoginSessionStore {
  private current: LoginSession | undefined
  private expiredSessionId: string | undefined

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number,
    private readonly createId: () => string,
  ) {}

  begin(qrcode: string, qrPayload: string): LoginSession {
    const session = {
      sessionId: this.createId(),
      qrcode,
      qrPayload,
      phase: 'waiting' as const,
      expiresAt: this.now() + this.ttlMs,
    }
    this.current = session
    this.expiredSessionId = undefined
    return session
  }

  snapshot(): WechatPendingLogin | undefined {
    const session = this.current
    if (session === undefined) return undefined
    if (this.now() >= session.expiresAt) {
      this.expiredSessionId = session.sessionId
      this.current = undefined
      return undefined
    }
    return { sessionId: session.sessionId, phase: session.phase, expiresAt: session.expiresAt }
  }

  require(sessionId: string): LoginSession {
    const session = this.current
    if (session === undefined) {
      if (sessionId === this.expiredSessionId) {
        throw new WechatConnectionError('LOGIN_SESSION_EXPIRED', '微信登录二维码已过期')
      }
      throw new WechatConnectionError('LOGIN_SESSION_NOT_FOUND', '微信登录会话不存在')
    }
    if (session.sessionId !== sessionId) {
      throw new WechatConnectionError('LOGIN_SESSION_NOT_FOUND', '微信登录会话不存在')
    }
    if (this.now() >= session.expiresAt) {
      this.expiredSessionId = session.sessionId
      this.current = undefined
      throw new WechatConnectionError('LOGIN_SESSION_EXPIRED', '微信登录二维码已过期')
    }
    return session
  }

  markScanned(session: LoginSession): void {
    if (this.current === session) session.phase = 'scanned'
  }

  expire(session: LoginSession): void {
    if (this.current !== session) return
    this.expiredSessionId = session.sessionId
    this.current = undefined
  }

  finish(session: LoginSession): void {
    if (this.current === session) this.current = undefined
    this.expiredSessionId = undefined
  }

  clear(): void {
    this.current = undefined
    this.expiredSessionId = undefined
  }
}

class SingleFlightGate {
  private active: Exclude<WechatConnectionOperation, 'idle'> | undefined

  get operation(): WechatConnectionOperation {
    return this.active ?? 'idle'
  }

  async run<T>(operation: Exclude<WechatConnectionOperation, 'idle'>, task: () => Promise<T>): Promise<T> {
    if (this.active !== undefined) {
      throw new WechatConnectionError('OPERATION_IN_PROGRESS', `微信连接操作 ${this.active} 正在进行`)
    }
    this.active = operation
    try {
      return await task()
    } finally {
      this.active = undefined
    }
  }
}

export interface WechatConnectionAdapterOptions {
  gateway: ClawbotConnectionGateway
  hostBridge?: HostOwnedBridgeController
  externalBridge?: ExternalBridgeObserver
  loginTtlMs?: number
  now?: () => number
  createSessionId?: () => string
}

/** Owns the in-memory login lifecycle and refuses process changes without an injected Host owner. */
export class WechatConnectionAdapter {
  private readonly gate = new SingleFlightGate()
  private readonly sessions: LoginSessionStore
  private readonly now: () => number

  constructor(private readonly options: WechatConnectionAdapterOptions) {
    this.now = options.now ?? Date.now
    const ttlMs = options.loginTtlMs ?? DEFAULT_WECHAT_LOGIN_TTL_MS
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) throw new TypeError('wechat login TTL must be a positive safe integer')
    this.sessions = new LoginSessionStore(ttlMs, this.now, options.createSessionId ?? randomUUID)
  }

  /** Read orthogonal authentication, process, and delivery facts without deriving connected from credentials. */
  async status(): Promise<WechatRuntimeStatus> {
    const checkedAt = this.now()
    let availability: WechatAvailability = 'unsupported'
    let credential: ClawbotCredentialInspection = { auth: 'unknown', delivery: 'unknown' }
    let process: WechatProcessState = 'unknown'
    let lastError: WechatRuntimeStatus['lastError']

    try {
      availability = await this.options.gateway.isAvailable() ? 'available' : 'unsupported'
      if (availability === 'available') credential = await this.options.gateway.inspectCredentials()
    } catch {
      availability = 'unsupported'
      lastError = { code: 'CLAWBOT_UNAVAILABLE', message: 'ClawBot 微信组件不可用' }
    }

    try {
      if (this.options.hostBridge !== undefined) {
        const observation = await this.options.hostBridge.inspect()
        process = observation.state === 'running'
          ? 'host-managed-running'
          : observation.state === 'stopped'
            ? 'host-managed-stopped'
            : 'unknown'
      } else {
        process = await this.options.externalBridge?.inspect() ?? 'unknown'
      }
    } catch {
      process = 'unknown'
      lastError ??= { code: 'BRIDGE_INSPECTION_FAILED', message: '微信 bridge 状态检查失败' }
    }

    lastError ??= credential.lastError
    const pendingLogin = this.sessions.snapshot()
    const auth = pendingLogin === undefined ? credential.auth : 'pending'
    const canMutateOwnedBridge = this.options.hostBridge !== undefined && this.gate.operation === 'idle'
    return {
      schemaVersion: WECHAT_CONNECTION_SCHEMA_VERSION,
      provider: 'clawbot-wechat',
      availability,
      auth,
      process,
      delivery: credential.delivery,
      operation: this.gate.operation,
      capabilities: {
        canLogin: availability === 'available' && this.gate.operation === 'idle',
        canReconnect: canMutateOwnedBridge && credential.auth === 'authenticated',
        canDisconnect: canMutateOwnedBridge && (credential.auth !== 'unconfigured' || pendingLogin !== undefined),
      },
      ...(pendingLogin === undefined ? {} : { pendingLogin }),
      ...(credential.maskedUserId === undefined ? {} : { identity: { maskedUserId: credential.maskedUserId } }),
      ...(lastError === undefined ? {} : { lastError }),
      checkedAt,
    }
  }

  /** Start one five-minute in-memory QR login session. */
  async login(): Promise<WechatLoginStart> {
    const login = await this.gate.run('login', async () => {
      if (!await this.options.gateway.isAvailable()) {
        throw new WechatConnectionError('UNSUPPORTED', 'ClawBot 微信组件不可用')
      }
      try {
        const qr = await this.options.gateway.createLoginQr()
        assertBoundedString(qr.qrcode, 'qrcode', 8_192)
        assertBoundedString(qr.qrPayload, 'qrPayload', 16_384)
        const session = this.sessions.begin(qr.qrcode, qr.qrPayload)
        return { sessionId: session.sessionId, expiresAt: session.expiresAt, qrPayload: session.qrPayload }
      } catch (error) {
        if (error instanceof WechatConnectionError) throw error
        throw new WechatConnectionError('OPERATION_FAILED', '微信登录二维码生成失败', { cause: error })
      }
    })
    return { login, status: await this.status() }
  }

  /** Poll one short-lived login session and save only validated ClawBot credentials on confirmation. */
  async confirmLogin(sessionId: string): Promise<WechatLoginConfirmation> {
    let result: WechatLoginConfirmation['result']
    await this.gate.run('confirm-login', async () => {
      const session = this.sessions.require(sessionId)
      let polled: ClawbotQrStatus
      try {
        polled = await this.options.gateway.pollLogin(session.qrcode)
      } catch (error) {
        if (error instanceof WechatConnectionError) throw error
        throw new WechatConnectionError('OPERATION_FAILED', '微信登录状态检查失败', { cause: error })
      }
      switch (polled.status) {
        case 'wait':
          result = 'waiting'
          return
        case 'scaned':
          this.sessions.markScanned(session)
          result = 'scanned'
          return
        case 'expired':
          this.sessions.expire(session)
          result = 'expired'
          return
        case 'confirmed':
          await this.options.gateway.replaceCredentials(polled.credentials)
          this.sessions.finish(session)
          result = 'confirmed'
          return
      }
    })
    return { result: result!, status: await this.status() }
  }

  /** Restart only a bridge explicitly owned by the Host. */
  async reconnect(): Promise<WechatRuntimeStatus> {
    await this.gate.run('reconnect', async () => {
      const bridge = this.requireHostBridge()
      const credential = await this.options.gateway.inspectCredentials()
      if (credential.auth !== 'authenticated') {
        throw new WechatConnectionError('NEEDS_LOGIN', '微信凭据未配置或已失效')
      }
      try {
        await bridge.stopAndWaitForExit()
        await bridge.startAndWaitUntilReady()
      } catch (error) {
        throw new WechatConnectionError('OPERATION_FAILED', '微信 bridge 重连失败', { cause: error })
      }
    })
    return await this.status()
  }

  /** Stop an owned bridge before removing credentials; external processes are never signalled. */
  async disconnect(confirm: boolean): Promise<WechatRuntimeStatus> {
    if (!confirm) throw new WechatConnectionError('CONFIRMATION_REQUIRED', '断开微信前需要明确确认')
    await this.gate.run('disconnect', async () => {
      const bridge = this.requireHostBridge()
      try {
        await bridge.stopAndWaitForExit()
        await this.options.gateway.clearCredentials()
        await this.options.gateway.clearLegacyPendingLogin()
        this.sessions.clear()
      } catch (error) {
        throw new WechatConnectionError('OPERATION_FAILED', '微信断开操作失败', { cause: error })
      }
    })
    return await this.status()
  }

  private requireHostBridge(): HostOwnedBridgeController {
    if (this.options.hostBridge === undefined) {
      throw new WechatConnectionError('BRIDGE_NOT_OWNED', '微信 bridge 不由 DSH Host 管理')
    }
    return this.options.hostBridge
  }
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    wechatConnection: WechatConnectionService
  }
}

/** Cordis capability exposing only the sanitized adapter contract. */
export class WechatConnectionService extends Service {
  constructor(ctx: Context, private readonly adapter: WechatConnectionAdapter) {
    super(ctx, 'wechatConnection')
  }

  status(): Promise<WechatRuntimeStatus> { return this.adapter.status() }
  login(): Promise<WechatLoginStart> { return this.adapter.login() }
  confirmLogin(sessionId: string): Promise<WechatLoginConfirmation> {
    return this.adapter.confirmLogin(sessionId)
  }
  reconnect(): Promise<WechatRuntimeStatus> { return this.adapter.reconnect() }
  disconnect(confirm: boolean): Promise<WechatRuntimeStatus> { return this.adapter.disconnect(confirm) }
}

type ModuleLoader = (url: string) => Promise<unknown>

export interface ClawbotFilesystemGatewayOptions {
  clawbotIndex: string
  dataDirectory?: string
  importModule?: ModuleLoader
}

const WECHAT_ILINK_ORIGIN = 'https://ilinkai.weixin.qq.com'
const MAX_CREDENTIAL_FILE_BYTES = 64 * 1_024
const MAX_CONTEXT_FILE_BYTES = 4 * 1_024 * 1_024

/** File-backed ClawBot gateway that validates all module and JSON results before use. */
export class ClawbotFilesystemGateway implements ClawbotConnectionGateway {
  private readonly dataDirectory: string
  private readonly importModule: ModuleLoader

  constructor(private readonly options: ClawbotFilesystemGatewayOptions) {
    this.dataDirectory = options.dataDirectory ?? join(homedir(), '.wx-ai-bridge')
    this.importModule = options.importModule ?? (url => import(url))
  }

  async isAvailable(): Promise<boolean> {
    if (this.options.clawbotIndex.trim().length === 0) return false
    try {
      await Promise.all([
        access(this.options.clawbotIndex),
        access(join(dirname(this.options.clawbotIndex), 'ilink', 'auth.js')),
        access(join(dirname(this.options.clawbotIndex), 'config.js')),
      ])
      return true
    } catch {
      return false
    }
  }

  async inspectCredentials(): Promise<ClawbotCredentialInspection> {
    const credentials = await readBoundedJson(join(this.dataDirectory, 'credentials.json'), MAX_CREDENTIAL_FILE_BYTES)
    if (credentials.kind === 'missing') return { auth: 'unconfigured', delivery: 'not-ready' }
    if (credentials.kind === 'invalid') {
      return {
        auth: 'unknown',
        delivery: 'unknown',
        lastError: { code: 'CREDENTIALS_INVALID', message: 'ClawBot 凭据文件无效' },
      }
    }
    const parsedCredentials = parseStoredCredentials(credentials.value)
    if (parsedCredentials === undefined) {
      if (isPlainObject(credentials.value) && Object.keys(credentials.value).length === 0) {
        return { auth: 'unconfigured', delivery: 'not-ready' }
      }
      return {
        auth: 'unknown',
        delivery: 'unknown',
        lastError: { code: 'CREDENTIALS_INVALID', message: 'ClawBot 凭据文件无效' },
      }
    }

    const contexts = await readBoundedJson(join(this.dataDirectory, 'context_tokens.json'), MAX_CONTEXT_FILE_BYTES)
    if (contexts.kind === 'invalid') {
      return {
        auth: 'authenticated',
        delivery: 'unknown',
        maskedUserId: maskIdentifier(parsedCredentials.ilinkUserId),
        lastError: { code: 'CONTEXT_TOKENS_INVALID', message: 'ClawBot 会话激活信息无效' },
      }
    }
    let hasContext = false
    if (contexts.kind === 'value') {
      const value = contexts.value
      if (!isStringRecord(value)) {
        return {
          auth: 'authenticated',
          delivery: 'unknown',
          maskedUserId: maskIdentifier(parsedCredentials.ilinkUserId),
          lastError: { code: 'CONTEXT_TOKENS_INVALID', message: 'ClawBot 会话激活信息无效' },
        }
      }
      hasContext = Object.values(value).some(entry => entry.length > 0)
    }
    return {
      auth: 'authenticated',
      delivery: hasContext ? 'ready' : 'needs-activation',
      maskedUserId: maskIdentifier(parsedCredentials.ilinkUserId),
    }
  }

  async createLoginQr(): Promise<{ qrcode: string; qrPayload: string }> {
    const auth = await this.loadModule('ilink/auth.js')
    const getQRCode = getFunction(auth, 'getQRCode')
    const value = await getQRCode()
    if (!isPlainObject(value)) throw new WechatConnectionError('LOGIN_PROTOCOL_ERROR', '微信二维码响应无效')
    const qrcode = boundedString(value.qrcode, 8_192)
    const qrPayload = boundedString(value.qrcode_img_content, 16_384) ?? qrcode
    if (qrcode === undefined || qrPayload === undefined) {
      throw new WechatConnectionError('LOGIN_PROTOCOL_ERROR', '微信二维码响应缺少必要字段')
    }
    return { qrcode, qrPayload }
  }

  async pollLogin(qrcode: string): Promise<ClawbotQrStatus> {
    assertBoundedString(qrcode, 'qrcode', 8_192)
    const auth = await this.loadModule('ilink/auth.js')
    const pollQRCodeStatus = getFunction(auth, 'pollQRCodeStatus')
    const value = await pollQRCodeStatus(qrcode)
    if (!isPlainObject(value)) throw new WechatConnectionError('LOGIN_PROTOCOL_ERROR', '微信登录状态响应无效')
    if (value.status === 'wait' || value.status === 'scaned' || value.status === 'expired') {
      return { status: value.status }
    }
    if (value.status !== 'confirmed') {
      throw new WechatConnectionError('LOGIN_PROTOCOL_ERROR', '微信登录状态响应无效')
    }
    const credentials = parseConfirmedCredentials(value)
    if (credentials === undefined) {
      throw new WechatConnectionError('LOGIN_PROTOCOL_ERROR', '微信登录确认响应缺少凭据')
    }
    return { status: 'confirmed', credentials }
  }

  async replaceCredentials(credentials: ClawbotCredentials): Promise<void> {
    const parsed = parseStoredCredentials(credentials)
    if (parsed === undefined) throw new WechatConnectionError('LOGIN_PROTOCOL_ERROR', '微信登录凭据无效')
    await this.writeEmptyContextTokens()
    const config = await this.loadModule('config.js')
    const saveCredentials = getFunction(config, 'saveCredentials')
    await saveCredentials(parsed)
  }

  async clearCredentials(): Promise<void> {
    await this.writeEmptyContextTokens()
    const config = await this.loadModule('config.js')
    const clearCredentials = getFunction(config, 'clearCredentials')
    await clearCredentials()
  }

  async clearLegacyPendingLogin(): Promise<void> {
    try {
      await unlink(join(this.dataDirectory, 'pending_qrcode.json'))
    } catch (error) {
      if (!isNodeError(error, 'ENOENT')) throw error
    }
  }

  private async loadModule(relativePath: string): Promise<Record<string, unknown>> {
    if (this.options.clawbotIndex.trim().length === 0) {
      throw new WechatConnectionError('UNSUPPORTED', 'ClawBot 微信组件不可用')
    }
    const value = await this.importModule(pathToFileURL(join(dirname(this.options.clawbotIndex), relativePath)).href)
    if (!isPlainObject(value)) throw new TypeError(`ClawBot module ${relativePath} has invalid exports`)
    return value
  }

  private async writeEmptyContextTokens(): Promise<void> {
    await mkdir(this.dataDirectory, { recursive: true, mode: 0o700 })
    const target = join(this.dataDirectory, 'context_tokens.json')
    const temporary = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(temporary, '{}\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
      try {
        await rename(temporary, target)
      } catch {
        // Windows may reject rename-over-existing; the direct fallback still
        // guarantees that stale routing tokens are gone before credentials change.
        await writeFile(target, '{}\n', { encoding: 'utf8', mode: 0o600 })
      }
    } finally {
      await unlink(temporary).catch(() => undefined)
    }
  }
}

function getFunction(record: Record<string, unknown>, key: string): (...args: unknown[]) => Promise<unknown> | unknown {
  const value = record[key]
  if (typeof value !== 'function') throw new TypeError(`ClawBot module is missing ${key}`)
  return value as (...args: unknown[]) => Promise<unknown> | unknown
}

function parseConfirmedCredentials(value: Record<string, unknown>): ClawbotCredentials | undefined {
  return parseStoredCredentials({
    botToken: value.bot_token,
    baseUrl: value.baseurl ?? WECHAT_ILINK_ORIGIN,
    ilinkBotId: value.ilink_bot_id,
    ilinkUserId: value.ilink_user_id,
  })
}

function parseStoredCredentials(value: unknown): ClawbotCredentials | undefined {
  if (!isPlainObject(value)) return undefined
  const botToken = boundedString(value.botToken, 4_096)
  const ilinkBotId = boundedString(value.ilinkBotId, 512)
  const ilinkUserId = boundedString(value.ilinkUserId, 512)
  const baseUrl = normalizeBaseUrl(value.baseUrl)
  if (botToken === undefined || ilinkBotId === undefined || ilinkUserId === undefined || baseUrl === undefined) {
    return undefined
  }
  return { botToken, baseUrl, ilinkBotId, ilinkUserId }
}

function normalizeBaseUrl(value: unknown): string | undefined {
  const raw = boundedString(value, 2_048)
  if (raw === undefined) return undefined
  try {
    const url = new URL(raw)
    if (url.origin !== WECHAT_ILINK_ORIGIN || (url.pathname !== '/' && url.pathname !== '')) return undefined
    if (url.username || url.password || url.search || url.hash) return undefined
    return WECHAT_ILINK_ORIGIN
  } catch {
    return undefined
  }
}

function boundedString(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text.length > 0 && text.length <= maximumLength ? text : undefined
}

function assertBoundedString(value: unknown, name: string, maximumLength: number): asserts value is string {
  if (boundedString(value, maximumLength) === undefined) {
    throw new WechatConnectionError('LOGIN_PROTOCOL_ERROR', `${name} 无效`)
  }
}

function maskIdentifier(value: string): string {
  if (value.length <= 8) return '***'
  return `${value.slice(0, 4)}***${value.slice(-4)}`
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (!isPlainObject(value)) return false
  return Object.keys(value).every(key => key !== '__proto__' && key !== 'prototype' && key !== 'constructor')
    && Object.values(value).every(entry => typeof entry === 'string')
}

type JsonReadResult = { kind: 'missing' } | { kind: 'invalid' } | { kind: 'value'; value: unknown }

async function readBoundedJson(path: string, maximumBytes: number): Promise<JsonReadResult> {
  let buffer: Buffer
  try {
    buffer = await readFile(path)
  } catch (error) {
    return isNodeError(error, 'ENOENT') ? { kind: 'missing' } : { kind: 'invalid' }
  }
  if (buffer.byteLength > maximumBytes) return { kind: 'invalid' }
  try {
    return { kind: 'value', value: JSON.parse(buffer.toString('utf8')) }
  } catch {
    return { kind: 'invalid' }
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
