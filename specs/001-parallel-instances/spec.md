# Feature Specification: Chrome DevTools MCP 并行多实例支持

**Feature Branch**: `001-parallel-instances`  
**Created**: 2026-05-07  
**Status**: Draft  
**Input**: User description: "参考 D:\github\playwright-mcp-parallel 要实现 Chrome mcp 也能支持 parallel 并行,要求并行功能完全迁移过来"

## Clarifications

### Session 2026-05-07

- Q: 并行模式的发布形态与入口？ → A: 独立 npm 包 `chrome-devtools-mcp-parallel`，单独二进制入口，内部复用 upstream `chrome-devtools-mcp` 的工具定义；与原包并存，对单实例用户零影响。
- Q: 实例内多标签页时 `page_*` 工具作用于哪一页？ → A: 每实例维护 "selected page" 游标，`page_*` 默认作用于该页；切换仍走 upstream 的 `select_page`/`new_page` 等工具，与单实例语义 1:1 对齐。
- Q: `useCDP=true` 但尚未 `browser_connect` 时怎么办？ → A: 静默回退到 launch 模式，响应文本标注 "useCDP requested but no connected browser, fell back to launch"，不报错、不阻塞创建。
- Q: 自动拉起调试浏览器是否可被关闭？ → A: 默认开启自动拉起；提供 `--no-auto-launch` CLI 开关与 `browser_connect({ autoLaunch: false })` 参数显式禁用；禁用且未检测到调试端口时直接返回手动启动指引。
- Q: 快照增强（降噪 / diff / `[CDP Field States]` / `[pageState]`）适用于哪些 `page_*` 工具？ → A: 仅作用于 `page_take_snapshot`；`take_screenshot` 等截图/二进制、`list_console_messages`/`list_network_requests` 等结构化列表、以及其它 `page_*` 工具保持 upstream 原样输出。

## User Scenarios & Testing _(mandatory)_

### User Story 1 - 同时运行多个隔离浏览器实例 (Priority: P1)

AI agent 用户希望同一个 MCP 服务器进程下并行操作多个互相隔离的浏览器会话，每个会话各有自己的标签页、Cookie、localStorage 与 DevTools 上下文，互不污染。用户通过调用管理工具创建若干命名实例，再通过带 `instanceId` 参数的浏览工具分别驱动它们。

**Why this priority**: 这是并行能力的核心价值。没有多实例隔离，整个特性不存在。其它能力（鉴权克隆、快照增强、看板角标等）都以此为基础。

**Independent Test**: 启动 MCP 服务器 → 调用 `instance_create` 两次分别创建 `task-1` 与 `task-2` → 分别对两个实例调用 `page_navigate`/`page_click` 等工具 → 确认两个实例显示不同页面且互不干扰 → 调用 `instance_list` 看到两个实例 → 调用 `instance_close` / `instance_close_all` 回收资源。即可独立验证 MVP。

**Acceptance Scenarios**:

1. **Given** MCP 服务器已启动，尚无实例，**When** 用户调用 `instance_create({ instanceId: "task-1" })` 与 `instance_create({ instanceId: "task-2" })`，**Then** 系统成功创建两个隔离浏览器上下文，`instance_list` 返回两条记录且各自有独立的 URL/标题。
2. **Given** 已有 `task-1` 与 `task-2` 两个实例，**When** 对 `task-1` 调用 `page_navigate({ instanceId: "task-1", url: "A" })`，对 `task-2` 调用 `page_navigate({ instanceId: "task-2", url: "B" })`，**Then** 两个浏览器窗口分别停留在 A、B 两个 URL，Cookie/localStorage 互相不可见。
3. **Given** 调用者未传 `instanceId` 或传了一个不存在的 `instanceId`，**When** 调用任意 `page_*` 工具，**Then** 系统返回可读错误提示（缺少 `instanceId` 或实例未找到），不影响其它实例运行。
4. **Given** 已有若干实例正在运行，**When** 调用 `instance_close({ instanceId })` 或 `instance_close_all`，**Then** 指定/全部实例的浏览器上下文被关闭并从注册表移除，资源释放，`instance_list` 反映最新状态。

