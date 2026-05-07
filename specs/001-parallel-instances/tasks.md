---
description: 'Actionable task list for feature 001-parallel-instances'
---

# Tasks: Chrome DevTools MCP 并行多实例支持

**Feature**: `001-parallel-instances` | **Branch**: `001-parallel-instances` | **Date**: 2026-05-07

**Input**: `spec.md`, `plan.md`, `research.md`, `data-model.md`, `contracts/management-tools.md`, `contracts/page-tool-derivation.md`, `quickstart.md`

**Tests**: 本特性明确要求回归与端到端覆盖（SC-003 要求 ≥20 个派生工具覆盖；`plan.md` 源码结构显式列出 `tests/parallel/**`），因此**包含测试任务**（必须在实现前 FAIL）。

**Organization**: 按用户故事分组，每个故事独立可测、可交付。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 不同文件、无依赖，可并行执行
- **[Story]**: US1 / US2 / US3 / US4；FOUND = Phase 2 基础；SETUP = Phase 1；POLISH = 最后阶段
- 所有路径相对仓库根

---

## Phase 1: Setup（共享基础设施）

**Purpose**: 新增并行 bin、项目结构、构建链路，不破坏 upstream。

- [ ] **T001** [SETUP] 修改 `package.json`：
  - 把 `name` 改为 `chrome-devtools-mcp-parallel`
  - 在 `bin` 字段追加 `"chrome-devtools-mcp-parallel": "build/src/bin/chrome-devtools-mcp-parallel.js"`；保留现有 `chrome-devtools-mcp` 与 `chrome-devtools` bin
  - 在 `files` 字段确保 `build/src/parallel/**`、`build/src/bin/chrome-devtools-mcp-parallel.js` 被包含
  - 更新 `description` 与 `keywords`（加入 `parallel`/`multi-instance`）
- [ ] **T002** [SETUP] 新建 `src/parallel/` 与 `tests/parallel/` 顶层目录并放入 `index.ts` / `README.md` 骨架占位，确保 `tsc --build` 能发现
- [ ] **T003** [P] [SETUP] 更新 `README.md` 顶部追加 `## Parallel Mode (Preview)` 章节占位，引用 `specs/001-parallel-instances/quickstart.md`；不涉及功能说明（留到 Polish 阶段补全）
- [ ] **T004** [P] [SETUP] 新建 `src/bin/chrome-devtools-mcp-parallel.ts` 骨架（含 shebang、仅调用 `createParallelMcpServer()` 的 `main()` 入口、throw 占位）；同步新增 `src/parallel/index.ts` 导出 `createParallelMcpServer()` 空实现

**Checkpoint**: `npm run build` 通过、`npx chrome-devtools-mcp-parallel --help` 可启动（即使未实现功能）。

---

## Phase 2: Foundational（阻塞所有故事的公共基础）

**Purpose**: 所有故事都依赖的类型、注册表、锁、BrowserLike 适配、CLI 解析。

**⚠️ CRITICAL**: 本阶段未完成前，任何用户故事任务不得启动。

- [ ] **T005** [FOUND] 在 `src/parallel/types.ts` 定义 `InstanceMode`、`AuthCookie`、`AuthOriginStorage`、`AuthState`、`ConnectedBrowser`、`DerivedTool`、`ParallelServerArgs` 等纯类型（对齐 `data-model.md` §1–§5），**禁止**使用 `any`/`as`/`!`
- [ ] **T006** [P] [FOUND] 实现 `src/parallel/InstanceMutex.ts`：
  - API `acquire(instanceId?: string): Promise<Release>`
  - `per-id` Map + 全局 `global` 链；读写锁语义（`global` 独占 / `per-id` 同 id 串行 / 异 id 并行）
  - 严禁 `any`；`Release` 使用 disposable 风格 `{ dispose(): void }` 或 `Symbol.dispose`
- [ ] **T007** [P] [FOUND] 编写 `tests/parallel/InstanceMutex.test.ts`：
  - 同 id 串行、异 id 并行、global 与 per-id 互斥、异常路径自动释放 —— **必须先 FAIL**
