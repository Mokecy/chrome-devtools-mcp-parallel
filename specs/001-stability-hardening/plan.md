# Implementation Plan: Chrome DevTools MCP Stability Hardening

**Spec**: [spec.md](./spec.md)
**Branch**: `001-stability-hardening`
**Created**: 2026-05-11
**Status**: Draft

## 1. Overview

Spec 定义四块稳定性改造（buffer / artifact / self-heal / heap）。本 plan 把 FR 拆成可独立合入的工程包，按 P1 → P3 顺序，**每包都能单独 ship**。所有改动遵守 `AGENTS.md`：禁 `any`/`as`/`!`/`@ts-*`、用 `for..of`、只用 `package.json` 脚本。

## 2. 现状摸底（影响设计）

| 模块                     | 关键文件                                        | 现状                                                                                                               |
| ------------------------ | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Console / Network buffer | `src/PageCollector.ts`                          | 已按 page + navigation chunk 存（默认保留 3 段 navigation），**chunk 内无上限**                                    |
| Tool dispatch            | `src/parallel/PageToolAdapter.ts`               | 已有 55s soft timeout + heavy payload hint，但无 response size 拦截                                                |
| Instance registry        | `src/parallel/InstanceRegistry.ts` + `types.ts` | 已有 `available` 布尔 + `markUnavailable/markAvailable`，**无状态机/lastError/重建配置**                           |
| 自愈                     | `src/parallel/ConnectionWatchdog.ts`            | 已有轮询 + 3 次指数退避 reconnect（仅对 cdp 模式），**无 `disconnected` 事件订阅、无 launch 模式重 spawn、无熔断** |
| Screenshot               | `src/tools/screenshot.ts`                       | 已有 2MB → `saveTemporaryFile` 兜底，`filePath` 仍可选                                                             |
| Trace / Heap             | `src/tools/performance.ts` / `memory.ts`        | 走 inline / context cache，无统一 artifact 路径                                                                    |
| 入口                     | `src/bin/chrome-devtools-mcp-parallel.ts`       | 仅做 Node 版本检查，**无 heap 自检 / 内存采样 / crash log**                                                        |
| CLI                      | `src/parallel/cli.ts`                           | 已支持 yargs，可平滑加新选项                                                                                       |

**关键事实**：`PageCollector` 是 per-page、navigation 切段，spec 写 "per instance" 是粗粒度；plan 落地为 **per-page chunk 上限**（保留现有 navigation 切段语义），instance 层在响应里聚合 metadata。这点要在 `data-model.md` 标注，避免 spec 误读。

## 3. 架构变化

```
┌────────────────────── bin entry ──────────────────────┐
│  heap self-check → re-spawn child if needed           │  (US4)
│  install OOM hook + crash log writer                  │
└────────────────────────────┬──────────────────────────┘
                             │
┌────────────────────────────▼──────────────────────────┐
│  parallel/index.ts createParallelMcpServer            │
│  + ArtifactDir manager (ephemeral / persistent)       │  (US2)
│  + MemoryMonitor (60s sampler)                        │  (US4)
│  + ResponseSizeGuard middleware                       │  (US2)
└────────────────────────────┬──────────────────────────┘
                             │
        ┌────────────────────┼────────────────────┐
        │                    │                    │
┌───────▼────────┐  ┌────────▼─────────┐  ┌───────▼──────────┐
│ PageCollector  │  │ InstanceRegistry │  │ PageToolAdapter  │
│ + RingBuffer   │  │ + HealthState    │  │ + health gate    │
│ + per-rec cap  │  │ + lastError /    │  │ + structured err │
│ (US1)          │  │   reconnectAttr. │  │ + size guard hook│
│                │  │ (US3)            │  │ (US2 + US3)      │
└────────────────┘  └────────┬─────────┘  └──────────────────┘
                             │
                    ┌────────▼─────────┐
                    │ ConnectionWatchdog│
                    │ + disconnect evt  │
                    │ + launch respawn  │
                    │ + circuit breaker │
                    │ (US3)             │
                    └───────────────────┘
```

## 4. Work Packages（按 P 排序，可并行细分）

