# 本版修复（BUGFIX）· 4.2.9 → 4.2.10

## 标题

Windows 形状的 argv 路径被宿主平台 `path.isAbsolute` 误判：桌面宿主 profile
识别失效、自更新安装抛「无法定位当前 DSH CLI 入口」——上游自带
`update.spec.ts` 在 POSIX 上 3 条基线失败。

## 现象

在 Linux（POSIX）上运行上游测试套件，`plugins/dsh-token-monitor/tests/update.spec.ts`
有 3 条用例确定性失败（与负载无关，隔离单跑可复现）：

1. `recognizes the desktop host positional profile directory only`：
   `inferRunningProfile([... 'C:/Users/x/.dsh/profiles/desktop' ...])` 期望
   `'desktop'`，实际 `undefined`。
2. `installs through the desktop CLI shim in Node mode`：
   `resolveInstallInvocation(...)` 直接抛 `Error: 无法定位当前 DSH CLI 入口`。
3. `keeps the CLI-launched install invocation unchanged`：同一抛错。

这三条用例的夹具都在模拟 **Windows 桌面宿主** 的 argv（条目形如
`.../@deepseek-ai/dsh-desktop-host/lib/index.js`、profile 目录形如
`.../.dsh/profiles/desktop`），在 Windows 上运行时全绿，换到 POSIX 必挂。

## 证据链

- 基线（上游 HEAD `7f739ef8aae7e5d80b7e4a5ad4957d1a704420a3`，Node v24.20.0）：
  `npx vitest run plugins/dsh-token-monitor/tests/update.spec.ts`
  → `Tests 3 failed | 13 passed (16)`，失败输出含
  `AssertionError: expected undefined to be 'desktop'` 与
  `Error: 无法定位当前 DSH CLI 入口 ❯ resolveInstallInvocation update.ts:234`。
- `git stash` 回退本版改动后复跑同一命令，结果仍为 3 failed / 13 passed，
  证明失败来自上游基线而非本版改动或环境差异。

## 根因

`plugins/dsh-token-monitor/src/update.ts` 里两处入口都先用 **宿主平台** 的
`path.isAbsolute` 把关：

- `profileFromDirectory()`（约 176 行）：`if (!path.isAbsolute(value)) return undefined`；
- `resolveInstallInvocation()`（约 234 行）：`if (cliEntry === undefined || !path.isAbsolute(cliEntry)) throw ...`。

但同一文件的后续逻辑明确是按「路径形状与运行平台无关」设计的：
`profileFromDirectory` 紧接着 `value.replaceAll('\\', '/').split('/')` 归一化
反斜杠，`DESKTOP_HOST_ENTRY` 正则写作 `/[\\/]dsh-desktop-host[\\/]lib[\\/]index\.js$/`
同时接受两种分隔符。唯独最前面的 `isAbsolute` 把关没有跟上：POSIX 的
`path.isAbsolute('C:/...')` 与 `path.isAbsolute('C:\\...')` 均为 `false`，
于是 Windows 桌面宿主的位置参数与 CLI 入口在 POSIX 进程中被整段误杀——
profile 识别返回 `undefined`（自更新随之以「无法可靠识别 profile」中止），
安装入口识别则直接抛错。

## 改动

仅 `plugins/dsh-token-monitor/src/update.ts`（+11/−2）：

- 新增内部 helper `isAbsolutePath(value)`：
  `path.isAbsolute(value) || path.win32.isAbsolute(value)`，并附注释说明
  argv 路径按来源宿主的平台形状出现；
- `profileFromDirectory` 与 `resolveInstallInvocation` 两处把关改用该 helper；
  其余判定（`profiles/` 段校验、`PROFILE_NAME`、桌面条目正则、loader 参数
  转发等）一字未动，Windows 本机行为与原版完全一致。

另按 fork 集成口径同步：根 `package.json` 版本 `4.2.9 → 4.2.10`
（`CURRENT_RELEASE_VERSION` 在 `update.ts` 中由 `packageJson.version` 派生，
版本契约自动同步，无其他版本戳需改）、`repository.url` 改指落点仓
`https://github.com/lhg-dsh-plugins/lhg-dsh-damage-pulse`；README 顶部
追加 fork 说明头，原文未删；`LICENSE` 原样保留。

## 复验结果

- `npx vitest run plugins/dsh-token-monitor/tests/update.spec.ts`：
  修复前 3 failed / 13 passed → 修复后 **16/16 passed**。
- `npx vitest run plugins/dsh-token-monitor/tests`（全目录）：
  **434 passed**，剩余 10 条失败全部位于 `billing-tools-composition.spec.ts`，
  与基线逐条一致（见下方边界），无新增失败。
- `pnpm typecheck` 通过；`pnpm build` 通过，且重建后的 `lib/index.js` 与
  上游 HEAD 逐字节一致——`update.ts` 属于打包时生成的模块化载荷
  （`runtime/`），本就不进根 `lib/` 捆绑，源码修复即完整修复。

## 验证边界（如实记录）

以下均为基线既有问题，与本修复无关，本版未处理：

- 干净克隆下根 `node --test tests/*.test.ts` 有 5 个文件
  `ERR_MODULE_NOT_FOUND`：`packages/util/token-monitor-contract` 的 `lib/`
  未入库且仓库内无任何脚本生成它（其 `package.json` 的 `main`/`exports`
  指向 `lib/index.js`）。手动以其 tsconfig 同等参数编译出 `lib/` 后，这
  5 个文件与 vitest 其余套件均可运行。
- `billing-tools-composition.spec.ts` 的 10 条用例依赖打包生成的
  `runtime/` 发布载荷（或 `DSH_TOKEN_MONITOR_RELEASE` 环境变量指定），
  干净检出缺失时以 `ENOENT: lstat '.../runtime'` 失败；
  `pnpm check:bundle` 同因 `runtime/host/manager.mjs` 缺失失败——修复
  前后输出逐字节一致。
- `packages/client/ui-token-monitor` 的个别 jsdom 用例在本沙箱高并行负载
  下出现过两次基线运行不一致的超时/断言抖动（`details.client.spec.tsx`、
  `settings-panel.client.spec.tsx` 各一次），文件与本改动无交集，未作为
  立案或回归依据。
- 上游 open issue 为 0 条，本 bug 由上游自带测试的基线失败立案；
  同平台生产环境（Windows 宿主进程跑 Windows 形状 argv）原行为正确，
  本修复改变的仅是跨平台形状识别，与测试夹具编码的契约一致。