- [ ] **T008** [P] [FOUND] 实现 `src/parallel/InstanceRegistry.ts`：
  - `add(Instance)` / `get(id)` / `list()` / `remove(id)` / `refreshCdpBrowser(newBrowser)` / `size()`
  - 维护唯一约束、软上限 `maxInstances`（默认 10、可配）
  - 所有方法**同步**；调用方须持有 `InstanceMutex` 全局锁
- [ ] **T009** [P] [FOUND] 编写 `tests/parallel/InstanceRegistry.test.ts`：重复 id、超上限、`refreshCdpBrowser` 按 contextId 重绑——**先 FAIL**
- [ ] **T010** [P] [FOUND] 实现 `src/parallel/BrowserLike.ts` 适配器：
  - 把一个 `BrowserContext` 包装成 upstream `McpContext` 所需的最小 `Browser` 视图（只暴露本 context 的 `pages()`、`createBrowserContext()` 透传、`on`/`off` 转发）
  - 目的：复用 upstream `McpContext.from(browser, ...)` 而不 fork；泛型保留原 handler 签名，不 `as`
- [ ] **T011** [P] [FOUND] 实现 `src/parallel/cli.ts`：yargs 解析
  - 透传 upstream 所有 CLI（复用 upstream `src/bin/chrome-devtools-mcp.ts` 中 `yargs` builder 的**导出**形式；若 upstream 未导出则在不修改 upstream 的前提下新建 `src/parallel/cliFromUpstream.ts` 复制 builder 定义，并打注释指明同步来源）
  - 新增并行专属：`--max-instances <n>`（默认 10）、`--auto-launch` / `--no-auto-launch`（默认 true）
- [ ] **T012** [P] [FOUND] 实现 `src/parallel/PerInstance.ts` 骨架：
  - 构造函数接受 `{ id, mode, browser, context, contextId, downloadPath, mcpContext }`
  - 字段对齐 `data-model.md` §2；提供 `close()`、`markUnavailable()`、`markAvailable()`
  - **不**实现 auth/badge/snapshot 逻辑（留给后续 Phase），但预留挂接点
- [ ] **T013** [FOUND] 编写 `tests/parallel/PerInstance.test.ts`：基本构造、`close()` 分支（cdp vs launch）——**先 FAIL**

**Checkpoint**: 能构造 Instance 对象、通过 InstanceMutex 串并行正确性测试；无业务功能。

---

## Phase 3: User Story 1 - 同时运行多个隔离浏览器实例（Priority: P1 / MVP）🎯

**Goal**: 同一 MCP 进程内并发运行多个隔离的 puppeteer 实例，管理工具可 create / list / close。

**Independent Test**: `instance_create` ×2 → 两实例分别 `page_navigate_page`（此时仅需接通最小派发即可，哪怕只有 navigate/select_page 可用）→ `instance_list` → `instance_close_all`。

### Tests for US1（先 FAIL）

- [ ] **T014** [P] [US1] `tests/parallel/managementTools/instanceCreate.test.ts`：重复 id、上限、launch 模式冒烟
- [ ] **T015** [P] [US1] `tests/parallel/managementTools/instanceListCloseCloseAll.test.ts`：列表格式、单关、全关幂等
- [ ] **T016** [P] [US1] `tests/parallel/e2e/two-instances-isolation.test.ts`（US1 端到端）：
  - 两个 launch 模式实例并行 `page_navigate_page`
  - cookie/localStorage 互不可见（注入后读取）
  - `instance_close_all` 后无孤儿进程（通过子进程 PID 集合对比）

### Implementation for US1

- [ ] **T017** [US1] 实现 `src/parallel/managementTools/instanceCreate.ts`（launch 模式路径优先，cdp 路径占位到 Phase 4 补齐）：
  - 严格对齐 `contracts/management-tools.md §2` 的 inputSchema / 成功文本 / 错误模式
  - `useCDP=true` 无 ConnectedBrowser → 返回 "fell back to launch" 提示行（FR-003）
  - 调用 `InstanceRegistry.add`，启动 `McpContext.from(browserLike, serverArgs)`
  - 可选 `url` → 初始导航（调用 upstream `navigate_page` handler）