### WP-1 Buffer & Log Management — P1（FR-001..005）

**目标**：`PageCollector` 加环形上限 + 单条截断 + metadata。

**改动**：

- `src/PageCollector.ts`
  - 给 `PageCollector<T>` 增 `maxPerChunk: number` 构造参数（console 默认 500，network 默认 1000）
  - chunk 写入入口（`collect` 回调）超限时丢最早，**禁用 `Array.shift()`**：用头/尾索引环形结构（新增 `RingBuffer<T>` in `src/utils/ringBuffer.ts`）
  - 每 chunk 维护 `totalSeen` / `evicted` 计数
  - `getData` 返回时附 `{ items, retained, totalSeen, evicted }` 结构（新接口 `getDataWithMeta`，旧 `getData` 保留向后兼容）
- `src/utils/ringBuffer.ts`（新文件）
  - 头尾索引 + 固定 capacity；`push/forEach/toArray/size/totalPushed/evicted`
- `src/PageCollector.ts` 加单条 size 估算（JSON.stringify 长度 + 已知字段累加；console 用 message text len 近似；network 用 url + headers + bodySize）
  - 超 `maxRecordBytes`（默认 256 KB）→ 改为占位对象 `{ truncated: true, originalSize, head: '<前 N 字节>' }`
- `src/McpResponse.ts` / `src/formatters/{ConsoleFormatter,NetworkFormatter}.ts`
  - 渲染时，若 chunk meta `evicted > 0` → 输出 footer：`Showing latest <retained>/<totalSeen>; <evicted> earlier records evicted.`
  - Network filter（`urlPattern` / `resourceType`）已有；console 加 `since`（time range）+ `level` 过滤
- `src/parallel/cli.ts`
  - `--console-buffer-size` (env `CDM_CONSOLE_BUFFER_SIZE`)
  - `--network-buffer-size` (env `CDM_NETWORK_BUFFER_SIZE`)
  - `--record-size-cap-kb` (env `CDM_RECORD_SIZE_CAP_KB`)
- `ParallelServerArgs` 加 `consoleBufferSize`/`networkBufferSize`/`recordSizeCapKb`，传到 `McpContext` 构造

**测试**：

- `tests/RingBuffer.test.ts`：push 600 cap 500 → length 500 + evicted 100 + totalPushed 600
- `tests/PageCollector.buffer.test.ts`：模拟 600 console 消息 → getDataWithMeta 返最新 500 + evicted=100
- `tests/PageCollector.recordCap.test.ts`：单条 1MB string → 写入后 `truncated=true` + originalSize 正确
- `tests/cli.bufferOptions.test.ts`：CLI / env 解析

**验收映射**：FR-001..005 / SC-001 / Edge "Extreme Long Lifecycle" + "Single Extremely Large Record"

---

### WP-2 Artifact Persistence & Response Size Guard — P1（FR-006..011a）

**目标**：所有大产物默认落盘，response 走全局 size guard。

**改动**：

- `src/utils/artifactDir.ts`（新文件）
  - `class ArtifactDirManager`
    - `ephemeralRoot()`：`os.tmpdir()/chrome-devtools-mcp/<pid>/`，进程退出（SIGINT/SIGTERM/uncaughtException）清理
    - `persistentRoot()`：CLI 指定，never auto-clean
    - `allocate(kind: 'screenshots'|'traces'|'heapsnapshots'|'responses', instanceId, ext)` → 返回 `{ filePath, lifetime }`，文件名格式 `<instanceId>-<ISOms>-<rand>.<ext>`，跨平台合法字符过滤
  - 注册全局 cleanup hook（一次性，幂等）
- `src/parallel/cli.ts`
  - `--artifact-dir <path>`（env `CDM_ARTIFACT_DIR`）→ 设为 persistent root
  - `--max-response-size-mb`（env `CDM_MAX_RESPONSE_SIZE_MB`，默认 2）
  - `--inline-payload-max-mb`（env `CDM_INLINE_PAYLOAD_MAX_MB`，默认 1）
