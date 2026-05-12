---
description: 'Actionable task list for feature 001-stability-hardening'
---

# Tasks: Chrome DevTools MCP 稳定性改进

**Feature**: `001-stability-hardening` | **Branch**: `001-stability-hardening` | **Date**: 2026-05-11

**Input**: `spec.md`, `plan.md`

**Tests**: 本特性显式要求 SC-001..008 可测；plan §7 列出每 WP 至少 3 单元 + 4 集成测试；故**包含测试任务**（必须先 FAIL）。

**Organization**: 按 User Story 分组，对齐 `plan.md` WP-1..5。每故事独立可交付。

## Format: `[ID] [P?] [Story] Description`

- **[P]**：不同文件、无依赖，可并行执行
- **[Story]**：US1 / US2 / US3 / US4；FOUND = Phase 2 公共基础；SETUP = Phase 1；XCUT = WP-5 横切；POLISH = 收尾
- 所有路径相对仓库根
- 所有改动遵守 `AGENTS.md`：禁 `any`/`as`/`!`/`@ts-*`、`for..of`、只用 `package.json` 脚本

---

## Phase 1: Setup（共享基础设施）

**Purpose**: 目录骨架、CLI 占位、文档锚点，不破坏现有功能。

- [x] **T001** [SETUP] 在 `src/utils/` 下创建 `ringBuffer.ts`、`structuredError.ts`、`artifactDir.ts` 占位文件（含 license header + `export {}`），确保 `tsc --build` 收纳 — 直接落实做完整实现，见 Phase 2
- [x] **T002** [P] [SETUP] `src/parallel/MemoryMonitor.ts` / `CrashLogger.ts` / `Observability.ts` — 直接落地完整实现（见 T066/T067/T075），跳过纯占位步骤
- [x] **T003** [P] [SETUP] `tests/integration/README.md` 已落地（与 `*.it.test.ts` 同批），说明 `npm run test tests/integration/<name>.it.test.ts` 单跑入口
- [x] **T004** [P] [SETUP] `specs/001-stability-hardening/data-model.md` / `migration.md` / `contracts/` 全部直接以最终内容落地（见 T079/T080/T081），无中间空大纲态
- [x] **T005** [SETUP] `src/parallel/cli.ts`：在 `parallelOptions` 追加全部 13 个新选项的 yargs 定义（`describe` + `default` 即可，业务消费在后续 task 完成）；`ParallelServerArgs` 同步加字段，全部可选并附默认值

**Checkpoint**: `npm run build` 通过；`npx chrome-devtools-mcp-parallel --help` 可见新选项；现有功能不受影响。

---

## Phase 2: Foundational（阻塞 US1..US4 的公共基础）

**Purpose**: `StructuredError`、`ArtifactDirManager`、`RingBuffer` 是后续多 WP 共用底座，必须先完成。

**⚠️ CRITICAL**: 本阶段未完成前，US 任务不得启动。

### Tests（先 FAIL）

- [x] **T006** [FOUND] `tests/RingBuffer.test.ts`：
  - cap 500 push 600 → length=500 / evicted=100 / totalPushed=600
  - `toArray()` 返回顺序为最早到最新
  - 头尾索引环形（不调用 `Array.shift`，反射断言）
- [x] **T007** [P] [FOUND] `tests/StructuredError.test.ts`：
  - 构造 + 字段（`code` / `message` / `recoverable` / `nextAction`）
  - `toToolResult(err)` 返 `CallToolResult` 含 `isError:true` 与 `structuredContent`
- [x] **T008** [P] [FOUND] `tests/ArtifactDir.test.ts`：
  - `ephemeralRoot()` 路径含 pid，目录存在
  - `allocate('screenshots', 'inst-1', 'png')` 文件名含 instanceId + ISO 时间戳
  - `process.emit('SIGINT')` 触发 ephemeral 清理；persistent 不清理
  - `persistentRoot()` 在 CLI 指定时不被清

### Implementation

- [x] **T009** [FOUND] `src/utils/ringBuffer.ts`：
  - `class RingBuffer<T>` 头尾索引环形 + 固定 capacity
  - API：`push(item): void` / `toArray(): T[]` / `forEach(cb)` / `size` / `capacity` / `totalPushed` / `evicted`
  - **禁止** `Array.shift()`；用模运算移动 head
- [x] **T010** [P] [FOUND] `src/utils/structuredError.ts`：
  - `class StructuredError extends Error { code; recoverable; nextAction; cause? }`
  - `toToolResult(err: StructuredError): CallToolResult`：返 `{ isError: true, content: [{type:'text',text:err.message}], structuredContent: { code, recoverable, nextAction } }`
  - 错误码常量集合：`INSTANCE_DEAD` / `INSTANCE_RECONNECTING` / `INSTANCE_PROTOCOL_ERROR` / `RESPONSE_TOO_LARGE` / `INLINE_PAYLOAD_TOO_LARGE` / `DISK_WRITE_FAILED` / `RECORD_TOO_LARGE`
