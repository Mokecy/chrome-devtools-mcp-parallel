# Phase 0 Research: Chrome DevTools MCP Parallel

**Feature**: `001-parallel-instances` | **Date**: 2026-05-07

本阶段针对实现规划中尚未明确的 9 个关键技术点逐一调研，给出**决策 / 理由 / 拒绝的备选**三段式记录。所有调研结论已回灌到 `plan.md` 的 Phase 0 摘要与 `data-model.md`、`contracts/` 中。

## R1. Per-instance 隔离机制（CDP 模式）

**Decision**: 使用 Puppeteer 24 的 `browser.createBrowserContext()`（返回 `BrowserContext`），每个实例一个上下文；launch 模式另行 `puppeteer.launch()` 得到全新 `Browser`。

**Rationale**:

- `BrowserContext` 天然隔离 Cookie / Storage / Cache，Puppeteer `browserContext.pages()` 直接返回本上下文的页面，无需自行维护映射。
- 与 `McpContext` 的 `Browser`→`pages` 模型兼容：只要把 upstream `McpContext.from(browser, ...)` 改造为 `McpContext.from(browserLike, ...)` 的能力放到 `PerInstance` 里自建（不影响 upstream 源码），通过传入一个只暴露本实例 pages 的 `BrowserLike` 适配器即可。
- 实例关闭：CDP 模式 `ctx.close()` 只销毁该 context；launch 模式 `browser.close()` 关进程。

**Alternatives Rejected**:

- 单 `Browser`、自行给 page 打 instance tag 并过滤：逻辑易出错，被跨 context 事件污染。
- 每实例一个 `puppeteer.connect()` 连接同一 CDP 端点：理论可行但多连接增加握手开销、事件订阅重复。

## R2. 跨 BrowserContext 的 Cookie 共享事实

**Decision**: `browser.setCookie(...)` 在 Puppeteer 24 中作用于**整个 Browser**（所有 context 可见）；而 `browserContext.setCookie` 只对当前 context 生效。我们在 `cloneAuth=true` 时**对每个实例的 context 单独 setCookie**，保证实例隔离的同时获得同一份初始 cookies。

**Rationale**:

- 手动给 context 逐个注入避免跨实例污染（若用 browser 级 setCookie，新创建的 context 虽不继承 cookies，但已存在的 context 会立即可见——破坏隔离）。
- httpOnly cookies 只能通过 CDP `Network.setCookies`（Puppeteer 已封装）从外部注入，这在 context 级 API 上被支持，故依旧满足鉴权克隆。

**Alternatives Rejected**:

- browser 级 setCookie：破坏隔离，直接弃。
- `browser.defaultBrowserContext()` 接待所有 cookie：与 FR-016 冲突。

## R3. localStorage 注入时机

**Decision**: 通过 `page.evaluateOnNewDocument((origins) => { ... })` 在首个 Document 脚本中按 `window.location.origin` 匹配并 `localStorage.setItem`，在 `PerInstance.attachPage(page)` 时绑定。

**Rationale**:

- 必须**早于**页面自身脚本运行，否则 SSO/状态判断脚本先跑会判定未登录。
- 注入函数按 origin 分派，避免把 foo.com 的 token 误写进 bar.com。
- 失败（如沙箱 iframe、文件协议）用 `try/catch` 吞掉，符合 FR-019 / FR-017 的"静默忽略"要求。

**Alternatives Rejected**:

- `page.evaluate` 注入：在 document-idle 才跑，太晚。
- `CDP.Page.addScriptToEvaluateOnNewDocument` 直调：功能等价但 Puppeteer 已有包装，无须绕开。

## R4. 快照增强嵌入点

**Decision**: 在 `PageToolAdapter` 对 `page_take_snapshot` 做**外层包装**：调用 upstream handler → 拦截 response 的 `content` 数组 → 对 type=`text` 片段用 `SnapshotEnhancer.process(text, perInstance.prevSnapshot)` 替换 → 返回新结果，并更新缓存。**不改 upstream `SnapshotFormatter.ts`**。

