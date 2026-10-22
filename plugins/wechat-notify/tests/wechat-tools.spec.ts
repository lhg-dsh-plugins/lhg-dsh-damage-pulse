import { describe, expect, it, vi } from "vitest"
import type { Context } from "@deepseek-ai/cordis"
import type { ToolDefinition } from "@deepseek-ai/dsh-tools"
import { WechatConnectionError } from "../src/connection.ts"
import { createWechatTools, registerWechatTools, type WechatToolEnvironment } from "../src/tools.ts"

function fakeExec(): never {
  return { callId: "test-call", name: "wechat_test", arguments: {}, signal: new AbortController().signal } as never
}

async function run(tool: ToolDefinition, args: unknown): Promise<string> {
  return await tool.execute(args, fakeExec()) as string
}

function makeEnv(overrides: Partial<WechatToolEnvironment> = {}): WechatToolEnvironment {
  return {
    notify: { send: vi.fn() },
    connection: { login: vi.fn(), confirmLogin: vi.fn() },
    ...overrides,
  }
}

describe("createWechatTools", () => {
  it("defines exactly the three wechat tools with string canonical outputs", () => {
    const tools = createWechatTools(makeEnv())
    expect(tools.map((tool) => tool.name)).toEqual(["wechat_notify", "wechat_login", "wechat_login_confirm"])
    for (const tool of tools) expect((tool.output.schema as { type: string }).type).toBe("string")
    expect(tools[0].description).toContain("ClawBot 微信通道")
    expect(tools[2].description).toContain("扫码登录")
  })

  it("wechat_notify reports success and failure details from the send service", async () => {
    const send = vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, code: "activation-required", detail: "context token expired" })
      .mockResolvedValueOnce({ ok: false, code: "send-failed", detail: "boom" })
    const [notifyTool] = createWechatTools({ notify: { send }, connection: undefined })
    expect(await run(notifyTool, { message: "你好" })).toBe("微信通知已发送：你好")
    expect(await run(notifyTool, { message: "x" })).toContain("激活")
    expect(await run(notifyTool, { message: "x" })).toContain("boom")
    expect(send).toHaveBeenCalledTimes(3)
    expect(send).toHaveBeenCalledWith("你好")
  })

  it("wechat_notify fails soft when the notify service is unavailable", async () => {
    const [notifyTool] = createWechatTools({ notify: undefined, connection: undefined })
    const value = await run(notifyTool, { message: "hi" })
    expect(value).toContain("微信通道未配置")
    expect(value).toContain("WECHAT_NOTIFY_CLAWBOT_INDEX")
  })

  it("wechat_login returns sessionId and qr payload from the connection service", async () => {
    const login = vi.fn().mockResolvedValue({
      login: { sessionId: "sess-1", expiresAt: Date.now() + 5 * 60_000, qrPayload: "data:image/svg+xml;base64,abc" },
      status: {},
    })
    const [, loginTool] = createWechatTools({ notify: undefined, connection: { login, confirmLogin: vi.fn() } })
    const value = await run(loginTool, {})
    expect(login).toHaveBeenCalledTimes(1)
    expect(value).toContain("sess-1")
    expect(value).toContain("data:image/svg+xml;base64,abc")
  })

  it("wechat_login reports unsupported and generic failures without throwing", async () => {
    const login = vi.fn().mockRejectedValueOnce(new WechatConnectionError("UNSUPPORTED", "no clawbot"))
      .mockRejectedValueOnce(new Error("network down"))
    const [, loginTool] = createWechatTools({ notify: undefined, connection: { login, confirmLogin: vi.fn() } })
    expect(await run(loginTool, {})).toContain("WECHAT_NOTIFY_CLAWBOT_INDEX")
    expect(await run(loginTool, {})).toContain("获取微信登录二维码失败")
  })

  it("wechat_login_confirm maps every confirmation phase", async () => {
    const confirmLogin = vi.fn()
      .mockResolvedValueOnce({ result: "waiting", status: {} })
      .mockResolvedValueOnce({ result: "scanned", status: {} })
      .mockResolvedValueOnce({ result: "confirmed", status: {} })
      .mockResolvedValueOnce({ result: "expired", status: {} })
    const [,, confirmTool] = createWechatTools({ notify: undefined, connection: { login: vi.fn(), confirmLogin } })
    expect(await run(confirmTool, { sessionId: "s1" })).toContain("尚未检测到扫码")
    expect(await run(confirmTool, { sessionId: "s1" })).toContain("请在手机上确认登录")
    expect(await run(confirmTool, { sessionId: "s1" })).toContain("登录成功")
    expect(await run(confirmTool, { sessionId: "s1" })).toContain("二维码已过期")
    expect(confirmLogin).toHaveBeenCalledWith("s1")
  })

  it("wechat_login_confirm reports missing session without throwing", async () => {
    const confirmLogin = vi.fn().mockRejectedValue(new WechatConnectionError("LOGIN_SESSION_NOT_FOUND", "no session"))
    const [,, confirmTool] = createWechatTools({ notify: undefined, connection: { login: vi.fn(), confirmLogin } })
    expect(await run(confirmTool, { sessionId: "zz" })).toContain("会话不存在")
  })
})

describe("registerWechatTools", () => {
  it("registers the three tools when the tools service is present", () => {
    const registered: string[] = []
    const services = { notify: { send: vi.fn() }, connection: { login: vi.fn(), confirmLogin: vi.fn() } }
    const ctx = {
      inject(_deps: string[], callback: (scoped: unknown) => void): void {
        callback({ tools: { register: (tool: { name: string }) => registered.push(tool.name) } })
      },
      get(key: string, safe?: boolean): unknown {
        if (key === "wechatNotify") return services.notify
        if (key === "wechatConnection") return services.connection
        return undefined
      },
    } as unknown as Context
    registerWechatTools(ctx)
    expect(registered).toEqual(["wechat_notify", "wechat_login", "wechat_login_confirm"])
  })

  it("fails soft when inject resolves without a tools registry", () => {
    let invoked = 0
    const ctx = {
      inject(_deps: string[], callback: (scoped: unknown) => void): void {
        invoked += 1
        callback({})
      },
    } as unknown as Context
    expect(() => registerWechatTools(ctx)).not.toThrow()
    expect(invoked).toBe(1)
  })

  it("fails soft when the tools service never appears", () => {
    const ctx = { inject: vi.fn() } as unknown as Context
    expect(() => registerWechatTools(ctx)).not.toThrow()
    expect(ctx.inject).toHaveBeenCalledWith(["tools"], expect.any(Function))
  })
})