- [ ] **T018** [P] [US1] 实现 `src/parallel/managementTools/instanceList.ts`：
  - 格式对齐契约 §3；URL/title 抓取失败回退占位 `?`
- [ ] **T019** [P] [US1] 实现 `src/parallel/managementTools/instanceClose.ts`：
  - CDP 模式仅关 `context.close()`；launch 模式 `browser.close()` + 清理下载目录
- [ ] **T020** [P] [US1] 实现 `src/parallel/managementTools/instanceCloseAll.ts`：
  - 顺序关闭、per-instance 失败降级为 warning 行（不抛错）
- [ ] **T021** [US1] 实现 `src/parallel/PageToolAdapter.ts` 基础版（仅 navigate/select_page/new_page/close_page 等最小页面工具）：
  - `deriveTool(upstreamTool): DerivedTool` — schema 改写（`instanceId` 置顶、加入 required、`additionalProperties:false`、描述加 `[Parallel]` 前缀）
  - `dispatch()` 顺序严格遵循 `contracts/page-tool-derivation.md §2` 步骤 1–6、8（步骤 7 快照增强留给 US4）
  - **不**使用 `any`；用泛型 `<T extends ToolDefinition<S>>` 保留 schema 精度
- [ ] **T022** [US1] 在 `src/parallel/index.ts` 的 `createParallelMcpServer()` 中：
  - 构造 MCP server、注册 6 个管理工具（Phase 3 注册 5 个：connect 占位到 US2；Phase 4 再补全）
  - 针对 upstream 启用的工具调用 `PageToolAdapter.deriveTool(...)` 批量派生注册
  - 派生过滤：使用 upstream `getToolStatusInfo` 判定 disabled→跳过（FR-008）
- [ ] **T023** [US1] 实现 `src/parallel/bin` 入口联通：
  - `src/bin/chrome-devtools-mcp-parallel.ts` → 调 `cli.ts` 解析参数 → `createParallelMcpServer(parallelServerArgs)` → stdio transport
  - 支持 `--max-instances`、`--no-auto-launch`（参数仅收口，US2 消费）

**Checkpoint**: 可通过 `npx chrome-devtools-mcp-parallel` 运行并跑通 `instance_create`→两实例 `page_navigate_page`→`instance_list`→`instance_close_all`。US1 端到端测试全绿。

---

## Phase 4: User Story 2 - 复用已登录 Chrome 的鉴权状态（Priority: P1）

**Goal**: `browser_connect` 抽取 cookies + localStorage → `instance_create(cloneAuth=true)` 新实例继承登录态；`instance_export_auth` 重置全局 AuthState；看门狗保活。

**Independent Test**: 手启 `--remote-debugging-port=9222` Chrome 并登录 → `browser_connect` → `instance_create`（CDP 模式）→ 新实例页面处于已登录；某实例完成新登录后 `instance_export_auth` 成功覆盖全局。

### Tests for US2（先 FAIL）

- [ ] **T024** [P] [US2] `tests/parallel/BrowserConnector.test.ts`：端口探测 9222→9223→9224、显式 cdpUrl、`autoLaunch:false` 指引、超时
- [ ] **T025** [P] [US2] `tests/parallel/AuthCloner.test.ts`：
  - `applyTo(context)` 对每 context 调用 `context.setCookie` 而不是 browser 级 setCookie
  - `evaluateOnNewDocument` 按 origin 分派 localStorage，跨 origin 不污染
- [ ] **T026** [P] [US2] `tests/parallel/DownloadManager.test.ts`：每实例独立目录、`Browser.setDownloadBehavior` 使用 `browserContextId`
- [ ] **T027** [P] [US2] `tests/parallel/e2e/auth-clone.test.ts`（US2 端到端）：基于一个 mock 登录站点（node http 服务器设 Set-Cookie + localStorage）验证 CDP 模式继承
- [ ] **T028** [P] [US2] `tests/parallel/ConnectionWatchdog.test.ts`：模拟 `browser.version()` 抛错 → 重连 3 次指数退避 → 成功后 `refreshCdpBrowser` 被调

### Implementation for US2