---

### User Story 2 - 复用已登录 Chrome 的鉴权状态 (Priority: P1)

用户本机已有一个手动登录过业务系统的 Chrome/Edge 浏览器（带调试端口），希望新建的并行实例能自动继承登录态，无需重复登录；也希望能在某个实例完成登录流程后，把该实例的登录态"固化"为后续实例的默认鉴权。

**Why this priority**: 业务自动化场景里 SSO/登录往往是最大的阻塞点；没有鉴权克隆，并行的实用价值骤降。与 P1 故事 1 一起构成可发布的最小可用版本。

**Independent Test**: 用户以 `--remote-debugging-port=9222` 启动 Chrome 并手动登录 → 调用 `browser_connect` → 调用 `instance_create({ instanceId, url: 已登录站点 })` → 确认实例页面处于已登录状态；再对某实例调用 `instance_export_auth({ instanceId })`，随后 `instance_create` 新实例也呈已登录态。

**Acceptance Scenarios**:

1. **Given** 本机 Chrome 已开启调试端口且已登录目标站点，**When** 用户调用 `browser_connect`（可不指定 URL），**Then** 系统尝试常用端口（如 9222/9223/9224），成功连接后提取 Cookie 与 localStorage 作为全局鉴权状态，返回连接信息与 cookie 数量统计。
2. **Given** 本机无可用调试端口，**When** 用户调用 `browser_connect`，**Then** 系统在独立的调试 profile 目录下自动拉起一个新的 Chrome/Edge 调试实例并连接；若自动拉起失败则返回清晰的手动启动指引，且绝不 kill 用户既有浏览器进程。
3. **Given** `browser_connect` 已成功，**When** 用户调用 `instance_create({ instanceId, cloneAuth: true })`（默认），**Then** 新实例继承已连接浏览器的鉴权，加载目标站点时处于登录态。
4. **Given** 某实例已经完成新的登录流程，**When** 用户调用 `instance_export_auth({ instanceId })`，**Then** 系统读取该实例的 Cookie/localStorage 并覆盖为全局鉴权，之后新建的实例默认继承该登录态；不传 `instanceId` 时则从已连接的 CDP 浏览器导出。
5. **Given** `useCDP=true`（默认且已有连接），**When** 创建实例，**Then** 实例在已连接浏览器进程内开新上下文，保留 httpOnly Cookie 与 SSO 会话；**When** `useCDP=false`，**Then** 启动一个完全独立的浏览器进程，httpOnly Cookie 不可转移但隔离更强。

---

### User Story 3 - 与原生工具无缝兼容的 `page_*` 派发 (Priority: P2)

用户希望 chrome-devtools-mcp 现有的全部工具（导航、点击、截图、快照、性能、网络、脚本注入、设备模拟等）在并行模式下都能使用，形式上只多出一个 `instanceId` 参数与 `page_` 前缀；不存在兼容缺口。

**Why this priority**: 决定能否将现有 prompt/脚本平滑迁移到并行模式。没有它，只能操作管理工具却跑不了业务流程。

**Independent Test**: 创建 ≥1 个实例 → 列出 MCP 工具，验证每个原生工具都有一个对应的 `page_` 前缀版本 → 对任意若干工具调用（含快照、截图、脚本执行、性能跟踪等）附带 `instanceId`，结果由对应实例返回。

**Acceptance Scenarios**:

1. **Given** MCP 服务器已加载所有启用的 chrome-devtools-mcp 工具，**When** 客户端请求 `tools/list`，**Then** 返回的列表同时包含管理工具（`browser_connect`、`instance_create`、`instance_list`、`instance_close`、`instance_close_all`、`instance_export_auth`）与带 `page_` 前缀的并行版工具，每个并行工具的 `inputSchema` 在原 schema 基础上在 `properties` 最前追加 `instanceId`（并加入 `required`），并在描述里标注 "[Parallel] … (operates on specified instance)"。
2. **Given** 某 `page_*` 工具被调用且 `instanceId` 存在，**When** 系统派发，**Then** 其参数除 `instanceId` 外原样传给目标实例对应的原生工具，结果与独立运行 chrome-devtools-mcp 时一致。
3. **Given** 某工具被原 chrome-devtools-mcp 的分类/条件/CLI 开关禁用，**When** 生成并行工具列表，**Then** 该工具不出现在 `page_*` 列表中，与非并行模式保持一致。