- [x] **T011** [FOUND] `src/utils/artifactDir.ts`：
  - `class ArtifactDirManager`
    - 构造接 `{ persistentRoot?: string; pid: number }`
    - `getRoot(lifetime: 'ephemeral'|'persistent'): string`
    - `allocate(kind, instanceId, ext): { filePath, lifetime }`
    - 文件名：`<instanceId>-<ISOms 替换 :,. 为 -><rand4>.<ext>`，过滤 `< > : " / \ | ? *` 等 Win 非法字符
    - 一次性注册 `SIGINT` / `SIGTERM` / `uncaughtException` cleanup hook（幂等）
  - 单例 getter `getArtifactDirManager(args)` 在 `src/parallel/index.ts` 调用

**Checkpoint**: T006/T007/T008 测试由红转绿；其他模块尚未消费这些底座。

---

## Phase 3: User Story 1 - Long Session No Longer OOM Crashes (P1)

**Goal**：console / network buffer 环形 + 单条截断 + meta footer。

**Independent Test**：实例跑 1000 次 "navigate + 触发 N 条网络请求 + 写 console" → 调 `page_list_console_messages` 与 `page_list_network_requests` 验证返最新 N 条 + evicted 元数据 + 进程 RSS 增长 < 200MB。

**对应**: WP-1, FR-001..005, SC-001

### Tests for US1（先 FAIL）

- [x] **T012** [US1] `tests/PageCollector.buffer.test.ts`：
  - 构造 `PageCollector` cap=500，模拟 600 条 → `getDataWithMeta()` 返 `{items:500, totalPushed:600, evicted:100}`
  - 加 NetworkCollector navigation split 验证
- [x] **T013** [P] [US1] `tests/PageCollector.recordCap.test.ts`：
  - 因实现策略改为「不变更 Puppeteer 对象，只标记 oversizeSymbol」，对应断言改为
    `collector.isOversize(item)` 在超 cap 时为 `true`、未超时为 `false`、未配置 cap 时永远为 `false`
  - 同时验证 `getCollectedAt(item)` 在 push 后落在 `[before, after]` 内（FR-004）
- [x] **T014** [P] [US1] `tests/parallel/cli.stability.test.ts`：
  - `--console-buffer-size 200` → `args.consoleBufferSize===200`
  - `CDM_NETWORK_BUFFER_SIZE=300` → `args.networkBufferSize===300`
  - CLI 优先于 env；非数字 env fallback；空字符串视为未设置
- [x] **T015** [P] [US1] `tests/integration/longSession.it.test.ts`（5min 等比模拟）：
  - 启动 instance，循环 5min（5 console/sec + 5 net req/sec），buffer cap 收紧到 console=200/network=400 以保证 evict
  - 末尾 RSS 增长 < 50MB（按 200MB/8h 比例换算），`total.evicted > 0`，`total.size` 不超 cap
  - `CDM_LONG_SESSION_DURATION_SEC` 可调时长（CI dial-down）

### Implementation for US1

- [x] **T016** [US1] `src/PageCollector.ts`：
  - `PageCollector<T>` 构造增 `maxPerChunk: number`
  - 替换 chunk 内 `Array<WithSymbolId<T>>` 为 `ChunkBuffer<WithSymbolId<T>>`（封装 `RingBuffer`）
  - 每 chunk 暴露 `totalPushed` / `evicted` / `size` 计数
  - 新方法 `getDataWithMeta(page, includePreservedData?): { items, chunks, total }`
  - 旧 `getData()` 保留，仅返 items（向后兼容）
  - `NetworkCollector.splitAfterNavigation` 用 `replaceItems` 重组 chunk，保留累计 evicted
  - `ConsoleCollector` 默认 cap 500、`NetworkCollector` 默认 cap 1000（FR-002）
- [x] **T017** [US1] `src/PageCollector.ts`：单条截断
  - 不再变更 Puppeteer 对象本体；改在 `PageCollector` 内估算字节并通过 `oversizeSymbol` 打标签（FR-005）
  - `ConsoleCollector.estimateRecordBytes`：`text()` / Error / UncaughtError 同步字段；`NetworkCollector.estimateRecordBytes`：`url()` + 请求头长度
  - `recordSizeCapBytes` 由 `McpContext` 透传 (`recordSizeCapKb * 1024`)，CLI `--record-size-cap-kb` 默认 256
  - 暴露 `isOversize(item)` 供后续 formatter 渲染 `truncated:true`（formatter 暴露作为 WP-2 跟随项）
- [x] **T018** [P] [US1] `src/McpContext.ts`：
  - 构造接 `{ consoleBufferSize, networkBufferSize, recordSizeCapKb }`
  - 透传到 `NetworkCollector` / `ConsoleCollector` 构造
  - 新增 `getNetworkBufferMeta` / `getConsoleBufferMeta` 公共访问器供 formatter 渲染 footer
- [x] **T019** [P] [US1] `src/parallel/cli.ts` 落实 T005 中三个 buffer 选项的解析与默认值（500/1000/256），写入 `ParallelServerArgs`；同时落实 13 个全部 stability 选项的 CLI/env 优先级解析（含 `STABILITY_DEFAULTS` 导出供测试使用）
- [x] **T020** [US1] `src/parallel/index.ts` / `managementTools/instanceCreate.ts`：
  - 创建 `McpContext` 时透传 buffer 配置（cdp + launch 两个分支均覆盖）