- [ ] **T029** [P] [US2] 实现 `src/parallel/AuthState.ts`：
  - frozen 全局单例，`get()/setFromBrowser(...)/setFromInstance(...)`
  - 写入时原子替换引用（data-model.md §8）
- [ ] **T030** [P] [US2] 实现 `src/parallel/BrowserConnector.ts`：
  - `discover(portList)` + `autoLaunch(tmpProfile, exec)`（Win 注册表 / macOS `/Applications` / Linux `which`）
  - `connect(cdpUrl)` → 返回 `ConnectedBrowser`
  - `extractAuth(browser, pageIndex)` → 读取 cookies (`browser.cookies()`) 与指定 page 的 localStorage（按 origin 分组）
  - 禁止 kill 现有浏览器；`spawn + detached + unref`
- [ ] **T031** [P] [US2] 实现 `src/parallel/AuthCloner.ts`：
  - `applyTo(context, authState)`：`context.setCookie(...)` + `page.evaluateOnNewDocument(script, originsJson)` 工厂；对 `PerInstance.attachPage` 钩子暴露
- [ ] **T032** [US2] 实现 `src/parallel/managementTools/browserConnect.ts`（对齐契约 §1）：
  - 参数 cdpUrl / pageIndex / autoLaunch
  - 成功/错误文本完全匹配契约表；连接成功写 AuthState
- [ ] **T033** [P] [US2] 实现 `src/parallel/managementTools/instanceExportAuth.ts`（对齐契约 §6）：
  - instanceId 提供 → 从 `Instance.context` 导出；未提供 → 从 `ConnectedBrowser` 导出
  - 错误："No source to export from. ..."
- [ ] **T034** [US2] 扩展 `instanceCreate`（T017）补齐 CDP 模式路径：
  - `useCDP=true` 且 `ConnectedBrowser.available` → `browser.createBrowserContext()` 派生 context；注入 AuthState（若 `cloneAuth=true` 且 AuthState 非空）
  - 记录 `contextId` 到 `Instance`
- [ ] **T035** [P] [US2] 实现 `src/parallel/ConnectionWatchdog.ts`：
  - `setInterval(3000)` → `browser.version()`；失败 → 重连 1s/2s/4s 指数退避、3 次上限
  - 重连成功 → `InstanceRegistry.refreshCdpBrowser(newBrowser)` + 重绑下载处理
  - 超限 → 停止看门狗、所有 cdp 实例 `available=false`、等待下次 `browser_connect`
- [ ] **T036** [P] [US2] 实现 `src/parallel/DownloadManager.ts`：
  - 每实例 `os.tmpdir()/chrome-devtools-mcp-parallel-downloads/<id>/`（mkdir recursive）
  - CDP `Browser.setDownloadBehavior({behavior:'allowAndName', downloadPath, eventsEnabled:true, browserContextId})`
  - launch 模式额外附加 `--download-default-directory=<path>`
  - 监听 `Browser.downloadProgress` 只记日志；失败/取消静默
- [ ] **T037** [US2] 在 `createParallelMcpServer()` 内补齐：
  - 注册 `browser_connect` 与 `instance_export_auth`
  - 启动时按 `--auto-launch` 选项决定是否预连接（默认 false，等用户显式调 `browser_connect`）
  - 每个 CDP 实例创建时调用 `DownloadManager.attach()` 与 `AuthCloner.applyTo()`
  - 连接成功后启动 `ConnectionWatchdog`

**Checkpoint**: US2 端到端测试全绿；CDP 断连 10s 内恢复（SC-004 部分）；手动 30 分钟压测无僵尸进程。

---

## Phase 5: User Story 3 - 与原生工具无缝兼容的 `page_*` 派发（Priority: P2）

**Goal**: upstream 所有启用工具均有 `page_*` 派生版；分类开关 / slim / 实验性 flag 全部生效；行为一致率 100%（SC-003，≥20 工具）。

**Independent Test**: `tools/list` 清单中验证派生工具数 = upstream 启用工具数 + 6；抽样 20 个工具对比独立模式返回。

### Tests for US3（先 FAIL）

- [ ] **T038** [P] [US3] `tests/parallel/PageToolAdapter.test.ts`：
  - schema 改写：`instanceId` 必在 `properties` 首键
  - `required` 去重、`additionalProperties:false`
  - `description` 前缀 `[Parallel]` + 后缀 "(operates on specified instance)"
  - `page_*` 不含 upstream 未启用的工具
