import { mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  ClawbotWechatSender,
  readWechatMessage,
  type WechatCommandInvocation,
} from '../src/sender.ts'

const tempDirs: string[] = []

function temporaryParent(): string {
  const path = mkdtempSync(join(tmpdir(), 'wechat-notify-test-'))
  tempDirs.push(path)
  return path
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true })
})

describe('ClawbotWechatSender', () => {
  it('sends the exact UTF-8 file asynchronously and cleans its private directory', async () => {
    const parent = temporaryParent()
    let invocation: WechatCommandInvocation | undefined
    const sender = new ClawbotWechatSender({
      clawbotIndex: 'C:/clawbot/dist/index.js',
      tempDirectory: parent,
      run: async (value) => {
        invocation = value
        expect(await readWechatMessage(value)).toBe('峰谷边界提醒')
      },
    })

    await expect(sender.send('峰谷边界提醒')).resolves.toEqual({ ok: true })
    expect(invocation?.args.slice(0, 3)).toEqual(['C:/clawbot/dist/index.js', 'send', '--file'])
    expect(readdirSync(parent)).toEqual([])
  })

  it('maps an expired context to activation-required and cleans temporary data', async () => {
    const parent = temporaryParent()
    const sender = new ClawbotWechatSender({
      clawbotIndex: 'C:/clawbot/dist/index.js',
      tempDirectory: parent,
      run: async () => { throw Object.assign(new Error('failed'), { stderr: 'prepare failed: context_token expired' }) },
    })
    await expect(sender.send('test')).resolves.toMatchObject({ ok: false, code: 'activation-required' })
    expect(readdirSync(parent)).toEqual([])
  })

  it('maps generic command errors to send-failed', async () => {
    const sender = new ClawbotWechatSender({
      clawbotIndex: 'C:/clawbot/dist/index.js',
      tempDirectory: temporaryParent(),
      run: async () => { throw new Error('network unavailable') },
    })
    await expect(sender.send('test')).resolves.toMatchObject({
      ok: false, code: 'send-failed', detail: 'network unavailable',
    })
  })

  it('fails soft on an empty CLI path without creating files or starting a process', async () => {
    const parent = temporaryParent()
    const run = vi.fn()
    const sender = new ClawbotWechatSender({ clawbotIndex: '   ', tempDirectory: parent, run })

    await expect(sender.send('test')).resolves.toEqual({
      ok: false, code: 'send-failed', detail: '未配置 WECHAT_NOTIFY_CLAWBOT_INDEX',
    })
    expect(run).not.toHaveBeenCalled()
    expect(readdirSync(parent)).toEqual([])
  })

  it('scrubs ambient credential-shaped variables while preserving ordinary environment', async () => {
    vi.stubEnv('M3_TEST_API_TOKEN', 'secret')
    vi.stubEnv('M3_TEST_ORDINARY', 'kept')
    let environment: NodeJS.ProcessEnv | undefined
    const sender = new ClawbotWechatSender({
      clawbotIndex: 'C:/clawbot/dist/index.js',
      tempDirectory: temporaryParent(),
      run: async (invocation) => { environment = invocation.env },
    })
    await sender.send('test')
    expect(environment?.M3_TEST_API_TOKEN).toBeUndefined()
    expect(environment?.M3_TEST_ORDINARY).toBe('kept')
  })
})