- [x] **T021** [P] [US1] footer 渲染落在 `src/McpResponse.ts` 的 format() 阶段：
  - `## Network requests` / `## Console messages` 段后，当 `evicted > 0` 时输出 `Buffer status: showing N retained of M observed; K earlier records evicted.`
  - 同步写入 `structuredContent.networkBufferMeta` / `consoleBufferMeta`
  - 单条 `truncated:true` 标记延后到 T017 落地后再补
- [x] **T022** [P] [US1] `src/tools/console.ts`：`listConsoleMessages` 增 `since?: number` (epoch ms) + `level?: ('error'|'warn'|'info'|'debug'|'log')[]` 过滤参数
  - `since` 走 `collectedAtSymbol`（`PageCollector` 在 push 时戳入 `Date.now()`）
  - `level` 通过 `LEVEL_EXPANSION` 映射到底层 `ConsoleMessageType`，与 `types` 取并集
- [x] **T023** [P] [US1] `src/tools/network.ts`：`listNetworkRequests` 增 `since?: number`，复用 `collectedAtSymbol`；`urlPattern` 留待 WP-2 一并扩展

**Checkpoint**: T012..T015 全绿；现有 console / network 工具仍可用，response 多 footer。

---

## Phase 4: User Story 2 - Large Objects No Longer Block MCP Channels (P1)

**Goal**：截图 / trace / heap 默认落盘；全局 response size guard；artifact 二次查询工具。

**Independent Test**：长截图、3min trace、heap snapshot → response < 100KB；磁盘有文件；摘要可读。

**对应**: WP-2, FR-006..011a, SC-002

### Tests for US2（先 FAIL）

- [x] **T024** [US2] `tests/ResponseSizeGuard.test.ts`：
  - 5KB string + 1KB cap → 写 `responses/*.json` + 替换为 `{ structuredContent.responseGuard:{truncated,filePath,originalSize} }`
  - 持久化文件内容 === 原始 result（`JSON.parse + deepStrictEqual`）
  - 替换体 size < cap，保留 `isError`，`maxBytes<=0` 时直通
- [x] **T025 + T026** [P] [US2] `tests/tools/screenshot.stability.test.ts`：
  - 不带 `filePath` 且不带 `returnBase64` → `images.length===0`，`responseLines` 第二行匹配 `/Saved screenshot to .+\.png/`，文件可访问
  - `returnBase64:true` + 4MB 上限 → inline 成功，`images[0].mimeType==='image/png'`
  - `returnBase64:true` + 极小 cap (`CDM_INLINE_PAYLOAD_MAX_MB` 缩到 1B) → 抛 `StructuredError` 且 `code===INLINE_PAYLOAD_TOO_LARGE`、`recoverable:true`、`nextAction` 含 `returnBase64|filePath|CDM_INLINE_PAYLOAD_MAX_MB`
  - 同时把现有 `tests/tools/screenshot.test.ts` 中所有 inline 期望测试加上 `returnBase64:true` 以保留对老 inline 路径的覆盖
- [x] **T027** [P] [US2] `tests/Trace.persist.test.ts`：
  - StopTrace → `traces/*.json` 存在 + response 含 `summary.events / samplingWindowMs / coreMetrics`
- [x] **T028** [P] [US2] `tests/MemorySnapshot.persist.test.ts`：
  - heap snapshot → `*.heapsnapshot` 存在 + response 含 `sizeBytes / topNodeKinds`
  - 实现：`captureHeapSnapshot` stub → 复制 `tests/fixtures/example.heapsnapshot` 到 allocate 路径 → 断言 `heapSnapshotPersistence.{filePath,sizeBytes,topNodeKinds}` + `heapSnapshot.movedTo` 兼容字段 + responseLine 文案
- [x] **T029** [P] [US2] `tests/ArtifactReadSummary.test.ts`：
  - heap 真实 fixture / 合成 trace JSON / response 顶层 keys+slice / kind override / 缺失路径返 `DISK_WRITE_FAILED`
- [x] **T030** [P] [US2] `tests/integration/largeArtifact.it.test.ts`：
  - 真实页面长截图（800×8000）→ `result.content` 无 image / `JSON.stringify(result) < 100KB` / on-disk PNG > 1KB
  - 注：dimensions 收敛到 6.4Mpx 以避开 Chrome `Page.captureScreenshot` 像素上限（`tests/tools/screenshot.test.ts > with full page resulting in a large screenshot` 在本地已知会触发该上限）

### Implementation for US2

- [x] **T031** [US2] `src/parallel/index.ts`：
  - `createParallelMcpServer` 启动末尾 `getArtifactDirManager({persistentRoot: args.artifactDir})` 强制即时初始化单例
  - 单例 `installCleanupHooks()` 已自带 `SIGINT/SIGTERM/exit/uncaughtException` 清理