- [ ] **T039** [P] [US3] `tests/parallel/e2e/page-tools-parity.test.ts`：
  - 选 20 个代表性工具：navigate_page / select_page / new_page / close_page / click / fill / hover / wait_for / take_snapshot / take_screenshot / evaluate_script / list_console_messages / list_network_requests / get_network_request / emulate_cpu / emulate_network / resize_page / handle_dialog / performance_start_trace / navigate_page_history
  - 对比 upstream 单实例模式与 `page_*` 派生结果（剔除允许差异后）
  - 断言 100% 一致（SC-003）
- [ ] **T040** [P] [US3] `tests/parallel/cli-flags.test.ts`：
  - `--slim` / `--categoryInput:false` / `--experimentalPageIdRouting` 等透传到 `getToolStatusInfo`
  - 被禁用工具**不**出现在派生清单

### Implementation for US3

- [ ] **T041** [US3] 在 `src/parallel/PageToolAdapter.ts` 中完善**全量派生**（扩展 T021 基础版）：
  - 从 upstream `src/tools/*` 导出的工具集合（reuse upstream 启用逻辑）批量派生
  - 对 `blockedByDialog` / `pageScoped` 字段忠实透传到 dispatch
  - 支持 `experimentalStructuredContent` 透传 `structuredContent`
- [ ] **T042** [P] [US3] 在 `cli.ts` 确认 upstream 所有 CLI flag 被正确解析并原样传入 upstream `getToolStatusInfo(tool, serverArgs)`；对新增 flag 写兼容注释
- [ ] **T043** [P] [US3] 在 `PerInstance` 中实现**每实例 selectedPage 游标**（FR-007a）：
  - 调用 upstream `McpContext` 本实例实例，不共享全局 selectedPage
  - 验证 `page_select_page` / `page_new_page` / `page_close_page` 仅改本实例状态
- [ ] **T044** [US3] 对接 telemetry（FR-023）：在 `dispatch` 的 step 8 记录 `toolName = 'page_' + upstream.name`、`success`、`latencyMs`、`instanceId`；复用 upstream `telemetry/*` API，不修改其代码
- [ ] **T045** [US3] 在 `dispatch` 的错误分支加一致性断言：
  - 缺 `instanceId` → 结构化错误（MCP server schema 校验已覆盖，但 `dispatch` 层补兜底）
  - 实例不存在 / unavailable → 文本对齐 data-model.md §5 step 1/2

**Checkpoint**: `page-tools-parity` 20 工具一致率 100%；CLI flags 全透传生效。

---

## Phase 6: User Story 4 - 快照增强与可观测性（Priority: P3）

**Goal**: `page_take_snapshot` 降噪 + diff（35% 阈值） + `[CDP Field States]` + `[pageState]`；可视角标；端到端仅影响 `take_snapshot`，其他工具零侵入。

**Independent Test**: 对实例连调两次 `page_take_snapshot`：首次完整，二次 ≤35% 变化返回 diff-only；角标在非 chrome:// 页面可见。

### Tests for US4（先 FAIL）

- [ ] **T046** [P] [US4] `tests/parallel/SnapshotEnhancer.test.ts`：
  - 降噪：去掉纯 `generic` 叶子、`InlineTextBox`、折叠空行
  - diff：计算变更率；≤35% 输出 `+/-` + `[snapshot diff, X lines changed out of Y (Z%)]` 摘要；>35% 输出完整 + "检测到重大变化" 说明
  - origin 切换强制完整快照
  - 首次调用无 prev → 返回完整
- [ ] **T047** [P] [US4] `tests/parallel/SnapshotEnhancer.fieldStates.test.ts`：
  - CDP `DOM.getDocument` + `Runtime.callFunctionOn` 模拟
  - 失败节点跳过不抛错
  - 输出 `[CDP Field States]` 格式对齐契约 §5.2
- [ ] **T048** [P] [US4] `tests/parallel/SnapshotEnhancer.pageState.test.ts`：
  - error（`chrome-error://` / status ≥400） / loading（`readyState !== complete`） / normal 三态判定