- `src/parallel/PageToolAdapter.ts`
  - dispatch 末尾，序列化 result 前用 `responseSizeGuard(result, { maxBytes, artifactDir })`：
    - 若 JSON 序列化字节 > maxBytes → 写 `responses/<id>-<ts>.json`，返 `{ truncated: true, filePath, originalSize, content: [{ type:'text', text:'<short summary>' }] }`
- `src/tools/screenshot.ts`
  - 默认 `filePath` 仍可选，但**缺省时强制走 `saveTemporaryFile` 到 artifact dir**（不再 base64 inline）
  - 新参数 `returnBase64: boolean`（default false）；`true` 时校验 `screenshot.length < inlinePayloadMax`，否则结构化错误
  - 旧字段 `data` 保留：当不返 inline → `data: null` + `movedTo: filePath`
- `src/tools/performance.ts` (`StartTrace`/`StopTrace`)
  - StopTrace 必落盘到 `traces/<instanceId>-<traceId>.json`
  - response 返 `{ filePath, summary: { events, samplingWindowMs, coreMetrics } }`
- `src/tools/memory.ts`
  - heap snapshot 必落盘 `.heapsnapshot`，response 返 `{ filePath, sizeBytes, topNodeKinds }`
- 新工具 `page_artifact_read_summary`（`src/parallel/managementTools/artifactReadSummary.ts`）
  - 入参：`{ filePath, kind?: 'trace'|'heap'|'response', sliceStart?, sliceEnd? }`
  - 按 kind 调对应 summarizer；trace 复用现有 `trace-processing/parse.ts`
- `src/parallel/index.ts`
  - 注册新工具，注入 `ArtifactDirManager` 单例

**测试**：

- `tests/ArtifactDir.test.ts`：ephemeral 写文件 → 模拟 SIGINT → 文件删；persistent 不删
- `tests/ResponseSizeGuard.test.ts`：构造 5MB result → 自动落盘 + truncated 元数据
- `tests/Screenshot.default.test.ts`：不带 filePath → response 不含 base64，filePath 存在且文件可读
- `tests/Screenshot.returnBase64.test.ts`：returnBase64=true + 1.5MB 截图 → 结构化错误
- `tests/Trace.persist.test.ts`：trace 落盘 + summary 字段齐
- `tests/ArtifactReadSummary.test.ts`：按路径读 summary

**验收映射**：FR-006..011a / SC-002 / Edge "Insufficient Disk Space" + "Concurrent same dir"

---

### WP-3 Instance Health & Self-healing — P2（FR-012..018）

**目标**：state machine + disconnect 监听 + 重 spawn + 熔断 + 新工具。

**改动**：

- `src/parallel/types.ts`
  - `Instance` 加：
    ```ts
    state: 'ready' | 'reconnecting' | 'dead';
    lastError?: { code: string; message: string; at: Date };
    lastHealthyAt: Date;
    reconnectAttempts: number;
    spawnedByService: boolean;       // mode==='launch' 通常 true；外部 cdp 通常 false
    launchConfig?: { ... };           // 用于 instance_recreate
    ```
  - 弃用 `available` boolean（保留映射 `available = state === 'ready'` 以向后兼容）
- `src/parallel/InstanceRegistry.ts`
  - 加 `setState(id, state, err?)` + `snapshotHealth()` 返 `Array<{id, state, lastError, lastHealthyAt, reconnectAttempts, spawnedByService}>`
- `src/parallel/managementTools/instanceCreate.ts`
  - 创建后 `browser.on('disconnected', () => onDisconnect(instance))`
  - 持有 `launchConfig` 在 instance 上
- `src/parallel/ConnectionWatchdog.ts`
  - 改造为 **per-instance** + 事件驱动：除轮询外，订阅 `browser.on('disconnected')` 立即触发
  - reconnect 流程：
    1. set state='reconnecting'，emit MCP notification
    2. 指数退避重连（默认 3 / 1s / 2s / 4s，配置可调）
    3. 失败 → 若 `spawnedByService` → 用 `launchConfig` 重 spawn（保留 user-data-dir）
    4. 仍失败 → 若 `mode==='cdp'` 外部 → 不重启，只重连 CDP
    5. 全部失败 → state='dead' + 写 `lastError`
  - 熔断：连续 3 次完整 reconnect 周期失败 → 永久 dead，停止自动重连