---

### User Story 4 - 快照增强与可观测性 (Priority: P3)

用户希望在并行场景下每次获取页面快照时，系统自动做降噪、diff、状态标注，并注入"哪个实例"的可视角标，让 AI/人类都能快速定位。

**Why this priority**: 是已在 playwright-mcp-parallel 中沉淀的体验增强，独立于核心并行机制，可推迟；但明显降低上下文开销、减少误判。

**Independent Test**: 对实例连续两次调用 `page_*` 的快照类工具 → 首次返回完整快照，二次在"微小变化"时返回 diff-only；打开浏览器窗口可见一个含 `instanceId` 的拖拽式可视角标；快照文本末尾附 `[pageState: normal|loading|error]` 与 CDP 字段状态块。

**Acceptance Scenarios**:

1. **Given** 某实例首次调用页面快照工具，**When** 请求完成，**Then** 返回经过降噪（去除纯 `generic` 叶子、InlineTextBox、多余空行）的完整快照，并附加页面状态标签与表单字段实时值。
2. **Given** 某实例已缓存上一帧快照，**When** 再次请求快照且变化占比 ≤35%，**Then** 仅返回 diff 行与字段状态；变化 >35% 时返回完整快照并说明"检测到重大变化"。
3. **Given** 实例创建后任意页面加载/导航，**When** 页面 DOM 就绪，**Then** 页面右下角出现带 `instanceId` 的角标，可拖拽，不阻挡业务元素；未来新建/跳转页面也会自动重注入。
4. **Given** 实例创建时或 CDP 连接已建立，**When** 页面触发下载事件，**Then** 下载被接管并保存到每实例独立的临时目录（以 `instanceId` 分目录），不会导致当前标签页被导航走或 CDP 断开。
5. **Given** CDP 连接在运行中意外断开，**When** 看门狗周期性探活，**Then** 系统最多尝试有限次自动重连，成功后刷新所有 CDP 模式实例的浏览器引用；超出上限则停止重连并提示用户手动调用 `browser_connect`。

---

### Edge Cases

- 用户重复调用 `instance_create` 使用已存在的 `instanceId` → 返回"实例已存在"错误，不创建、不覆盖。
- 用户未连接 CDP 却设置 `useCDP=true` → 系统 MUST 静默回退到 launch 模式，响应正文 MUST 附带一行说明（如 `useCDP requested but no connected browser, fell back to launch`），实例照常创建。
- `browser_connect` 成功后用户手动关闭了被连接浏览器 → 下次探活发现失联，重置连接状态并提示重新连接，已存在的 CDP 模式实例标记为不可用。
- `instance_close` 时某实例为 CDP 模式 → 只关闭该实例的 BrowserContext，不关闭共享的已连接浏览器；launch 模式则关闭其整条浏览器进程。
- `instance_close_all` 结束后再创建实例 → 行为与全新状态一致，不遗留孤儿进程/临时文件。
- 工具 Mutex：原 chrome-devtools-mcp 使用全局 toolMutex 串行执行工具调用 → 需要重新评估是否按 `instanceId` 粒度加锁，以便真正并行。
- 并发下载、并发鉴权导出、同时 `instance_close_all` 与进行中的 `page_*` 调用之间的竞态，需确保资源释放有序且不抛未处理异常。
- 下载目录与鉴权状态中的敏感数据在进程退出时的清理策略。
- 服务器以 `--headless`、`--isolated`、`--user-data-dir` 等既有 CLI 选项启动时，launch 模式的实例必须继承这些配置。

## Requirements _(mandatory)_

### Functional Requirements

#### 管理工具

