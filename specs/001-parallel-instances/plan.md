# Implementation Plan: Chrome DevTools MCP 并行多实例支持

**Branch**: `001-parallel-instances` | **Date**: 2026-05-07 | **Spec**: [spec.md](./spec.md)  
**Input**: Feature specification from `/specs/001-parallel-instances/spec.md`

## Summary

把 `playwright-mcp-parallel` 的并行能力迁移到 `chrome-devtools-mcp`：在**本仓库（已 fork）**基础上新增一个并行入口 `chrome-devtools-mcp-parallel`，复用 upstream 的 tool 定义与 handler，在 MCP 层增加实例注册表、`page_*` 派发、管理工具（`browser_connect` / `instance_*`）、CDP 鉴权克隆、连接看门狗、下载隔离、每实例快照增强（仅对 `page_take_snapshot` 生效）、可视角标注入。技术方案不引入 Playwright，底层仍用 Puppeteer；每实例对应一个 `PerInstanceContext`，在 CDP 模式下共享 Browser 但独占一个 `BrowserContext`，在 launch 模式下独占整个 Browser 进程。

## Technical Context

**Language/Version**: TypeScript 6.0.x（与 upstream 一致），编译到 Node.js ESM  
**Primary Dependencies**: Puppeteer 24.43.x（upstream 既有）、`@modelcontextprotocol/sdk` 1.29.0、`yargs` 18、`debug` 4  
**Storage**: 纯内存（实例注册表、全局 AuthState）；下载目录使用 OS 临时目录 `os.tmpdir()/chrome-devtools-mcp-parallel-downloads/<instanceId>/`  
**Testing**: 复用 upstream 的 `scripts/test.mjs`（node --test），在 `tests/` 下新增单元与集成用例；并行相关回归基于 Puppeteer 自带浏览器  
**Target Platform**: Node.js `^20.19.0 || ^22.12.0 || >=23`（与 upstream `engines` 一致）；Chrome / Edge 近似最新稳定版（与 Puppeteer 24 支持范围一致）；OS：Windows / macOS / Linux  
**Project Type**: MCP server + CLI（单仓库、多 bin；TypeScript 库）  
**Performance Goals**: 3 实例并行相对串行提速 ≥40%（SC-001）；`page_take_snapshot` 二次调用输出长度相对首次下降 ≥50%（SC-005）；CDP 断连 10 秒内恢复（SC-004）  
**Constraints**:

- 不修改 upstream 任何现有 `bin/` 行为；所有新增代码放在新目录，保证 `chrome-devtools-mcp` 主入口零影响
- 遵循仓库 TS 规则：不允许 `any`、`as`（除类型保护函数内的必要窄化）、`!` 断言、`@ts-ignore/@ts-nocheck/@ts-expect-error`；循环优先 `for..of`
- 代码仅使用 `package.json` 脚本构建与测试（`npm run build`、`npm run test`、`npm run format`）

**Scale/Scope**:

- 单 MCP 进程最大实例数软上限 10（可 `--max-instances` 配置，默认 10）；超出时 `instance_create` 报错
- 工具派发：upstream 启用的每个工具 → 一个 `page_*` 派生版，管理工具固定 6 个
- 新增源码规模估计 1500–2500 行（核心管理 + 派生 + 鉴权 + 快照增强 + 角标）

## Constitution Check

_GATE: Must pass before Phase 0 research. Re-check after Phase 1 design._

仓库 `.specify/memory/constitution.md` 尚为模板占位符，无具体 core principles。本计划采用仓库实际约束作为硬门禁：

| 门禁                     | 规则来源            | 本计划符合性                                                                                                                                                  |
| ------------------------ | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 不触碰 upstream 默认行为 | Spec FR-021 澄清 Q1 | 所有新增代码隔离在 `src/parallel/` 与新 bin；不修改 `src/bin/chrome-devtools-mcp.ts` / `src/index.ts` 的行为，只 export 必要类型/构造器供并行模式 import 复用 |
| TS 纪律                  | AGENTS.md / FR-025  | 无 `any`/`as`/`!`/`@ts-ignore`；使用窄化函数与泛型；`for..of` 替代 `forEach`                                                                                  |
| 只用 npm scripts         | AGENTS.md           | `npm run build`、`npm run test`、`npm run format`；新增 bin 通过 `package.json` 的 `bin` 字段暴露                                                             |
| 单实例用户零影响         | FR-021 + Q1 答      | 新 bin 独立 `chrome-devtools-mcp-parallel`；现有 bin `chrome-devtools-mcp`、`chrome-devtools` 保持不变                                                        |
| 派生工具行为等价         | FR-009 + SC-003     | 派生工具的 handler 直接委托 upstream 工具 `handler`，只做参数脱壳（去 `instanceId`）与 context 替换；除快照增强外无行为漂移                                   |