**Rationale**:

- upstream 可能随时迭代 `SnapshotFormatter`；外层包装最小耦合，也便于 FR-017 的"仅作用于 `page_take_snapshot`"定位。
- diff 算法：按行计算 Levenshtein/LCS 成本太高，采用**按行集合差**（O(n)）——计算新增行、删除行、未变行数，变更率 = (added + removed) / max(1, oldLines+newLines)；≤35% 输出 `+`/`-` 前缀的 diff 行 + 未变节选头尾，>35% 输出完整新快照。
- 降噪阶段（预处理）逐行正则过滤 `^\s*- generic$`、`^\s*InlineTextBox`、连续空行折叠为一行。

**Alternatives Rejected**:

- 改 upstream Formatter：违背"不碰上游"门禁。
- 在 `McpResponse` 层切入：需要在并行模式下替换 upstream 的 response 类，扩散面大。

## R5. `[CDP Field States]` 的采集方式

**Decision**: `SnapshotEnhancer.collectFieldStates(page)` 通过 CDP：

1. `DOM.getDocument({depth: -1})` 获取全文档 nodeId 树；
2. 筛选 `nodeName` ∈ `input, textarea, select` 及 `contenteditable=true` 的节点；
3. 对每个节点 `Runtime.callFunctionOn` 读取 `value`、`placeholder`、`checked`、`disabled`、`name`、`id`；
4. 拼成 `[CDP Field States]\n- selector=#foo value="bar" disabled=false\n...`。

**Rationale**:

- 相较 `page.$$eval` 更稳定（不依赖主 world 的全局 `$`/`$$`），且能覆盖 Shadow DOM（通过 `DOM.pushNodesByBackendIdsToFrontend` + `pierce: true`）。
- 失败任一节点 → 跳过该节点，不抛错（符合 FR-018）。

**Alternatives Rejected**:

- 纯 `page.evaluate`：跨 world/Shadow 需要额外代码且脆弱。
- a11y 快照附带 value：a11y 不含 placeholder/disabled 等非必要属性。

## R6. `[pageState]` 的判定规则

**Decision**: 三态判定（优先级从高到低）：

1. **error** — `page.url()` 是 `chrome-error://` 或响应主文档 status ≥ 400（通过 upstream 的 NetworkCollector 或 CDP 主 frame 的最近一次 `Network.responseReceived`）。
2. **loading** — `document.readyState !== 'complete'`，或最近 500ms 内 `Page.frameStartedLoading` 仍未 `frameStoppedLoading`。
3. **normal** — 其他。

**Rationale**:

- 符合 FR-018；字段读取用 `page.evaluate(() => document.readyState)` 做 fallback，CDP 订阅作为主信号。
- 失败（CDP 会话断开）→ 返回 `normal`，不阻塞快照。

**Alternatives Rejected**:

- 更细粒度（`interactive` / `idle`）：规范未要求，YAGNI。

## R7. CDP 端口探测与自动拉起

**Decision**: `BrowserConnector.discover()`：

- 依次 `fetch('http://127.0.0.1:<port>/json/version', { signal: AbortSignal.timeout(500) })`，`port ∈ [9222, 9223, 9224]`；200 + JSON.parse 成功 + `webSocketDebuggerUrl` 字段即视为可用，返回该 `wsEndpoint` 给 `puppeteer.connect()`。
- 均无可用且 `autoLaunch !== false` 时调 `BrowserConnector.autoLaunch()`：查找 Chrome/Edge 可执行（Win：注册表 HKCU/HKLM App Paths；macOS：`/Applications/Google Chrome.app/...`；Linux：`which google-chrome` / `chromium`）→ `child_process.spawn(exec, ['--remote-debugging-port=9222', '--user-data-dir=' + tmpProfile], { detached: true, stdio: 'ignore' })` 并 `unref()` → 轮询 `/json/version` 最多 10 秒。
- 用户显式 `browser_connect({ cdpUrl: 'http://host:port' })` 时直接用该 URL，不探测、不拉起。
- `--no-auto-launch` 或 `autoLaunch: false` → 跳过 autoLaunch，直接返回手动指引（包含需要的 CLI 命令行）。