- **FR-001**: 系统 MUST 暴露 `browser_connect` 工具，用于连接已带调试端口的 Chrome/Edge 浏览器，提取当前登录上下文的 Cookie 与 localStorage 作为全局鉴权状态；支持可选 `cdpUrl` 与 `pageIndex` 参数；未指定 URL 时依次探测常用端口（至少 9222/9223/9224）。
- **FR-002**: `browser_connect` MUST 在检测不到调试端口时默认尝试以独立 profile 目录自动拉起 Chrome/Edge 调试实例并连接；MUST 支持通过 `--no-auto-launch` CLI 开关或 `browser_connect({ autoLaunch: false })` 参数显式禁用该行为，禁用时未检测到调试端口直接返回手动启动指引，不尝试拉起任何进程；自动拉起失败时 MUST 返回明确的手动启动指引；任何情况下 MUST NOT 终止用户既有浏览器进程。
- **FR-003**: 系统 MUST 暴露 `instance_create` 工具，参数包含 `instanceId`（必填）、`url`（可选初始导航）、`cloneAuth`（默认 true）、`useCDP`（默认在已连接时为 true，否则 false）；同名 `instanceId` 重复创建时 MUST 报错；`useCDP=true` 但当前无已连接 CDP 浏览器时 MUST 静默回退到 launch 模式并在响应里附带回退说明，不阻塞创建。
- **FR-004**: 系统 MUST 暴露 `instance_list`、`instance_close`、`instance_close_all`、`instance_export_auth` 四个工具，分别实现列出所有实例（含 URL/标题）、关闭单个实例、关闭全部实例、从指定实例或已连接 CDP 浏览器导出鉴权状态并更新为全局默认。
- **FR-005**: 关闭实例时，系统 MUST 针对 CDP 模式仅释放该实例的 BrowserContext，保留共享的被连接浏览器；针对 launch 模式 MUST 关闭对应浏览器进程并清理其下载临时目录。

#### 并行工具派发

- **FR-006**: 系统 MUST 把 chrome-devtools-mcp 原生启用的每个工具派生出一个带 `page_` 前缀的并行版工具；并行工具的 `inputSchema` MUST 在原 schema 的 `properties` 头部追加 `instanceId: string`，并把 `instanceId` 加入 `required`；描述 MUST 以 "[Parallel] " 开头并包含 "operates on specified instance" 字样。
- **FR-007**: 并行工具调用时，系统 MUST 根据 `instanceId` 在实例注册表中查找对应后端；缺失 `instanceId` 或实例不存在时 MUST 返回错误且不影响其它实例。
- **FR-007a**: 每个实例 MUST 独立维护自己的 "selected page" 游标；所有 `page_*` 工具默认作用于该实例的当前选中页；`select_page`、`new_page`、`close_page` 等 upstream 工具的并行派生版 MUST 只读写本实例的 page 列表与游标；实例之间的 selected page 状态彼此不可见、不干扰，以保持与 upstream 单实例语义 1:1 对齐。
- **FR-008**: 原 chrome-devtools-mcp 的分类开关（`categoryXxx`）、条件开关、以及 `--slim`、`--experimentalPageIdRouting`、`--experimentalDevtools`、`--experimentalIncludeAllPages` 等 CLI 选项 MUST 对并行工具继续生效；被禁用的原工具 MUST NOT 出现在 `page_*` 列表。
- **FR-009**: 系统 MUST 保证 `page_*` 工具的语义、返回结构与非并行模式一致（除 `instanceId` 路由与快照增强外），包括错误处理、`isError` 标记、可选的 `structuredContent` 等。

#### 鉴权克隆

- **FR-010**: 当 `cloneAuth=true` 且已有全局鉴权状态时，系统 MUST 在新实例的 BrowserContext 初始化阶段注入这些 Cookie 与 localStorage；CDP 模式下必须尽量保留 httpOnly Cookie 与 SSO 会话。
- **FR-011**: `instance_export_auth` MUST 支持两种来源：指定 `instanceId` 时从该实例的上下文读取 storageState；未指定时从已连接 CDP 浏览器的默认上下文读取；导出后 MUST 立即更新全局鉴权并供后续 `instance_create` 使用。
- **FR-012**: 鉴权状态 MUST 在服务器进程存活期间内存中保留，进程退出时随之消亡，不在磁盘留下持久副本（除非用户通过外部手段保存）。