**结果**: PASS — 无需违例表。

## Project Structure

### Documentation (this feature)

```text
specs/001-parallel-instances/
├── plan.md              # 本文件
├── spec.md              # /speckit.specify 产出
├── research.md          # Phase 0：关键决策与调研结论
├── data-model.md        # Phase 1：核心数据结构与状态机
├── quickstart.md        # Phase 1：5 分钟上手路径 → 支撑 SC-006
├── contracts/
│   ├── management-tools.md  # 6 个管理工具的完整 JSON Schema 契约
│   └── page-tool-derivation.md  # page_* 派生规则与示例
├── checklists/
│   └── requirements.md  # /speckit.specify 已生成
└── tasks.md             # /speckit.tasks 阶段生成，本阶段不产出
```

### Source Code (repository root)

```text
src/
├── bin/
│   ├── chrome-devtools-mcp.ts          # UPSTREAM 保留，不动
│   ├── chrome-devtools.ts              # UPSTREAM 保留，不动
│   └── chrome-devtools-mcp-parallel.ts # NEW 并行模式 CLI 入口
├── parallel/                            # NEW — 并行模式全部新增代码
│   ├── index.ts                         # createParallelMcpServer()
│   ├── InstanceRegistry.ts              # 实例注册/查找/生命周期
│   ├── PerInstance.ts                   # 每实例上下文：浏览器句柄 + selectedPage + 快照缓存
│   ├── BrowserConnector.ts              # CDP 端口探测 / 自动拉起 / 鉴权抽取
│   ├── AuthState.ts                     # cookies + origins(localStorage) 的全局快照
│   ├── AuthCloner.ts                    # 把 AuthState 注入新 BrowserContext
│   ├── ConnectionWatchdog.ts            # 周期探活 + 有限次重连
│   ├── DownloadManager.ts               # per-instance 下载目录 + CDP Browser.downloadBehavior 绑定
│   ├── SnapshotEnhancer.ts              # 降噪 + diff + [CDP Field States] + [pageState]
│   ├── InstanceBadge.ts                 # 可拖拽角标注入脚本 + addScriptToEvaluateOnNewDocument 绑定
│   ├── PageToolAdapter.ts               # 把 upstream Tool → page_ 派生版（schema 改写 + handler 转发）
│   ├── InstanceMutex.ts                 # 按 instanceId 粒度的互斥锁
│   └── managementTools/                 # 6 个管理工具的 ToolDefinition
│       ├── browserConnect.ts
│       ├── instanceCreate.ts
│       ├── instanceList.ts
│       ├── instanceClose.ts
│       ├── instanceCloseAll.ts
│       └── instanceExportAuth.ts
└── (其它 upstream 文件保持不变)

tests/
├── parallel/                            # NEW
│   ├── InstanceRegistry.test.ts
│   ├── SnapshotEnhancer.test.ts
│   ├── AuthCloner.test.ts
│   ├── PageToolAdapter.test.ts
│   ├── InstanceMutex.test.ts
│   ├── BrowserConnector.test.ts         # 端口探测 / autoLaunch=false 分支
│   ├── DownloadManager.test.ts
│   └── e2e
│       ├── two-instances-isolation.test.ts  # US1
│       ├── auth-clone.test.ts               # US2
│       ├── page-tools-parity.test.ts        # US3, ≥20 工具
│       └── badge-and-snapshot.test.ts       # US4
└── (upstream tests 保持不变)

package.json                              # 改：
                                          #   - name: chrome-devtools-mcp-parallel
                                          #   - bin 新增 "chrome-devtools-mcp-parallel"
                                          #   - 保留原 bin 为无破坏兼容（可选：逐步废弃）
README.md                                 # 改：新增 "Parallel Mode" 章节
```

**Structure Decision**:

选择**单仓库 + 子目录扩展**（非 monorepo）。理由：

1. 复用 upstream `src/tools/*`、`src/McpContext.ts`、`src/browser.ts` 等所有实现不必抽公共包；monorepo 的拆分代价 > 收益。
2. 所有并行专有代码集中在 `src/parallel/`，审查边界清晰，便于跟踪上游同步。
3. `package.json` 改名后本仓库即发布为 `chrome-devtools-mcp-parallel`；upstream `chrome-devtools-mcp` 由 Google 继续发布，互不冲突（澄清 Q1）。
4. 保留现有 `chrome-devtools-mcp` / `chrome-devtools` 两个 bin 作为"不改变行为"的兼容入口，新增 `chrome-devtools-mcp-parallel` 作为并行默认入口。用户 `npx chrome-devtools-mcp-parallel@latest [options]` 即获并行模式。