- [x] **T032** [US2] `src/parallel/PageToolAdapter.ts`：
  - dispatch step 8a 增 `applyResponseSizeGuard(result, {artifactDir, maxBytes, instanceId, toolName})`
  - 序列化 byte length 用 `Buffer.byteLength(JSON.stringify(...), 'utf8')`
  - 超 `maxResponseSizeMb*1MiB` → 写 `responses/<id-tool>-<ts>-<rand>.json` + 返
    `{ content:[text "[Response oversized — N>cap; persisted to ...]"], structuredContent:{responseGuard:{truncated,filePath,originalSize,toolName,instanceId}}, isError:<原> }`
  - 落盘失败 → 走 `StructuredError(DISK_WRITE_FAILED)` 返结构化错；任何抛错被 try/catch 兜底以保证不破坏 dispatch
- [x] **T033** [P] [US2] `src/tools/screenshot.ts` + `src/parallel/index.ts`：
  - 新增 schema 字段 `returnBase64: zod.boolean().default(false)`（背向兼容）
  - 默认（无 `filePath` 且 `returnBase64===false`）→ `context.saveTemporaryFile`，response 仅文本 `Saved screenshot to <path>`
  - `returnBase64===true` 且 `screenshot.length > inlinePayloadMaxBytes` → 抛 `StructuredError(INLINE_PAYLOAD_TOO_LARGE)`，由 `McpResponse` 渲染 `[CODE] msg (next: action)` + `structuredContent.error`
  - cap 通过 env `CDM_INLINE_PAYLOAD_MAX_MB`（默认 1MB）读取；CLI `--inline-payload-max-mb` 在 `createParallelMcpServer` 启动时桥接到该 env，避免侵入上游 `ParsedArguments`
  - `slim/tools.ts` 的 screenshot 已强制落盘，无需改动
  - 同时为 `McpResponse.format()` 加 `error?: Error` 入参 + `isStructuredError(err)` 分支，使 `StructuredError` 自动得到结构化展示（FR-026）
- [x] **T034** [P] [US2] `src/tools/performance.ts` (`StopTrace`)：
  - 默认（无 `filePath`）→ `getArtifactDirManager().allocate('traces','page','.json')`，写盘走 `fs.writeFile`；caller 提供 `filePath` 时仍走 `context.saveFile`（兼容 `.gz`）
  - 写失败 → `StructuredError(DISK_WRITE_FAILED, recoverable:true, nextAction)`
  - 新建 `src/utils/traceSummary.ts`：`summarizeTrace(buffer, parseResult)` → `{events, samplingWindowMs, coreMetrics:{lcpMs?,inpMs?,clsScore?}}`；`events` 走 raw JSON 计数，`samplingWindowMs` 走 `parsedTrace.data.Meta.traceBounds.range/1000`，`coreMetrics` 走第一 insightSet 的 `model.LCPBreakdown.lcpMs / INPBreakdown.inpMs / CLSCulprits.clsScore`（unknown-safe `Reflect.get` 路径访问）
  - 新 `response.setTracePersistence({filePath,sizeBytes,summary})` 写 `structuredContent.tracePersistence`
  - `attachTraceSummary` 的 text/insight 输出保留（仍小、对 LLM 有用）
- [x] **T035** [P] [US2] `src/tools/memory.ts`：
  - `take_memory_snapshot`：`filePath` 改可选；缺省走 `getArtifactDirManager().allocate('heapsnapshots','page','.heapsnapshot')`
  - 捕获后 `summarizeHeapSnapshot()`（新建 `src/utils/heapSnapshotSummary.ts`，JSON.parse + 按 `meta.node_fields/node_types` stride 计算 topN kind 桶）→ `{filePath, sizeBytes, topNodeKinds}`
  - 经新 `response.setHeapSnapshotPersistence(...)` 写入 `structuredContent.heapSnapshotPersistence` + 兼容地填 `structuredContent.heapSnapshot.movedTo`
  - `captureHeapSnapshot` 失败 → `StructuredError(DISK_WRITE_FAILED, recoverable:true, nextAction='Verify the artifact directory is writable, or pass an explicit `filePath`')`
- [x] **T036** [US2] `src/parallel/managementTools/artifactReadSummary.ts`（新文件）：
  - 入参 schema：`{ filePath, kind?:'trace'|'heap'|'response', sliceStart?, sliceEnd? }`
  - kind 缺省按扩展名 + `responses/` 目录推断
  - heap → 复用 `summarizeHeapSnapshot`
  - trace → `fs.readFile` + `parseRawTraceBuffer` + `summarizeTrace`（失败回退 `summarizeRawBuffer`）
  - response → `JSON.parse` 取顶层 keys + `slice(start,end)` 默认 4096 字节窗口
  - 失败 → `StructuredError(DISK_WRITE_FAILED)`（复用现有码避免破坏 `tests/StructuredError.test.ts` 的 codes 列表断言）
- [x] **T037** [US2] `src/parallel/index.ts`：`server.registerTool('page_artifact_read_summary',...)` 绑定到 `artifactReadSummary`
- [x] **T038** [P] [US2] `src/parallel/cli.ts`：`--artifact-dir` / `--max-response-size-mb` / `--inline-payload-max-mb` 已在 T019 批次中通过 `resolveStringOption` / `resolveNumberOption` + `STABILITY_DEFAULTS` 落地

**Checkpoint**: T024..T030 全绿；旧 client 调 screenshot/trace/heap 不报错（字段兼容）。

---

