import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_TOKEN_MONITOR_SETTINGS } from '../../../util/token-monitor-contract/src/index.ts'
import {
  createTokenMonitorSettingsApi,
  TokenMonitorSettingsProtocolError,
} from '../src/client/settingsApi.ts'

const snapshot = { schemaVersion: 3 as const, revision: 2, settings: { ...DEFAULT_TOKEN_MONITOR_SETTINGS } }

describe('Token Monitor settings client', () => {
  it('loads and patches the dedicated endpoint', async () => {
    const fetcher = vi.fn().mockImplementation(() => Promise.resolve(
      new Response(JSON.stringify(snapshot), { status: 200 }),
    ))
    const api = createTokenMonitorSettingsApi(fetcher)
    await expect(api.get()).resolves.toEqual(snapshot)
    await expect(api.patch({ expectedRevision: 2, patch: { showWhaleGirl: false } })).resolves.toEqual(snapshot)
    expect(fetcher).toHaveBeenNthCalledWith(1, '/api/token-monitor/settings', { cache: 'no-store' })
    expect(fetcher).toHaveBeenNthCalledWith(2, '/api/token-monitor/settings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedRevision: 2, patch: { showWhaleGirl: false } }),
      cache: 'no-store',
    })
  })

  it('preserves structured Host errors', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { code: 'VALIDATION_ERROR', message: 'bad setting', details: { fields: { 'patch.dailyBudgetCny': 'bad' } } },
    }), { status: 400 }))
    const api = createTokenMonitorSettingsApi(fetcher)
    await expect(api.patch({ patch: {} })).rejects.toMatchObject({
      status: 400,
      code: 'VALIDATION_ERROR',
      fields: { 'patch.dailyBudgetCny': 'bad' },
    })
  })

  it('rejects malformed success payloads and invalid JSON', async () => {
    await expect(createTokenMonitorSettingsApi(vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ revision: 1 }), { status: 200 }),
    )).get()).rejects.toBeInstanceOf(TokenMonitorSettingsProtocolError)
    await expect(createTokenMonitorSettingsApi(vi.fn().mockResolvedValue(
      new Response('not-json', { status: 200 }),
    )).get()).rejects.toBeInstanceOf(TokenMonitorSettingsProtocolError)
  })
})
