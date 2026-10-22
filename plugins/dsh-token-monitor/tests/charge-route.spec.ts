import { describe, expect, it } from 'vitest'
import { createChargeEventsRouteHandler } from '../src/charge-route.ts'

function response() {
  return { status: 0, headers: {} as Record<string, string>, body: '', writeHead(status: number, headers: Record<string, string>) { this.status = status; this.headers = headers }, end(value?: string) { this.body = value ?? '' } }
}

describe('charge events route', () => {
  it('rejects malformed since values', () => {
    for (const since of ['abc', '-1', '1.5', '01', '9007199254740992']) {
      const res = response()
      createChargeEventsRouteHandler(() => ({ streamId: 's', seq: 0, firstSeq: 1, dropped: false, events: [] }))({ method: 'GET', url: `/api/token-monitor/charge-events?since=${since}` } as any, res as any)
      expect(res.status, since).toBe(400)
    }
  })

  it('returns stream metadata and detects a ring-buffer gap', () => {
    const res = response()
    createChargeEventsRouteHandler(() => ({ streamId: 's', seq: 8, firstSeq: 5, dropped: true, events: [] }))({ method: 'GET', url: '?since=1' } as any, res as any)
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ streamId: 's', seq: 8, firstSeq: 5, dropped: true })
  })
})