- `src/parallel/PageToolAdapter.ts`
  - dispatch step 1 后增加健康 gate：
    - `state==='reconnecting'` → 等待最多 10s（`waitForHealthy(instance, 10_000)`），超时返结构化错误 `INSTANCE_RECONNECTING`
    - `state==='dead'` → 直接返 `{ code:'INSTANCE_DEAD', recoverable:true, hint:'call instance_recreate', lastError }`
  - 任何 puppeteer Protocol error 捕获 → 包装为 `INSTANCE_PROTOCOL_ERROR` 结构化错误
- 新工具：
  - `instance_health`（`managementTools/instanceHealth.ts`）→ 返 registry.snapshotHealth()
  - `instance_recreate`（`managementTools/instanceRecreate.ts`）→ 用 `launchConfig` 重建，保留 id + downloadPath
- MCP 通知：
  - `src/parallel/index.ts` 在 server 上 expose `notifications/resourceUpdated`，state 变化推送
- `src/parallel/cli.ts`
  - `--reconnect-max-attempts`（env `CDM_RECONNECT_MAX_ATTEMPTS`，默认 3）
  - `--reconnect-backoff-ms`（env `CDM_RECONNECT_BACKOFF_MS`，默认 1000）
  - `--circuit-break-after`（env `CDM_CIRCUIT_BREAK_AFTER`，默认 3）

**测试**：

- `tests/Instance.state.test.ts`：state 转换正确
- `tests/ConnectionWatchdog.disconnect.test.ts`：模拟 `browser.emit('disconnected')` → 5s 内 state='dead'（mock 重连失败）
- `tests/ConnectionWatchdog.reconnect.test.ts`：mock 第二次成功 → state='ready'
- `tests/PageToolAdapter.healthGate.test.ts`：dead 实例调工具 → 结构化错误，无 stack trace
- `tests/InstanceHealth.tool.test.ts`：返完整状态表
- `tests/InstanceRecreate.tool.test.ts`：保留 id + 配置

**验收映射**：FR-012..018 / SC-003 / SC-004 / Edge "Continuous Reconnection" + "External Browser"

---

### WP-4 Heap & Crash Protection — P3（FR-019..023）

**目标**：bin 入口自动设默认 4GB heap + 内存监控 + crash log。

**改动**：

- `src/bin/chrome-devtools-mcp-parallel.ts`
  - 启动时检查 `process.env.NODE_OPTIONS` + `v8.getHeapStatistics().heap_size_limit`
  - 若 < `desiredHeapMb`（CLI `--heap-size` > env `CDM_HEAP_SIZE_MB` > 默认 4096）→ `child_process.spawn` 自身，注入 `NODE_OPTIONS=--max-old-space-size=<n> <existing>`，继承 stdio，父进程透传退出码 + 信号
  - 32-bit Node → cap 1500MB
  - `os.totalmem() * 0.8 < desiredHeapMb*MB` → 警告 + 降级到安全值
- `src/parallel/MemoryMonitor.ts`（新文件）
  - `setInterval(60_000)` 采样 `process.memoryUsage()` + `v8.getHeapStatistics()`
  - 维护 ring buffer（最近 60 个样本，1 小时窗口）供 crash log 使用
  - 80% → stderr `WARN` + 触发 `--expose-gc` 时的 `global.gc()`
  - 95% → 调 `instance_close_all`（保留最少 1 个？不，spec 说 close_all，但 plan 建议先 close idle）
  - 阈值/间隔 CLI `--mem-warn-pct` `--mem-danger-pct` `--mem-sample-interval-sec`
- `src/parallel/CrashLogger.ts`（新文件）
  - `process.on('uncaughtException', writeCrashLog)`、`process.on('unhandledRejection', ...)`
  - 写 `<artifactDir>/crashes/<ISOms>.log`：active instances snapshot + memory samples + last 20 tool calls（PageToolAdapter 维护短 ring）