- [ ] **T049** [P] [US4] `tests/parallel/InstanceBadge.test.ts`：
  - `evaluateOnNewDocument(script, instanceId)` 挂接
  - `about:` / `chrome:` / `devtools:` URL 跳过
  - 失败静默不抛
- [ ] **T050** [P] [US4] `tests/parallel/e2e/badge-and-snapshot.test.ts`（US4 端到端）：
  - 打开一个测试页 → 首次 snapshot 完整 → 小改后 snapshot diff-only → 可见 `🤖 <id>` 角标 DOM 节点
- [ ] **T051** [P] [US4] `tests/parallel/e2e/snapshot-noop-others.test.ts`：
  - `page_take_screenshot` / `page_list_console_messages` / `page_evaluate_script` / `page_list_network_requests` 返回**不包含**增强标签（FR-017/FR-018）

### Implementation for US4

- [ ] **T052** [US4] 实现 `src/parallel/SnapshotEnhancer.ts`：
  - `process({ text, prev, prevOrigin, page })`
  - 降噪子函数（正则集合；导出供单测）
  - O(n) 行集合差算法（added/removed/unchanged 计数；前后保留 N 行上下文）
  - `collectFieldStates(page)`：CDP `DOM.getDocument({depth:-1, pierce:true})` + `Runtime.callFunctionOn`
  - `detectPageState(page, networkCollector)`：优先级 error > loading > normal
  - 输出组合 `canonicalText`（无增强的降噪版，作为下一轮 prev）与 `text`（客户端展示）
- [ ] **T053** [US4] 在 `PageToolAdapter.dispatch` 的步骤 7（T021 中已预留 hook）接入 `SnapshotEnhancer`：
  - 仅 `upstream.name === 'take_snapshot'` 且 `!result.isError` 时执行
  - 替换 `result.content[0].text` 与更新 `instance.prevSnapshot` / `prevSnapshotOrigin`
- [ ] **T054** [P] [US4] 实现 `src/parallel/InstanceBadge.ts`：
  - 可拖拽 `🤖 <instanceId>` fixed 角标脚本字符串（模板；不内联任何 `any`）
  - `attachToInstance(instance)`：对 `browser.on('targetcreated')` 或 `context.on('targetchanged')` 的每个 new page → `page.evaluateOnNewDocument(badgeScript, instanceId)`；对已存在 page 也注入
  - URL 黑名单：`about:` / `chrome:` / `devtools:` / `chrome-extension:`
  - 失败吞异常
- [ ] **T055** [US4] 在 `createParallelMcpServer()` 中为每个新建 `Instance` 调用 `InstanceBadge.attachToInstance` 与 `DownloadManager.attach` 各一次，确保 CDP 看门狗重连后也重新绑定
- [ ] **T056** [US4] 压测脚本 `tests/parallel/stress/30min.ts`（可跳过 CI 默认执行，手动 `npm run test -- stress/30min`）：
  - 30 分钟连续 create/close/调用 `page_*`
  - 验证无未捕获异常、无僵尸进程、无下载目录泄漏（SC-004 完整覆盖）

**Checkpoint**: 所有用户故事端到端绿；SC-005（≥50% 长度下降）可观测。

---

## Phase N: Polish & Cross-Cutting

**Purpose**: 文档、性能、安全、验收。