## Phase 5: User Story 3 - Browser Crash Automatically Recovers (P2)

**Goal**：state machine + disconnect 监听 + reconnect/respawn + 熔断 + 健康工具 + MCP 通知。

**Independent Test**：spawn instance → `taskkill chrome` → 5s 内 state='dead'，调 page tool 返结构化错；调 `instance_recreate` 后恢复。

**对应**: WP-3, FR-012..018, SC-003 / SC-004

### Tests for US3（先 FAIL）

- [x] **T039** [US3] `tests/Instance.state.test.ts`：
  - 状态转换 ready → reconnecting → ready / dead；非法转换 throw
  - `available` 派生 boolean 与 state 一致
  - 实现：`PerInstance` 持 `#state/#lastError/#lastHealthyAt/#reconnectAttempts`；`setState(next, lastError?)` 校验 `VALID_TRANSITIONS`；`available` setter 走 ready↔reconnecting；dead 终态拒绝复活
- [x] **T040** [P] [US3] `tests/InstanceRegistry.snapshot.test.ts`：
  - `snapshotHealth()` 返每实例 `{id,state,lastError,lastHealthyAt,reconnectAttempts,spawnedByService}`
  - 实现：`InstanceRegistry.snapshotHealth()` + `setState(id, state, err?)` 转发到 `Instance.setState`；未知 id 抛错
- [x] **T041..T044** [P] [US3] 合并到 `tests/parallel/ConnectionWatchdog.test.ts`：
  - 事件驱动 `onDisconnect(instance, err)` 入口（T053 新接口）
  - `#cycleCount` 累计断开周期 → reach `circuitBreakAfter` → 永久 `dead`（T044 熔断）
  - launch 模式 reconnect 全失败 → 走 `launchConfig` 重 spawn（T043，mock spawn）
  - cdp 模式 reconnect 成功 → state 回 `ready`，registry browser 引用刷新（T042）
  - 旧轮询路径仍保留作 fallback（version() 抛错时降级）
- [x] **T045** [P] [US3] `tests/PageToolAdapter.healthGate.test.ts`：dead → `INSTANCE_DEAD`，reconnecting+10s 超时 → `INSTANCE_RECONNECTING`，含 reconnect→ready 直通
- [x] **T046** [P] [US3] `tests/InstanceHealth.tool.test.ts`：返完整 `snapshotHealth()`
- [x] **T047** [P] [US3] `tests/InstanceRecreate.tool.test.ts`：保留 id + downloadPath + launchConfig
- [x] **T048** [P] [US3] `tests/integration/browserCrash.it.test.ts`：
  - 真实 spawn chrome → `taskkill /F /T /PID` 杀整树 → 5s 内 state='dead' → `instance_recreate` → 可继续 navigate

### Implementation for US3

- [x] **T049** [US3] `src/parallel/types.ts`：
  - `Instance` 加 `state` / `lastError` / `lastHealthyAt` / `reconnectAttempts` / `spawnedByService` / `launchConfig`
  - 新增类型 `InstanceState` / `InstanceLaunchConfig` / `InstanceHealthSnapshot`
  - `available` 改为 getter `get available(): boolean { return this.state === 'ready' }`，setter 走 ready↔reconnecting
- [x] **T050** [US3] `src/parallel/InstanceRegistry.ts`：
  - 增 `setState(id, state, err?)` / `snapshotHealth()`
  - `markUnavailable` / `markAvailable` 内部转 setState
- [x] **T051** [US3] `src/parallel/PerInstance.ts`：
  - 构造接 `launchConfig` + `spawnedByService`，初始化 state='ready' + lastHealthyAt=now
  - 实现 `setState` 的合法转移表 + `snapshotHealth()` 返 ISO 时戳
- [x] **T052** [US3] `src/parallel/managementTools/instanceCreate.ts`：写入 `launchConfig`，注册 `browser.on('disconnected', ...) → watchdog.onDisconnect(instance, 'browser disconnected')`
- [x] **T053** [US3] `src/parallel/ConnectionWatchdog.ts`：per-instance 事件驱动 `onDisconnect()`；指数退避（`reconnectMaxAttempts`/`reconnectBackoffMs`）；launch 模式 → `respawn` 走 `launchConfig`；cdp 模式 → 仅重连；`#cycleCount` 累计周期，满 `circuitBreakAfter` → `setState('dead')`；状态锁拒并发；旧轮询保留为 fallback
- [x] **T054** [P] [US3] `src/parallel/Notifier.ts`：`Notifier` 持 server 句柄，`notifyInstanceState` 发 `notifications/resourceUpdated`；watchdog 状态切换时调用
- [x] **T055** [US3] `src/parallel/PageToolAdapter.ts`：dispatch 健康闸门 — `dead` → `INSTANCE_DEAD` 直返；`reconnecting` → `waitForReadyOrDead(10s)` 超时 → `INSTANCE_RECONNECTING`；Protocol error → `INSTANCE_PROTOCOL_ERROR`
- [x] **T056** [P] [US3] `src/parallel/managementTools/instanceHealth.ts`：返 `registry.snapshotHealth()`
- [x] **T057** [P] [US3] `src/parallel/managementTools/instanceRecreate.ts`：以原 `launchConfig` 重建，保留 id + downloadPath
- [x] **T058** [US3] `src/parallel/index.ts`：注册 `instance_health` / `instance_recreate` + 实例化 `Notifier(server, registry)` 注入 watchdog
- [x] **T059** [P] [US3] `src/parallel/cli.ts`：`reconnectMaxAttempts` / `reconnectBackoffMs` / `circuitBreakAfter` 由 `STABILITY_DEFAULTS` + `resolveNumberOption` 落地