- `README.md`
  - 章节 "Memory & Heap" 解释默认 4GB / 调整方式 / 何时加大
- `src/parallel/cli.ts`
  - 新选项：`--heap-size` `--mem-warn-pct` `--mem-danger-pct` `--mem-sample-interval-sec`

**测试**：

- `tests/HeapSelfRespawn.test.ts`：spawn child 模式（mock spawn）
- `tests/MemoryMonitor.test.ts`：注入伪造 memoryUsage 样本 → 触发 warn / danger 行为
- `tests/CrashLogger.test.ts`：抛 uncaughtException → 文件存在 + 字段齐

**验收映射**：FR-019..023 / SC-005 / SC-006 / SC-008

---

### WP-5 Cross-cutting：Cross-platform、Observability、Backward Compat（FR-024a/024b/025/026）

**目标**：与 WP-1..4 并行收口的横切项。

**改动**：

- `src/utils/artifactDir.ts` 已处理 cross-platform 路径合法字符 + 绝对路径化（FR-024a）
- `src/parallel/Observability.ts`（新文件）
  - 周期 stderr 打印 `{ ts, instances:[{id, state, console:{retained,evicted}, network:{retained,evicted}}], memory:{rssMb, heapUsedMb, heapPct}}`
  - 新工具 `system_observe`：返同结构 + artifact dir 占用
- 全局 `src/utils/structuredError.ts`（新文件）
  - `class StructuredError { code; message; recoverable; nextAction }`
  - Helper：`toToolResult(err)` → `CallToolResult` with `isError: true` + `structuredContent: { code, recoverable, nextAction, message }`
  - 所有 WP-2/WP-3 错误使用统一 helper（FR-026）
- 兼容性：所有改动遵守 FR-025 — 旧字段保留，废弃字段附 `deprecated`/`movedTo`，迁移说明写入 `specs/001-stability-hardening/migration.md`

**测试**：

- `tests/CrossPlatformPaths.test.ts`：win32 / posix path 分别构造，断言无非法字符
- `tests/Observability.test.ts`：metric line 字段齐
- `tests/StructuredError.test.ts`：序列化 + 消费

---

## 5. 配置矩阵（CLI ↔ env ↔ 默认值）

| CLI                         | Env                           | Default                            | 来源 FR    |
| --------------------------- | ----------------------------- | ---------------------------------- | ---------- |
| `--console-buffer-size`     | `CDM_CONSOLE_BUFFER_SIZE`     | 500                                | FR-002     |
| `--network-buffer-size`     | `CDM_NETWORK_BUFFER_SIZE`     | 1000                               | FR-002     |
| `--record-size-cap-kb`      | `CDM_RECORD_SIZE_CAP_KB`      | 256                                | FR-005     |
| `--artifact-dir`            | `CDM_ARTIFACT_DIR`            | `tmpdir/chrome-devtools-mcp/<pid>` | FR-007     |
| `--max-response-size-mb`    | `CDM_MAX_RESPONSE_SIZE_MB`    | 2                                  | FR-008     |
| `--inline-payload-max-mb`   | `CDM_INLINE_PAYLOAD_MAX_MB`   | 1                                  | FR-009     |
| `--reconnect-max-attempts`  | `CDM_RECONNECT_MAX_ATTEMPTS`  | 3                                  | FR-014     |
| `--reconnect-backoff-ms`    | `CDM_RECONNECT_BACKOFF_MS`    | 1000                               | FR-014     |
| `--circuit-break-after`     | `CDM_CIRCUIT_BREAK_AFTER`     | 3                                  | FR-017     |
| `--heap-size`               | `CDM_HEAP_SIZE_MB`            | 4096                               | FR-019/020 |
| `--mem-warn-pct`            | `CDM_MEM_WARN_PCT`            | 80                                 | FR-022     |
| `--mem-danger-pct`          | `CDM_MEM_DANGER_PCT`          | 95                                 | FR-022     |
| `--mem-sample-interval-sec` | `CDM_MEM_SAMPLE_INTERVAL_SEC` | 60                                 | FR-022     |

## 6. 新工具汇总