#### 连接可靠性

- **FR-013**: CDP 模式连接建立后，系统 MUST 启动连接看门狗周期性探活；检测到断连时 MUST 在有限次内（至少 3 次）尝试重连；重连成功 MUST 刷新所有 CDP 模式实例的浏览器引用并重新绑定下载处理；达到上限仍失败时 MUST 停止重试并给出重连指引。
- **FR-014**: 看门狗的探活与重连 MUST NOT 阻塞正在处理的工具调用；重试期间 `page_*` 调用命中失联实例时 MUST 返回可识别的错误而非悬挂。

#### 下载与隔离

- **FR-015**: 每个实例 MUST 配置独立的下载目录（位于临时目录下以 `instanceId` 命名的子目录）；页面触发的下载 MUST 被接管并保存到该目录，避免触发页面导航或中断 CDP 连接；下载失败/取消 MUST 被静默处理或仅记录日志。
- **FR-016**: 实例之间 MUST 拥有完全独立的 Cookie 存储、localStorage、sessionStorage、缓存与 DevTools 会话，互相不可见不可改。

#### 体验增强

- **FR-017**: 快照增强 MUST 仅作用于 `page_take_snapshot` 工具；其它 `page_*` 工具（包括 `take_screenshot`、`list_console_messages`、`list_network_requests`、`evaluate_script` 等）MUST 保持 upstream 原样输出。针对 `page_take_snapshot` 的返回文本，系统 MUST 做降噪（至少去除纯 `generic` 叶子节点、`InlineTextBox` 冗余行与连续空行），并按实例缓存上一帧快照与当前帧 diff：变化率 ≤35% 返回 diff-only，>35% 返回完整快照并附变化行数摘要；首次调用、实例重建或导航到新 origin 后 MUST 返回完整快照。
- **FR-018**: `page_take_snapshot` 的返回内容 MUST 额外附加两段信息：`[CDP Field States]`（当前可见表单/可编辑元素的值、占位符、是否选中、是否禁用等）与 `[pageState: error|loading|normal]`；字段抓取失败时跳过该字段而非抛错；该两段附加内容 MUST NOT 出现在其它 `page_*` 工具的输出中。
- **FR-019**: 实例创建成功后，系统 MUST 在该实例的每个页面（含未来打开/跳转的页面）注入可拖拽可视角标，显示 `🤖 <instanceId>`；注入失败 MUST 静默忽略，不影响业务调用。
- **FR-020**: `instance_list` MUST 在列表中展示每个实例的 `id`、当前主页 URL、页面标题；获取失败的字段回退为占位值。

#### 兼容与入口

- **FR-021**: 系统 MUST 以独立 npm 包 `chrome-devtools-mcp-parallel` 形式发布，提供独立二进制入口（例如 `npx chrome-devtools-mcp-parallel@latest [options]`）；并行模式在内部复用 upstream `chrome-devtools-mcp` 的工具定义/处理器实现，而不修改或替换上游包的默认行为；独立二进制 MUST 继承 chrome-devtools-mcp 所有现有 CLI 选项（如 `--headless`、`--browser-url`、`--user-data-dir`、`--proxy-server`、`--isolated`、`--viewport`、分类开关等）。
- **FR-022**: 项目 MUST 更新 README / 文档，说明工具清单、`instanceId` 约定、`useCDP` 两种模式差异、鉴权克隆流程、与原 chrome-devtools-mcp 的兼容关系与差异。
- **FR-023**: 并行模式 MUST 与原 chrome-devtools-mcp 的可观测性（`usageStatistics`、`logFile`）一致：工具调用延迟、成功率等指标继续上报；新增管理工具 MUST 同样纳入统计。
- **FR-024**: 工具串行化策略 MUST 支持跨实例真正并行：原本的全局工具互斥 MUST 改为按 `instanceId` 粒度的互斥（同一实例内部串行，不同实例间并行），管理工具按整体互斥执行。
- **FR-025**: 代码实现 MUST 遵循仓库 TypeScript 约束：不使用 `any`、`as` 强制类型、`!` 断言、`@ts-ignore/@ts-nocheck/@ts-expect-error`；循环优先 `for..of`。