**Rationale**:

- HTTP 探测比建 WS 连接便宜，且失败反馈快。
- `spawn + detached` 独立进程，用户关闭调试浏览器不带走 MCP 进程；不用 `puppeteer.launch` 避免 Puppeteer 跟踪此进程并在 disconnect 时发送 SIGTERM。
- 独立 profile 保障用户日常浏览器（有 SSO、扩展、敏感数据）**零被动污染**。

**Alternatives Rejected**:

- Netstat/ports 扫描：跨平台兼容差。
- `lsof -i:9222`：Linux/macOS only。

## R8. 连接看门狗

**Decision**: `ConnectionWatchdog` 单例，每 3 秒对已连接 CDP browser 调用 `browser.version()`（底层走 `Browser.getVersion`）。

- 连续 1 次失败判定断线，立即：
  1. 将 `ConnectedBrowser.available=false`；
  2. 对 CDP 模式实例标记 `mode='cdp', available=false`；
  3. 启动重连调度器：最多 3 次（间隔 1s / 2s / 4s），每次用上次的 `cdpUrl` 重新 `puppeteer.connect()`；
  4. 重连成功 → `InstanceRegistry.refreshCdpBrowser(newBrowser)` 按每实例保存的 `contextId` 重新 attach context（Puppeteer 24 `browser.browserContexts()` 可枚举）；若 context 已被浏览器侧销毁，把该实例标记 `closed`；
  5. 全部失败 → 停止看门狗，下次 `browser_connect` 重启。

**Rationale**:

- 3s/3 次满足 SC-004 的"≤10 秒恢复"。
- 与 `page_*` 调用解耦：命中不可用实例的工具调用直接返回 `isError: true`，不阻塞重连（FR-014）。

**Alternatives Rejected**:

- 监听 `browser.on('disconnected')`：Puppeteer 事件在部分场景（如 TCP 半开）不触发，需主动探活。
- WebSocket ping：协议级支持不完整，version() 足够。

## R9. 下载接管

**Decision**: 每实例创建时：

- 计算 `downloadPath = path.join(os.tmpdir(), 'chrome-devtools-mcp-parallel-downloads', instanceId)`，`fs.mkdirSync(..., {recursive:true})`。
- 发送 CDP：`Browser.setDownloadBehavior({ behavior: 'allowAndName', downloadPath, eventsEnabled: true, browserContextId: <this ctx id> })`（`browserContextId` 让 CDP 按 context 维度分流）。
- launch 模式另外补 Chrome 启动参数 `--download-default-directory=<downloadPath>` 作为 fallback。
- 监听 `Browser.downloadProgress` 记录完成/失败日志；失败/取消不向 AI 报错（FR-015）。
- 实例关闭时（launch 模式）同时 `fs.rmSync(downloadPath, {recursive:true, force:true})`；CDP 模式不清理（可能用户还要看文件），但不阻塞关闭。

**Rationale**:

- 避免页面上的 `<a download>` 触发导航（`allowAndName` 行为把 navigation 吞掉）。
- `browserContextId` 参数确保不同实例互不串。

**Alternatives Rejected**:

- 全局 `Page.setDownloadBehavior`：影响其它实例。
- 不接管下载：页面下载会触发 navigation error + 可能断 CDP。

## Open Questions → Deferred to Implementation

仍留给实现阶段按需决定、不影响契约：

- 具体 Chrome 可执行搜索路径的优先级（跨平台边缘情况）。
- 降噪正则的具体正则表达式与单元用例集合。
- 可视角标样式细节（颜色、字体）。
- `--max-instances` 的最终默认值（目前暂定 10）。

这些项在 `/speckit.tasks` 生成的任务列表内收敛。