| Tool                         | 来源 | 描述                                        |
| ---------------------------- | ---- | ------------------------------------------- |
| `page_artifact_read_summary` | WP-2 | 按 path 读 trace/heap/response summary      |
| `instance_health`            | WP-3 | 全实例健康状态表                            |
| `instance_recreate`          | WP-3 | 用 launchConfig 重建                        |
| `system_observe`             | WP-5 | 运行时 buffer / health / memory metric 快照 |

## 7. 测试策略

- 单元测试：每个 WP 至少 3 个 `.test.ts`，置于 `tests/`
- 集成测试：`tests/integration/` 加 4 个端到端
  - `longSession.it.test.ts`（SC-001 缩短为 5min 等比模拟）
  - `largeArtifact.it.test.ts`（SC-002）
  - `browserCrash.it.test.ts`（SC-003：spawn chrome → kill → 验证状态 + 重建）
  - `oomGuard.it.test.ts`（SC-008：模拟 OOM throw）
- Soak（不入 CI）：`scripts/soak-8h.ts`，本地手跑，验 SC-006
- 命令统一走 `npm run build` / `npm run test`，禁止裸 `tsc`

## 8. 风险与缓解

| 风险                                               | 影响                                          | 缓解                                                                              |
| -------------------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------- |
| `PageCollector` chunk 切段 + 环形冲突              | navigation 切段后旧段被环形丢弃，测试预期会乱 | per-chunk 上限独立计数，navigation 切段时 evicted 累加进 chunk meta               |
| 自检 re-spawn 引入 stdio 双重写                    | MCP 客户端混乱                                | 父进程仅 pipe，不写任何额外日志；信号转发严格                                     |
| disconnect 监听重复触发                            | 多次 reconnect 同时跑                         | reconnect 加状态锁（`state==='reconnecting'` 时直接 return）                      |
| `instance_close_all` on danger 误杀正在使用的实例  | 用户体验差                                    | 先 close idle（`state==='ready'` 且 `lastUsedAt` 超 5min），再 fallback close all |
| `child_process.spawn` 在 Windows 下 stdio 行为差异 | bin entry 自检失败                            | 用 `{ stdio: 'inherit', windowsHide: true }` + 显式 exit code 透传，加 Win32 单测 |
| Trace summary 解析慢导致工具调用阻塞               | 大 trace 文件读 summary 卡                    | summary 只读 metadata（事件计数 + 头部 100 个 sample），不全量解析                |
| 旧字段保留导致 schema 膨胀                         | response payload 略大                         | 仅 screenshot/trace/heap 影响；新增字段 ≤ 100 字节                                |

## 9. 顺序与依赖

```
WP-1 (P1, 2~3d) ──┐
                   ├─► 集成测试 (longSession + largeArtifact)
WP-2 (P1, 3~4d) ──┤
                   │
WP-3 (P2, 4~5d) ──┼─► 集成测试 (browserCrash)
                   │
WP-5 (横切, 1~2d)─┤   (StructuredError 先于 WP-2/WP-3 落)
                   │
WP-4 (P3, 2~3d) ──┴─► 集成测试 (oomGuard) + soak 验证
```

**关键路径**：WP-5 中的 `StructuredError` + `ArtifactDir` 是 WP-2 / WP-3 的依赖，先于其他工作落。

## 10. 范围外（非本次）

- 不改 telemetry / clearcut 上报
- 不动 puppeteer 版本
- 不引入新 npm 依赖（环形 buffer / spawn / 监控全用 Node 内建）
- 不改 `src/parallel/managementTools/instanceList.ts` 的现有响应字段（只新增 instance_health）
- 不重写 lighthouse 第三方 bundle

## 11. 文档产出

- `specs/001-stability-hardening/data-model.md`（新）：Instance / RingBuffer / Artifact / HealthEvent 数据结构定义
- `specs/001-stability-hardening/contracts/`（新）：每个新工具的 JSON Schema + 错误码表
- `specs/001-stability-hardening/migration.md`（新）：旧客户端如何应对默认行为变化
- `README.md` 更新：新 CLI / env / 内存配置章节
