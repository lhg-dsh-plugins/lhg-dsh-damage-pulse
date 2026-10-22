import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createWechatConnectionApi,
  WechatConnectionProtocolError,
} from '../src/client/wechatConnectionApi.ts'

const status = {
  schemaVersion: 1, provider: 'clawbot-wechat', availability: 'available', auth: 'authenticated',
  process: 'external', delivery: 'needs-activation', operation: 'idle',
  capabilities: { canLogin: true, canReconnect: false, canDisconnect: false },
  identity: { maskedUserId: 'wech***5678' }, checkedAt: 1,
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('wechat connection client API', () => {
  it('calls all six endpoint operations with no-store and explicit JSON confirmation', async () => {
    const responses = [
      status,
      { login: { sessionId: 'session-1', expiresAt: 2, qrPayload: 'qr-payload' }, status: { ...status, auth: 'pending' } },
      { result: 'waiting', status: { ...status, auth: 'pending' } },
      status,
      status,
      { ok: true },
    ]
    const fetcher = vi.fn().mockImplementation(async () => new Response(JSON.stringify(responses.shift()), { status: 200 }))
    const api = createWechatConnectionApi(fetcher)
    const signal = new AbortController().signal

    await api.status(signal)
    await api.login(signal)
    await api.confirmLogin('session-1', signal)
    await api.reconnect(signal)
    await api.disconnect(signal)
    await api.testMessage('测试消息', signal)

    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/token-monitor/wechat/status', { cache: 'no-store', signal })
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/token-monitor/wechat/login', { method: 'POST', cache: 'no-store', signal })
    expect(fetcher).toHaveBeenNthCalledWith(3, '/api/token-monitor/wechat/login/confirm', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"sessionId":"session-1"}', cache: 'no-store', signal,
    })
    expect(fetcher).toHaveBeenNthCalledWith(4, '/api/token-monitor/wechat/reconnect', { method: 'POST', cache: 'no-store', signal })
    expect(fetcher).toHaveBeenNthCalledWith(5, '/api/token-monitor/wechat/disconnect', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"confirm":true}', cache: 'no-store', signal,
    })
    expect(fetcher).toHaveBeenNthCalledWith(6, '/api/token-monitor/wechat/test', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"message":"测试消息"}', cache: 'no-store', signal,
    })
  })

  it('preserves known structured Host errors and maps unknown codes to HTTP_ERROR', async () => {
    const known = createWechatConnectionApi(vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'BRIDGE_NOT_OWNED', message: '微信 bridge 不由 DSH Host 管理' },
    }), { status: 409 })))
    await expect(known.reconnect()).rejects.toMatchObject({ status: 409, code: 'BRIDGE_NOT_OWNED' })

    const unknown = createWechatConnectionApi(vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'TOKEN_EXPOSED', message: 'secret' },
    }), { status: 500 })))
    await expect(unknown.status()).rejects.toMatchObject({ status: 500, code: 'HTTP_ERROR' })
  })

  it('rejects malformed data while ignoring unknown response fields', async () => {
    await expect(createWechatConnectionApi(vi.fn().mockResolvedValue(
      new Response('not-json', { status: 200 }),
    )).status()).rejects.toBeInstanceOf(WechatConnectionProtocolError)

    const parsed = await createWechatConnectionApi(vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...status, connected: true, botToken: 'secret' }), { status: 200 }),
    )).status()
    expect(parsed).not.toHaveProperty('connected')
    expect(parsed).not.toHaveProperty('botToken')

    await expect(createWechatConnectionApi(vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ...status, identity: { maskedUserId: 'full-user-id-87654321' } }), { status: 200 }),
    )).status()).rejects.toBeInstanceOf(WechatConnectionProtocolError)

    await expect(createWechatConnectionApi(vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, detail: 'secret' }), { status: 200 }),
    )).testMessage('hello')).resolves.toEqual({ ok: true })
  })

  it('does not read or write browser storage', async () => {
    const localStorage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }
    const sessionStorage = { getItem: vi.fn(), setItem: vi.fn(), removeItem: vi.fn() }
    vi.stubGlobal('localStorage', localStorage)
    vi.stubGlobal('sessionStorage', sessionStorage)
    const api = createWechatConnectionApi(vi.fn().mockResolvedValue(new Response(JSON.stringify(status), { status: 200 })))

    await api.status()
    expect(localStorage.getItem).not.toHaveBeenCalled()
    expect(localStorage.setItem).not.toHaveBeenCalled()
    expect(sessionStorage.getItem).not.toHaveBeenCalled()
    expect(sessionStorage.setItem).not.toHaveBeenCalled()
  })
})