- [ ] **T057** [P] [POLISH] 补全 `README.md` 的 `## Parallel Mode` 章节：工具清单（6 管理 + `page_*`）、`instanceId` 约定、`useCDP` 两模式差异、鉴权流程、与 upstream 的兼容与差异、5 分钟上手（链接到 `quickstart.md`）
- [ ] **T058** [P] [POLISH] 在 `specs/001-parallel-instances/quickstart.md` 基础上新增端到端录像/截图到 `docs/parallel/`（若项目策略允许），确保 5 分钟目标（SC-006）
- [ ] **T059** [P] [POLISH] 性能基准脚本 `tests/parallel/bench/parallel-vs-serial.ts`：跑 3 实例并行 vs 3 单实例串行，断言提速 ≥40%（SC-001）
- [ ] **T060** [P] [POLISH] 快照体积基准脚本 `tests/parallel/bench/snapshot-size.ts`：典型 ≥2000 节点页面连续 2 次 `page_take_snapshot`，断言二次文本长度下降 ≥50%（SC-005）
- [ ] **T061** [P] [POLISH] 执行 `npm run format` 修复 lint；确认**全项目**无 `any` / `as` / `!` / `@ts-*` 违规（新增代码）
- [ ] **T062** [P] [POLISH] 清理死代码、收紧 TS 泛型约束；对每个 `src/parallel/*.ts` 写 20 行以内头注释说明与 plan.md 的对应关系
- [ ] **T063** [POLISH] 运行 `quickstart.md` 全流程做人工验收；补漏的错误文案与文档
- [ ] **T064** [POLISH] 最终一次 `npm run build` + `npm run test` 全量通过；cross-check Constitution Re-check 五条门禁

---

## Dependencies & Execution Order

### Phase 依赖

- Phase 1（Setup）：无依赖
- Phase 2（Foundational）：依赖 Phase 1；**阻塞**所有用户故事
- Phase 3（US1）：依赖 Phase 2；本阶段为 MVP，可独立交付
- Phase 4（US2）：依赖 Phase 2；与 US1 并行（若团队充足），但完整 `instance_create(useCDP=true)` 需合并 US1 T017 的 launch 版 + US2 T034 的 CDP 版
- Phase 5（US3）：依赖 Phase 2 + US1（需 PageToolAdapter 基础）；可与 US2 并行
- Phase 6（US4）：依赖 US3 的 PageToolAdapter（dispatch hook）与 US1 的 Instance 生命周期
- Phase N（Polish）：依赖全部用户故事

### 用户故事内部

- 测试先于实现（TDD，**必须先 FAIL**）
- 类型 / 契约类文件（T005 / T029）先于业务实现
- 管理工具 handler（T017–T020）先于与 PageToolAdapter 的联调（T021–T023）

### 并行机会

- Phase 2 中 T006 / T008 / T010 / T011 / T012 四文件互不依赖，可并行
- Phase 3 测试 T014 / T015 / T016 可并行；实现 T018 / T019 / T020 可并行（不同文件）
- Phase 4 测试 T024–T028 五个文件全部可并行；实现 T029 / T030 / T031 / T035 / T036 亦可并行
- Phase 5 / 6 的 `[P]` 任务同理
- Polish 中 T057 / T059 / T060 / T061 / T062 并行

---

## Parallel Launch Example（US2 实现阶段）

```text
并行启动五个任务（不同文件）：
  T029 实现 AuthState
  T030 实现 BrowserConnector
  T031 实现 AuthCloner
  T035 实现 ConnectionWatchdog
  T036 实现 DownloadManager
```

---

## Implementation Strategy

### MVP First (US1 only)

1. Phase 1 Setup → Phase 2 Foundational → Phase 3 US1
2. **STOP + VALIDATE**：两实例 launch 模式并行跑通 + US1 e2e 全绿
3. 可发布 `chrome-devtools-mcp-parallel@0.1.0-mvp`

### Incremental Delivery

1. MVP (US1) → 发布 preview
2. - US2 鉴权克隆 + 看门狗 → `0.2.0`
3. - US3 全量派发与行为等价 → `0.3.0`
4. - US4 快照增强 + 角标 → `1.0.0-rc`
5. Polish → `1.0.0`

### Parallel Team Strategy

- Dev A：US1 → US3（同一条派发主干）
- Dev B：US2（BrowserConnector / Auth / Watchdog）
- Dev C：US4（SnapshotEnhancer / Badge）

---

## Notes

- `[P]` 任务：不同文件、无依赖
- 测试任务**必须**在对应实现前提交并验证 FAIL
- 每个任务建议单独 commit（或一个逻辑组一次 commit）
- 任何违背 Constitution（`any`/`as`/`!`/`@ts-ignore` 等）的实现必须回滚到泛型 + 窄化函数重写
- 新增代码禁止修改 upstream 现有文件；仅 `package.json` / `README.md` 可动，且改动范围限于本 tasks.md 明确列出之处