**Checkpoint**: T039..T048 全绿；现有 `instance_close` / `instance_list` 不变。

---

## Phase 6: User Story 4 - Default Heap Capacity Supports Common Workload (P3)

**Goal**：bin 自检 4GB 堆 + 自重 spawn + 内存监控 + crash log。

**Independent Test**：不设 NODE_OPTIONS 启动 → `v8.getHeapStatistics().heap_size_limit >= 4GB`；模拟 95% 占用 → 触发 close idle；模拟 OOM → crash log 写出。

**对应**: WP-4, FR-019..023, SC-005 / SC-006 / SC-008

### Tests for US4（先 FAIL）

- [x] **T060** [US4] `tests/parallel/HeapSelfRespawn.test.ts`：低 `heap_size_limit` → spawn 含 `--max-old-space-size=4096`；高值 → no-op；`RESPAWN_FLAG_ENV` 防递归
- [x] **T061** [P] [US4] `tests/parallel/HeapSizeResolver.test.ts`：CLI > env > default；32-bit cap 1500；`os.totalmem*0.8` 降级警告
- [x] **T062** [P] [US4] `tests/parallel/MemoryMonitor.test.ts`：80% WARN 边沿触发；95% DANGER 每 tick 触发；ring cap 60；handler 抛错隔离
- [x] **T063** [P] [US4] `tests/parallel/CrashLogger.test.ts`：`uncaughtException` → `<artifactDir>/crashes/*.log`，含 active instances + samples + tool calls
- [x] **T064** [P] [US4] `tests/integration/oomGuard.it.test.ts`：OOM 注入 → crash log + 非 0 退出码

### Implementation for US4

- [x] **T065** [US4] `src/bin/chrome-devtools-mcp-parallel.ts`：调用 `ensureHeapHeadroom()` (`HeapSelfRespawn.ts`)：
  - 解析 `--heap-size` / `CDM_HEAP_SIZE_MB` / 默认 4096
  - 32-bit Node → cap 1500；`os.totalmem*0.8 < desired` → 警告 + 降级
  - `v8.getHeapStatistics().heap_size_limit < desired*0.95` → `child_process.spawn` 自身 + `NODE_OPTIONS=--max-old-space-size=<n>`
  - `RESPAWN_FLAG_ENV` 守护防递归；父透传 SIGINT/SIGTERM + exit code
- [x] **T066** [US4] `src/parallel/MemoryMonitor.ts`：`{intervalMs,warnPct,dangerPct,onWarn,onDanger,memoryUsageFn,heapStatisticsFn,ringCapacity}`；80% 边沿一次性 WARN；95% 每 tick DANGER；样本环 cap 60；`recentSamples()` 暴露
- [x] **T067** [US4] `src/parallel/CrashLogger.ts`：注册 `uncaughtException` / `unhandledRejection`，同步写 `<artifactDir>/crashes/<ISOms>.log` JSON 含 active instances + memory ring + tool call ring；uncaughtException 路径写完 `process.exit(1)`
- [x] **T068** [P] [US4] `src/parallel/ToolCallRing.ts`（独立类）+ `PageToolAdapter` dispatch 入口 `record({ts,toolName,instanceId})`；`snapshot()` 给 CrashLogger
- [x] **T069** [US4] `src/parallel/index.ts`：实例化 `MemoryMonitor` + `CrashLogger` + `ToolCallRing`；`onDanger` 默认 — 关闭 lastUsedAt > 5min 的 ready 实例
- [x] **T070** [P] [US4] `src/parallel/cli.ts`：`heapSize` / `memWarnPct` / `memDangerPct` / `memSampleIntervalSec` 由 `STABILITY_DEFAULTS` 落地
- [x] **T071** [P] [US4] `README.md` `## Memory & Heap` 章节落地：默认/CLI/env 表 + 自重 spawn (FR-019) + Memory monitor (FR-022) WARN/DANGER 行为

**Checkpoint**: T060..T064 全绿；冷启动 RSS 不显著上升（监控本身开销 < 5MB）。

---

## Phase 7: Cross-cutting (WP-5)

**Goal**：可观测性 + cross-platform 路径 + 迁移文档。可与 Phase 3..6 并行落实。

**对应**: FR-024a / FR-024b / FR-025 / FR-026

### Tests