### Key Entities _(include if feature involves data)_

- **Instance**: 一次并行浏览器会话。属性包含 `instanceId`（用户命名）、`mode`（`cdp` 或 `launch`）、关联的浏览器/上下文引用、下载目录、上一帧快照缓存、可视角标注入状态。
- **AuthState**: 全局鉴权快照。包含 cookies（name/value/domain/path/expires/httpOnly/secure/sameSite）与 origins（按 origin 分组的 localStorage 键值对）。由 `browser_connect` 或 `instance_export_auth` 写入，`instance_create` 在 `cloneAuth=true` 时读取。
- **ConnectedBrowser**: 已通过 CDP 连接的用户浏览器。属性包含 `cdpUrl`、`browserType`（Chrome/Edge/Chromium）、可用标志；看门狗负责维持其活性；CDP 模式实例共享其进程。
- **Tool Registry**: 并行模式下对外暴露的工具集合，分两类：管理工具（固定 6 个）与 `page_*` 派生工具（数量与原 chrome-devtools-mcp 启用工具一一对应）。

## Success Criteria _(mandatory)_

### Measurable Outcomes

- **SC-001**: 用户可在同一 MCP 服务器内并发运行 ≥3 个实例，跨实例执行页面快照/点击等操作的平均耗时相比串行运行 3 个单实例方案下降 ≥40%。
- **SC-002**: 在 Chrome 已登录目标站点的前提下，从 `browser_connect` → `instance_create` → 打开同站点页面并看到已登录状态，首次完成流程的平均操作数 ≤3 次，耗时 ≤15 秒。
- **SC-003**: `page_*` 工具与对应原生工具在相同输入下的行为一致率 100%（除 `instanceId` 路由与快照增强差异外），回归测试覆盖至少 20 个代表性原生工具。
- **SC-004**: 在连续 30 分钟的长时运行压力下（持续创建/关闭实例、频繁调用 `page_*`），无未捕获异常、无僵尸浏览器进程、无下载目录泄漏；CDP 断连可在 ≤10 秒内自动恢复或明确提示用户。
- **SC-005**: 启用快照增强后，对典型业务页面（DOM ≥2000 节点）连续两次无重大变化的快照返回的文本长度下降 ≥50%；发生重大变化时仍可返回完整视图。
- **SC-006**: 新用户根据 README 即可在 5 分钟内跑通"连接已有 Chrome → 创建两个并行实例 → 并行完成两个任务"的基础流程。

## Assumptions

- 并行功能以独立 npm 包形式发布，复用 upstream chrome-devtools-mcp 的工具实现；既有单实例用户继续使用原包，不受影响；两个包可以并存安装。
- 用户的 Chrome/Edge 与 Node.js 版本满足 chrome-devtools-mcp 原本的要求（Node.js ≥ 18，Chrome 近似最新稳定版）。
- 多实例底层依赖 Puppeteer / chrome-devtools-mcp 已集成的浏览器驱动；无需引入 Playwright 作为运行时依赖，只迁移功能理念而非代码。
- CDP 模式下创建的"新 BrowserContext"以 Puppeteer 的 incognito/isolated 上下文实现，与 Playwright 的 `browser.newContext()` 在鉴权注入语义上保持对齐。
- 鉴权状态仅存在于服务器进程内存，用户负责自己的凭证安全；不新增持久化存储。
- 下载目录使用操作系统临时目录下的固定子路径（如 `chrome-devtools-mcp-parallel-downloads/<instanceId>`），进程退出时不强制清理旧文件，由系统临时目录策略处理。
- 可视角标通过在目标页面注入脚本实现；对 `about:` / `chrome:` / 跨域沙箱等特殊页面注入失败时静默忽略。
- 管理工具（`browser_connect` 等）不依赖 `instanceId`，与 `page_*` 工具一同注册；客户端 UI 的搜索/分组对此不做特殊要求。
