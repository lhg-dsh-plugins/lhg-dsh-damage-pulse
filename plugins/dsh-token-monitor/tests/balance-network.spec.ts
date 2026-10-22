import { EventEmitter } from 'node:events'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { lookup } from 'node:dns/promises'
import { request } from 'node:https'
import { BalanceNetworkError, fakeIpBalanceAddress, publicBalanceAddress, requestBalanceJson } from '../src/balance-network.ts'

vi.mock('node:dns/promises', () => ({ lookup: vi.fn() }))
vi.mock('node:https', () => ({ request: vi.fn() }))
const descriptor = { path: '/balance', method: 'GET' as const, auth: 'bearer' as const }
let status: number, chunks: Buffer[], headers: Record<string, string>
let options: Record<string, unknown>, destination: URL
let response: EventEmitter & { statusCode: number; headers: Record<string, string>; destroy: ReturnType<typeof vi.fn> }

beforeEach(() => {
  status = 200; chunks = [Buffer.from('{"total":12}')]; headers = {}
  vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }] as never)
  vi.mocked(request).mockImplementation(((url: URL, config: Record<string, unknown>, callback: (value: unknown) => void) => {
    destination = url; options = config
    response = Object.assign(new EventEmitter(), { statusCode: status, headers, destroy: vi.fn() })
    const req = Object.assign(new EventEmitter(), { end: () => {
      callback(response)
      if (response.destroy.mock.calls.length) return
      for (const chunk of chunks) response.emit('data', chunk)
      response.emit('end')
    } })
    return req
  }) as never)
})
afterEach(() => { vi.resetAllMocks() })

type PinnedLookup = (host: string, opts: { all: boolean }, cb: (...values: unknown[]) => void) => void

/** Read the pinned answer the way node does, and prove it is never handed over synchronously. */
const readPin = async (opts: { all: boolean }) => {
  const callback = vi.fn()
  ;(options.lookup as PinnedLookup)('balance.example', opts, callback)
  expect(callback).not.toHaveBeenCalled()
  await new Promise(resolve => setImmediate(resolve))
  return callback
}

it.each(['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '100.64.0.1'])('rejects non-public address %s', address => {
  expect(publicBalanceAddress(address)).toBe(false)
})

it('rejects mixed public/private DNS answers before credentials are attached', async () => {
  vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] as never)
  await expect(requestBalanceJson(descriptor, 'https://balance.example', 'test-key', new AbortController().signal)).rejects.toThrow('public')
  expect(request).not.toHaveBeenCalled()
})

it('pins the checked address while keeping the original TLS hostname and bounded signal', async () => {
  expect(await requestBalanceJson(descriptor, 'https://balance.example', 'test-key', new AbortController().signal)).toEqual({ total: 12 })
  expect(destination.hostname).toBe('balance.example')
  expect(options.agent).toBe(false)
  expect(options.signal).toBeInstanceOf(AbortSignal)
  expect(options.headers).toMatchObject({ Authorization: 'Bearer test-key', 'Accept-Encoding': 'identity' })
  expect(await readPin({ all: false })).toHaveBeenLastCalledWith(null, '8.8.8.8', 4)
  expect(await readPin({ all: true })).toHaveBeenLastCalledWith(null, [{ address: '8.8.8.8', family: 4 }])
})

it('rejects redirects without forwarding credentials to the new destination', async () => {
  status = 302; headers = { location: 'https://other.example/' }
  await expect(requestBalanceJson(descriptor, 'https://balance.example', 'test-key', new AbortController().signal)).rejects.toThrow('302')
  expect(request).toHaveBeenCalledOnce()
  expect(response.destroy).toHaveBeenCalled()
})

it('limits response bytes and rejects compressed or malformed data', async () => {
  chunks = [Buffer.alloc(262145)]
  await expect(requestBalanceJson(descriptor, 'https://balance.example', 'test-key', new AbortController().signal)).rejects.toThrow('256 KiB')
  headers = { 'content-encoding': 'gzip' }
  await expect(requestBalanceJson(descriptor, 'https://balance.example', 'test-key', new AbortController().signal)).rejects.toThrow('Compressed')
  headers = {}; chunks = [Buffer.from('not JSON')]
  await expect(requestBalanceJson(descriptor, 'https://balance.example', 'test-key', new AbortController().signal)).rejects.toThrow('not JSON')
})