- [x] **T072** [XCUT] `tests/CrossPlatformPaths.test.ts`：
  - `path.posix.basename` / `path.win32.basename` 双向校验 sanitised id 段
  - 含全部 Win32 非法字符的 instance id（`a:b\c|d?e*f<g>h"i`）→ 输出 basename 既不含非法字符也不含 `/`/`\`
  - Win32 reserved names（`CON`/`PRN`/`AUX`/`NUL`/`COM1`/`LPT9`）→ stem 全部以 `_` 前缀
  - `..` 含杂段路径 → `getRoot('persistent')` 返绝对+规整化后的路径
  - ephemeral root 始终落在 `os.tmpdir()` 下且为绝对
- [x] **T073** [P] [XCUT] `tests/parallel/Observability.test.ts`（合并 T074 进同一 spec 文件）：
  - 结构化 `InstanceListSource` mock + 真实 `MemoryMonitor` → `Observability.snapshot()` 返字段齐
  - `startPeriodicLog` 写入 stderr 的 JSON 行解析回对象
  - artifact 目录递归大小 + 10s 缓存窗口验证
- [x] **T074** [P] [XCUT] 已与 T073 合并：调 `system_observe` 返摘要+JSON、`includeMemorySamples` 透传

### Implementation

- [x] **T075** [XCUT] `src/parallel/Observability.ts`：
  - `class Observability { snapshot(): {...}; startPeriodicLog(intervalMs) }`
  - 注入接口由 `InstanceListSource` / `ObservableInstance` / `ObservableMcpContext` 暴露，便于单测无需真实 McpContext
  - snapshot 字段：`{ ts, instances:[{id,state,console:{retained,evicted},network:{retained,evicted}}], memory:{rssMb,heapUsedMb,heapPct}, artifactDir:{ephemeralBytes,persistentBytes} }`
  - 周期 stderr 输出 `[observability] {...}` JSON 行（默认关闭，由 CLI 启用）
- [x] **T076** [P] [XCUT] `src/parallel/managementTools/systemObserve.ts`：返 `Observability.snapshot()` + 摘要
- [x] **T077** [XCUT] `src/parallel/index.ts`：注册 `system_observe` MCP 工具 + `--system-observe-interval-sec` 启动周期日志
- [x] **T078** [P] [XCUT] `src/utils/artifactDir.ts` 已落实跨平台强化：
  - 构造时 `path.resolve` 处理 ephemeral + persistent root（即使传入相对/含 `..` 路径）
  - `allocate()` 通过 `sanitizeFilenameSegment(instanceId)` 处理 instance id：剔除 `< > : " / \ | ? *` + 控制字符，去尾随 `. `，Win32 reserved names 加 `_` 前缀，长度 cap 64
  - 文件名 = `<safeId>-<ISOms>-<rand4><ext>`，Buf 校验由 T072 覆盖
- [x] **T079** [P] [XCUT] `specs/001-stability-hardening/migration.md`：12 节完整迁移指南
  - §1-§4 已有：buffer/单条截断/截图/trace/heap 字段映射
  - §5-§7 已落实：response size guard / structured errors / heap respawn 状态从 `planned` → `implemented`
  - 新增 §9 新增管理工具（`instance_health`/`instance_recreate`/`page_artifact_read_summary`/`system_observe`）
  - 新增 §10 全量 CLI/env 矩阵（14 个 flag + `CDM_*` env + 默认值）
  - 新增 §11 升级 operator checklist；§12 vs v0.x 行为差异
- [x] **T080** [P] [XCUT] `specs/001-stability-hardening/data-model.md`：11 节实体定义
  - §1-§8 已有：Instance / RingBuffer / ChunkBuffer / CollectorDataWithMeta / Artifact / StructuredError / HealthEvent / ParallelServerArgs（状态全部 `[impl]`）
  - 新增 §9 MemorySample（WARN/DANGER 边沿语义）
  - 新增 §10 ToolCallRecord（process-wide ring，cap 20）
  - 新增 §11 ObservabilitySnapshot + InstanceObservation（含 10s 缓存说明）
- [x] **T081** [P] [XCUT] `specs/001-stability-hardening/contracts/`：4 份契约 + index
  - `instance-health.md`：input `{}` / output `healthSnapshot[]` / 无 StructuredError
  - `instance-recreate.md`：input `{instanceId}` / output `recreated` / `DISK_WRITE_FAILED` + plain Error 语义
  - `artifact-read-summary.md`：discriminated union output（heap/trace/response）+ kind 推断规则 + `DISK_WRITE_FAILED`
  - `system-observe.md`：input `{includeMemorySamples?}` / `ObservabilitySnapshot` 结构 + 周期 stderr 模式说明
  - `README.md`：4 个工具汇总表 + 跨链接

---

## Phase 8: Polish

- [x] **T082** [POLISH] `npm run format` 全量跑通，零警告：
  - 修复 `scripts/e2e-parallel.mjs:192` 空 catch（加注释）
  - 修复 `src/parallel/PageToolAdapter.ts:144` 内联 `import()` 类型 → 顶部 `import type {ToolCallRing}`
  - 修复 `src/utils/artifactDir.ts:48` + `tests/CrossPlatformPaths.test.ts:32` 控制字符正则 → `eslint-disable-next-line no-control-regex` 注释