## Phase 0 — Research (see `research.md`)

关键未决技术点与结论（全文见 `research.md`）：

1. **CDP 模式下 per-instance 隔离选用 Puppeteer 的 `createBrowserContext()`** — 它创建 incognito-like BrowserContext，支持独立 cookie/storage，可列出其下的 pages/targets；避免自行维护 context↔page 映射。
2. **鉴权注入**：Cookie 用 `browser.setCookie()`（跨 context 粒度）+ `BrowserContext.overridePermissions`；localStorage 通过 `page.evaluateOnNewDocument()` 在首次 `document_start` 注入。httpOnly Cookie 只能来自已连接 CDP 浏览器的真实会话（Document cookies 无法在 Script 中读取），故 CDP 模式保登录。
3. **快照增强嵌入点**：upstream `SnapshotFormatter.ts` 生成快照文本；我们**不改 upstream**，而是在 `PageToolAdapter` 的外层包装 `page_take_snapshot` 的 handler —— 调用完后拿到 response content，`SnapshotEnhancer.process(text, prevCache)` 再替换为增强版 content。
4. **工具互斥粒度**：`src/index.ts` 用单个 `Mutex`；并行模式不复用它。`PageToolAdapter` 改用 `InstanceMutex`：`acquire(instanceId)` 只锁本实例，管理工具走整体锁；同一实例内串行、跨实例并行。
5. **CDP 端口探测**：HTTP GET `http://127.0.0.1:<port>/json/version`，200 且返回 JSON 含 `webSocketDebuggerUrl` 视为可用；依次 9222→9223→9224，timeout 500ms。
6. **自动拉起**：读取注册表/常见路径找到 Chrome/Edge 可执行，`spawn(exec, ['--remote-debugging-port=9222', '--user-data-dir=<tmp profile>'])`；detached + unref；**不**使用 Puppeteer 的 `puppeteer.launch()` 以避免被视作 Puppeteer 子进程（用户手动关闭后也不会误杀 MCP）。`--no-auto-launch` 或 `autoLaunch:false` 时跳过本步。
7. **连接看门狗**：`setInterval(3000)` 调用 `browser.version()`；失败立刻 `browser.disconnect()` 并启动重连（最多 3 次指数退避 1s/2s/4s）；重连成功后调用 `InstanceRegistry.refreshCdpBrowser(newBrowser)` 把所有 CDP 实例的 Browser 引用替换（BrowserContext 也需要重新获取 via `context.id`）。
8. **下载接管**：CDP `Browser.setDownloadBehavior({behavior: 'allow', downloadPath})` 每实例设置；launch 模式通过 `defaultDownloadPath` Chrome 启动参数 + 同样的 CDP 覆盖。
9. **可视角标**：通过 `page.evaluateOnNewDocument(badgeScript, instanceId)` 在页面加载前注入；脚本在 `DOMContentLoaded` 后创建 fixed 定位的 div，`position: fixed; bottom:8px; right:8px; z-index: 2147483647`，可 pointerdown 拖拽；对 `about:` / `chrome:` / `devtools:` URL 通过 `page.url().startsWith(...)` 判断提前跳过。

## Phase 1 — Design

- **Data model** — 见 `data-model.md`。核心：`Instance`、`InstanceMode`、`AuthState`、`ConnectedBrowser`、`PageToolDerivation`。
- **Tool contracts** — 见 `contracts/management-tools.md` 与 `contracts/page-tool-derivation.md`，包含每个工具的名字、描述模板、`inputSchema`、返回 schema 与错误模式。
- **Quickstart** — 见 `quickstart.md`：`npx chrome-devtools-mcp-parallel@latest` → `browser_connect` → `instance_create` ×2 → 并行 `page_navigate`。目标 ≤5 分钟（支撑 SC-006）。

## Post-Design Constitution Re-check

| 门禁                     | 复检结论                                                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 不触碰 upstream 默认行为 | 所有 Phase 1 产物仅新增文件，无上游文件改动                                                                                                                          |
| TS 纪律                  | 契约中所有签名均可在不用 `any`/`as`/`!` 的前提下表达；`PageToolAdapter` 用泛型保留原 `ToolDefinition` 的 `schema` 类型                                               |
| 派生工具等价             | 契约明确声明派生 handler = strip(`instanceId`) → resolve(`PerInstance.context`) → 原 handler 调用 → 可选 `SnapshotEnhancer.wrap`；除 `page_take_snapshot` 外无语义差 |

**结果**: PASS — 继续到 `/speckit.tasks`。

## Complexity Tracking

> 无违例，本表保持为空。

| Violation | Why Needed | Simpler Alternative Rejected Because |
| --------- | ---------- | ------------------------------------ |
| _(none)_  |            |                                      |
