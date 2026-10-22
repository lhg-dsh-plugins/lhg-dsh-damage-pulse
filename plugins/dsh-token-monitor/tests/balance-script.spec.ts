import { describe, expect, it } from 'vitest'
import { evaluateBalanceScript, validateBalanceRequest, validateScriptBalance, OFFICIAL_BALANCE_SCRIPT } from '../src/balance-script.ts'
import { publicBalanceAddress } from '../src/balance-network.ts'

describe('isolated balance scripts', () => {
  it('extracts a request and parses decimal balances without providing any credential', async () => {
    expect(validateBalanceRequest(await evaluateBalanceScript(OFFICIAL_BALANCE_SCRIPT))).toEqual({
      path: '/user/balance', method: 'GET', auth: 'bearer',
    })
    expect(validateScriptBalance(await evaluateBalanceScript(OFFICIAL_BALANCE_SCRIPT, { balance_infos: [{ currency: 'CNY', total_balance: '12.50', granted_balance: '2', topped_up_balance: '10.50' }] }))).toMatchObject({ currency: 'CNY', totalBalance: 12.5 })
  })
  it('bounds CPU and memory and exposes no Host escape globals', async () => {
    await expect(evaluateBalanceScript('(() => { while (true) {} })()')).rejects.toThrow()
    await expect(evaluateBalanceScript('(() => { const a=[]; while(true) a.push(new Array(10000).fill(1)); })()')).rejects.toThrow()
    for (const name of ['process', 'require', 'fetch']) {
      await expect(evaluateBalanceScript(`({ request: ${name}, parse() {} })`)).rejects.toThrow()
    }
    expect(await evaluateBalanceScript('({ request: typeof process, parse() {} })')).toBe('undefined')
  })
  it('rejects unsafe destinations, extra headers, malformed amounts and preserves credits', () => {
    for (const path of ['http://a.example/b', '//a.example/b', '/b?key=x', '/b#fragment', '/b\\next']) {
      expect(() => validateBalanceRequest({ path, method: 'GET', auth: 'bearer' })).toThrow()
    }
    expect(() => validateBalanceRequest({ path: '/b', method: 'GET', auth: 'bearer', headers: {} })).toThrow()
    for (const totalBalance of ['', null, 'NaN', '1e6', Infinity]) expect(() => validateScriptBalance({ currency: 'CNY', totalBalance })).toThrow()
    expect(validateScriptBalance({ currency: 'credits', totalBalance: '-0.5' })).toMatchObject({ currency: 'credits', totalBalance: -0.5 })
  })
  it('rejects local, reserved, metadata and IPv4-mapped private addresses', () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '169.254.169.254', '192.168.1.1', '100.64.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1', '198.18.0.1']) expect(publicBalanceAddress(address), address).toBe(false)
    expect(publicBalanceAddress('1.1.1.1')).toBe(true)
    expect(publicBalanceAddress('2606:4700:4700::1111')).toBe(true)
  })
  it('accepts flexible window shapes: remaining, percent, decimal strings, ISO resetAt and auto labels', () => {
    expect(validateScriptBalance({ windows: [
      { label: '5h', remaining: 165, total: 2000 },
      { used: '300', total: '1000', resetAt: '2026-10-24T08:35:03Z' },
      { percent: 40, total: 500 },
      { percent: '25', total: '400', label: 'w4', extra: 'metadata' },
    ] })).toMatchObject({
      currency: 'credits',
      totalBalance: 165,
      windows: [
        { label: '5h', used: 1835, total: 2000 },
        { label: 'Window 2', used: 300, total: 1000, resetAt: Date.parse('2026-10-24T08:35:03Z') },
        { label: 'Window 3', used: 200, total: 500 },
        { label: 'w4', used: 100, total: 400 },
      ],
    })
    expect(validateScriptBalance({ windows: [{ used: 1, total: 2 }] })).toMatchObject({ currency: 'credits', totalBalance: 1, windows: [{ label: 'Window 1', used: 1, total: 2 }] })
    for (const bad of [
      { remaining: 1 },
      { used: -1, total: 2 },
      { percent: 120, total: 2 },
      { used: 1 },
      { resetAt: 'not-a-date', used: 1, total: 2 },
      { label: 'x'.repeat(17), used: 1, total: 2 },
    ]) expect(() => validateScriptBalance({ windows: [bad] })).toThrow()
    expect(() => validateScriptBalance({ windows: Array.from({ length: 9 }, () => ({ used: 1, total: 2 })) })).toThrow()
  })
  it('passes a trimmed generic display string through and keeps numeric fields intact', () => {
    expect(validateScriptBalance({ currency: 'credits', totalBalance: 73.95, display: '  5h·73% / 7d·95%  ' })).toMatchObject({
      currency: 'credits', totalBalance: 73.95, display: '5h·73% / 7d·95%',
    })
    expect(validateScriptBalance({ currency: 'CNY', totalBalance: 5, display: '   ' }).display).toBeUndefined()
    expect(validateScriptBalance({ currency: 'CNY', totalBalance: 5, display: 123 }).display).toBeUndefined()
    const capped = validateScriptBalance({ currency: 'credits', totalBalance: 1, display: 'x'.repeat(80) })
    expect(capped.display!.length).toBe(48)
  })
})