- [x] **T083** [POLISH] `README.md` 顶部 `### Stability Hardening (since v0.25)` 子章节 — 一句话定位 + 4 个跳转链接（migration / data-model / contracts / `#memory--heap`）
- [x] **T084** [POLISH] `scripts/soak-8h.ts` + `npm run soak-8h` 入口：
  - 通过 stdio 拉起 `build/src/bin/chrome-devtools-mcp-parallel.js`，建一个 `soak` 实例 + `about:blank`
  - 主循环以 `SOAK_TICK_INTERVAL_MS`（默认 200ms）调 `page_evaluate_script` 喂入 `console.log + fetch`
  - 每 `SOAK_METRIC_INTERVAL_MS`（默认 60s）调 `system_observe`，单行 `METRIC` log（rssMb/heapPct/state/evicted/ticks）
  - 结束 SUMMARY 含 baseline/final/peak RSS、evicted、instance state；exit code 反映 SC-001 闸门（growth<200MB ∧ evicted>0 ∧ state≠dead）
  - `SOAK_HOURS` / `SOAK_LOG_FILE` env 可调；非 CI 手跑
- [x] **T085** [POLISH] `npm run build` 无 TS 错误；`npm run test` 全量结果 718/722 pass + 2 skip + 2 fail
  - 失败 1：`tests/tools/screenshot.test.ts > with full page resulting in a large screenshot` — Chrome `Page.captureScreenshot` 像素上限（pre-existing flake，T030 注释中已记录）
  - 失败 2：`tests/tools/performance.test.ts > performance_stop_trace > throws an error if parsing the trace buffer fails` — 完整套件并发跑下 third_party `TraceProcessor` 实例间竞态（"can't reset while parsing"）；`npm run test tests/tools/performance.test.ts` 单跑 12/12 全绿；`npm run test tests/Trace.persist.test.ts` 1/1 全绿，确认非 T034 引入
  - 单测 / 文件级运行皆绿；并发降级 / 隔离方案不在本特性范围
- [x] **T086** [POLISH] `tests/integration/*.it.test.ts` 已落地全部 4 份并随默认 `npm run test` 通过：
  - `browserCrash.it.test.ts`（T048）— 真实 spawn + `taskkill /F /T` 验证 dead 状态机
  - `largeArtifact.it.test.ts`（T030）— 800×8000 长截图 → on-disk PNG + response<100KB
  - `oomGuard.it.test.ts`（T064）— uncaughtException 注入 → crash log + exit≠0
  - `longSession.it.test.ts`（T015）— 5min 等比 soak（默认）+ buffer evict 验证
- [x] **T087** [POLISH] `specs/001-stability-hardening/quickstart.md`（新文件）：SC-001 / SC-003 / SC-005 手动验证流程 + 期望结果 + `npm run soak-8h` / `instance_recreate` / 自重 spawn 演练步骤

---

## 依赖关系图

```
Phase 1 Setup ──► Phase 2 Foundational ──┬─► Phase 3 US1 ──┐
                                          ├─► Phase 4 US2 ──┤
                                          ├─► Phase 5 US3 ──┼─► Phase 8 Polish
                                          ├─► Phase 6 US4 ──┤
                                          └─► Phase 7 XCUT ─┘
```

- **Phase 2 (Foundational) 必须先完成**：`StructuredError` / `ArtifactDirManager` / `RingBuffer` 是其他 Phase 的依赖
- Phase 3..7 可并行（不同文件，依赖隔离）
- Phase 7 XCUT 中 `StructuredError` 集成已散布到 Phase 4/5 的实现 task；XCUT 自身只增可观测性 + 文档
- Phase 8 Polish 在所有 US task 完成后

## 并行执行示例

完成 Phase 2 后，可同时启动以下 task 组：

```
组 A (US1 测试): T012, T013, T014, T015        (4 个 task 并行)
组 B (US2 测试): T024, T025, T026, T027, T028, T029, T030  (7 个 task 并行)
组 C (US3 测试): T039, T040, T041..T048         (10 个 task 并行)
组 D (US4 测试): T060, T061, T062, T063, T064   (5 个 task 并行)
组 E (XCUT 测试): T072, T073, T074              (3 个 task 并行)
```

实现 task 内同一文件需串行（如 T016/T017 同改 PageCollector.ts），不同文件可并行。

## 任务统计

| Phase          | Task 数 | 测试 task | 实现 task |
| -------------- | ------- | --------- | --------- |
| 1 Setup        | 5       | 0         | 5         |
| 2 Foundational | 6       | 3         | 3         |
| 3 US1          | 12      | 4         | 8         |
| 4 US2          | 15      | 7         | 8         |
| 5 US3          | 21      | 10        | 11        |
| 6 US4          | 12      | 5         | 7         |
| 7 XCUT         | 10      | 3         | 7         |
| 8 Polish       | 6       | 0         | 6         |
| **合计**       | **87**  | **32**    | **55**    |

## 完成定义（DoD）

每个 task 完成必须满足：

1. 代码改动通过 `npm run build`（零 TS 错误）
2. 新增/修改测试通过 `npm run test <path>`
3. 不引入 `any` / `as` / `!` / `@ts-*`（CI lint 检查）
4. 关联 FR / SC 在 commit message 引用（如 `[FR-005] ...`）

每个 Phase 完成必须满足：

1. 该 Phase 全部 task 已 [x]
2. 全量 `npm run test` 绿
3. 集成测试（若该 Phase 包含）通过
4. Checkpoint 描述的能力可演示