it('cancels while DNS is unresolved without starting a request', async () => {
  vi.mocked(lookup).mockReturnValue(new Promise(() => {}))
  const controller = new AbortController()
  const pending = requestBalanceJson(descriptor, 'https://balance.example', 'test-key', controller.signal)
  controller.abort()
  await expect(pending).rejects.toThrow('cancelled')
  expect(request).not.toHaveBeenCalled()
})

it('categorises only the native IPv4 Fake-IP range as an automatic candidate', () => {
  for (const address of ['198.18.0.1', '198.18.0.108', '198.19.255.255']) expect(fakeIpBalanceAddress(address), address).toBe(true)
  for (const address of ['198.17.255.255', '198.20.0.0', '8.8.8.8', '10.0.0.1', '::ffff:198.18.0.1', '2001:db8::1', 'fe80::1', 'not-an-ip']) expect(fakeIpBalanceAddress(address), address).toBe(false)
})

it('accepts a domain answered with the TUN Fake-IP range and still pins that exact address', async () => {
  vi.mocked(lookup).mockResolvedValue([{ address: '198.18.0.108', family: 4 }] as never)
  expect(await requestBalanceJson(descriptor, 'https://balance.example', 'test-key', new AbortController().signal)).toEqual({ total: 12 })
  expect(destination.hostname).toBe('balance.example')
  expect(await readPin({ all: false })).toHaveBeenLastCalledWith(null, '198.18.0.108', 4)
})

it('keeps the first checked record when public and Fake-IP answers are mixed', async () => {
  vi.mocked(lookup).mockResolvedValue([{ address: '8.8.8.8', family: 4 }, { address: '198.18.0.108', family: 4 }] as never)
  expect(await requestBalanceJson(descriptor, 'https://balance.example', 'test-key', new AbortController().signal)).toEqual({ total: 12 })
  expect(await readPin({ all: false })).toHaveBeenLastCalledWith(null, '8.8.8.8', 4)
})

it('keeps a connect failure that escapes at socket level inside the promise', async () => {
  let pendingRequest: EventEmitter | undefined
  const socket = new EventEmitter()
  vi.mocked(request).mockImplementation(((url: URL, config: Record<string, unknown>) => {
    destination = url; options = config
    const req = Object.assign(new EventEmitter(), { end: () => {} })
    pendingRequest = req
    // The host wires its request listeners before the first socket exists, so the socket reaches
    // the plugin through the request's own 'socket' event.
    setImmediate(() => { req.emit('socket', socket) })
    return req
  }) as never)
  const outcome = requestBalanceJson(descriptor, 'https://balance.example', 'test-key', new AbortController().signal).catch(error => error as Error)
  for (let tick = 0; tick < 3; tick += 1) await new Promise(resolve => setImmediate(resolve))
  expect(socket.listenerCount('error')).toBeGreaterThan(0)
  // Node destroys the socket and emits this without it ever reaching the request; an unhandled
  // 'error' event here ended the host process instead of failing this one query.
  const connectFailure = Object.assign(new Error('connect EADDRNOTAVAIL'), { code: 'EADDRNOTAVAIL' })
  expect(() => socket.emit('error', connectFailure)).not.toThrow()
  pendingRequest!.emit('error', connectFailure)
  expect((await outcome).message).toBe('Balance network request failed or timed out')
})

it('refuses Fake-IP answers for a literal address target and for mapped or non-native forms', async () => {
  vi.mocked(lookup).mockResolvedValue([{ address: '198.18.0.108', family: 4 }] as never)
  await expect(requestBalanceJson(descriptor, 'https://198.18.0.9', 'test-key', new AbortController().signal)).rejects.toBeInstanceOf(BalanceNetworkError)
  expect(request).not.toHaveBeenCalled()
  vi.mocked(lookup).mockResolvedValue([{ address: '::ffff:198.18.0.1', family: 6 }] as never)
  await expect(requestBalanceJson(descriptor, 'https://balance.example', 'test-key', new AbortController().signal)).rejects.toBeInstanceOf(BalanceNetworkError)
  expect(request).not.toHaveBeenCalled()
})

it('surfaces a bounded upstream wait for 429 without shortening it to the default interval', async () => {
  status = 429; headers = { 'retry-after': '30' }
  const failure = await requestBalanceJson(descriptor, 'https://balance.example', 'test-key', new AbortController().signal).catch(error => error as BalanceNetworkError)
  expect(failure).toBeInstanceOf(BalanceNetworkError)
  expect(failure.kind).toBe('rate-limited')
  expect(failure.retryAfterMs).toBe(30_000)
  expect(response.destroy).toHaveBeenCalled()
})
