# Migration Guide: Stability Hardening

**Feature**: `001-stability-hardening` | **Spec**: [spec.md](./spec.md)

This document tracks every default-behaviour change shipped by the stability
hardening feature so existing clients (LLMs, CI scripts, IDE plugins) can
adapt — or opt back into the legacy behaviour where one is offered.

The schema-level contract for tool calls is **unchanged**: every previously
returned field continues to exist in the response shape (sometimes set to
`null` or empty), so a strict-typed client deserializing into the existing
schema will not crash. See FR-025 / SC-007.

---

## 1. Console & Network buffers are now bounded `[impl — T016 / T021]`

| Aspect                     | Before                 | After                                                                                                                     |
| -------------------------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Per-page console messages  | unbounded              | bounded ring buffer, default 500                                                                                          |
| Per-page network requests  | unbounded              | bounded ring buffer, default 1000                                                                                         |
| Behaviour when cap reached | unlimited growth → OOM | oldest evicted FIFO, counter incremented                                                                                  |
| Tool response              | items only             | items **+** footer line `Buffer status: showing N retained of M observed; K earlier records evicted.` (only when `K > 0`) |
| `structuredContent`        | unchanged              | adds optional `consoleBufferMeta` / `networkBufferMeta` `{retained, totalPushed, evicted}`                                |

**Opt back into the (uncapped) legacy behaviour**: not supported on purpose —
the cap exists to prevent OOM. Increase the cap with the new flags when more
history is needed:

```bash
chrome-devtools-mcp-parallel \
  --console-buffer-size 5000 \
  --network-buffer-size 10000
```

Or via env (same precedence: CLI > env > default):

```bash
export CDM_CONSOLE_BUFFER_SIZE=5000
export CDM_NETWORK_BUFFER_SIZE=10000
```

---

## 2. Single-record truncation `[implemented — T017, formatter exposure tracked under WP-2]`

When a single buffered record (e.g. a 50 MB console.log dump) exceeds the
per-record size cap (default 256 KB; configurable via
`--record-size-cap-kb`), `PageCollector` stamps an internal `oversizeSymbol`
on the record at push time using a constant-time estimator
(`ConsoleCollector` reads `text()` / `Error.message+stack` /
`UncaughtError.details`; `NetworkCollector` sums `url() + headers`). The
underlying Puppeteer object is **not** mutated — eviction stays the buffer's
job, the marker is informational and is consumed at read time via
`McpContext.getNetworkRequestCollectedAt` / `isOversize` (PageCollector)
helpers.

Surface in the formatted response (`truncated: true` JSON field +
`[truncated, est=NNN bytes]` footer) is part of WP-2 (artifact persistence)
where the response shape is reworked anyway.

**Opt-out**: increase `--record-size-cap-kb` to a value larger than your
biggest expected record (or set it to `0` to disable the check entirely).

---

## 3. Default screenshot return `[implemented — T033]`

| Caller intent                            | How to keep working                                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Give me the file path I can read later" | _do nothing_ — this is now the default. The response carries a `Saved screenshot to <path>` text line; no inline image is attached                                                                                                                                                                                                                  |
| "Give me the base64 inline like before"  | Pass `returnBase64: true`. Only allowed when the encoded payload `<= --inline-payload-max-mb` (default 1 MB; configurable via env `CDM_INLINE_PAYLOAD_MAX_MB` or CLI). Larger payloads raise a `StructuredError(INLINE_PAYLOAD_TOO_LARGE)` carrying `nextAction` text that points the caller at `returnBase64=false` / `filePath` / raising the cap |

The schema-level shape is preserved (FR-025): `content` always exists, `isError`
remains a boolean, the new `structuredContent.error = StructuredError.toJSON()` is
purely additive when the inline cap rejects the payload.

CLI-side bridging: `createParallelMcpServer` writes `args.inlinePayloadMaxMb`
into `process.env.CDM_INLINE_PAYLOAD_MAX_MB` at startup so the screenshot
tool — which is built by the upstream factory and does not see
`ParallelServerArgs` — picks the same value the operator chose on the CLI.

---

## 4. Trace / heap snapshot artifacts always written to disk `[implemented — T034 / T035]`

Trace JSON and heap snapshots no longer round-trip through the MCP channel
inline. Responses now contain `{ filePath, summary }` only. The
`page_artifact_read_summary` tool (T036) lets a caller fetch summary slices
on demand from the file path.

### Performance traces — `performance_stop_trace` `[implemented]`

| Aspect            | Old                                                              | New                                                                                                                                                                                     |
| ----------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `filePath` schema | optional; only saved when supplied                               | optional; **always** persisted — caller path wins, otherwise auto-allocated under `<artifactDir>/traces/...`                                                                            |
| Compression       | gzip when caller path ends with `.gz`                            | unchanged                                                                                                                                                                               |
| Response (text)   | `The performance trace has been stopped.` + (optional save line) | adds `## Performance Trace` block: `Trace persisted to <path>`, `Size: N bytes; events: E; samplingWindowMs: W`, optional `Core metrics: LCP=… INP=… CLS=…`                             |
| Response (struct) | `traceSummary` text only                                         | adds `tracePersistence = { filePath, sizeBytes, summary: {events, samplingWindowMs, coreMetrics{lcpMs?,clsScore?,inpMs?}}, movedTo }`. `traceSummary` text retained for LLM consumption |
| Disk write fail   | raw `Error`                                                      | `StructuredError(DISK_WRITE_FAILED, recoverable:true, nextAction='Verify the artifact directory is writable, or pass an explicit `filePath`')`                                          |

`coreMetrics` is best-effort: `summarizeTrace()` (in
`src/utils/traceSummary.ts`) walks the first insightSet's `model.LCPBreakdown.lcpMs`,
`model.INPBreakdown.inpMs`, and `model.CLSCulprits.clsScore` via
`unknown`-safe `Reflect.get` paths so the typing surface stays free of `as`
casts. `samplingWindowMs` comes from `parsedTrace.data.Meta.traceBounds.range`
(microseconds → milliseconds). `events` is counted from the raw buffer JSON
(handles both `{traceEvents:[…]}` and bare-array shapes).

### Heap snapshots — `take_memory_snapshot` `[implemented]`

| Aspect            | Old                                  | New                                                                                                                                            |
| ----------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `filePath` schema | required                             | optional; auto-allocated under `<artifactDir>/heapsnapshots/page-<ts>-<rand>.heapsnapshot`                                                     |
| Inline payload    | none (was always disk-bound)         | unchanged — still disk-bound                                                                                                                   |
| Response          | text `Heap snapshot saved to <path>` | text + `structuredContent.heapSnapshotPersistence = { filePath, sizeBytes, topNodeKinds[] }`                                                   |
| Legacy field      | n/a                                  | `structuredContent.heapSnapshot.movedTo = filePath` (so old clients keying off `heapSnapshot` see a non-empty object)                          |
| Capture failure   | raw `Error`                          | `StructuredError(DISK_WRITE_FAILED, recoverable:true, nextAction='Verify the artifact directory is writable, or pass an explicit `filePath`')` |

`topNodeKinds` is computed by `summarizeHeapSnapshot()` (in
`src/utils/heapSnapshotSummary.ts`): the snapshot JSON is parsed, the
`meta.node_fields` stride is used to count the `type`-field bucket per
`meta.node_types[type]`, and the top 10 buckets are returned sorted by count
descending. Parse failures fall back to an empty array — the response still
carries `sizeBytes`.

---

## 5. Global response size cap `[implemented — T032]`

Any tool response whose serialized JSON exceeds
`--max-response-size-mb` (default 2 MB) is automatically persisted to
`<artifactDir>/responses/...` and replaced with
`{ truncated: true, filePath, originalSize }`. Existing fields are still
present in the schema; the runtime contract is "look at `truncated` first".

---

## 6. Structured errors `[implemented — T055 health gate live]`

`McpResponse.format()` now detects `StructuredError` thrown by any tool
handler and renders it twice:

- text content gets `Error: [CODE] <message> (next: <nextAction>)`,
- `structuredContent.errorMessage` carries the same string for legacy parsers,
- `structuredContent.error = err.toJSON()` carries the full envelope (`code` /
  `recoverable` / `nextAction` / arbitrary `detail`).

Tools that already speak `StructuredError`:

- `take_screenshot` → `INLINE_PAYLOAD_TOO_LARGE` (T033).
- `responseSizeGuard` → `DISK_WRITE_FAILED` when persistence fails (T032).

The PageToolAdapter health gate (T055) is live: dead instances return
`INSTANCE_DEAD` immediately; reconnecting instances wait up to 10 s and
return `INSTANCE_RECONNECTING` on timeout; puppeteer Protocol errors are
wrapped as `INSTANCE_PROTOCOL_ERROR`. See `tests/PageToolAdapter.healthGate.test.ts`.

---

## 7. Default heap size `[implemented — T065 / T066 / T067]`

`chrome-devtools-mcp-parallel` will automatically respawn itself with
`--max-old-space-size=4096` if the running Node has a lower heap limit and
no `NODE_OPTIONS` was provided by the caller. To override:

```bash
chrome-devtools-mcp-parallel --heap-size 8192
# or
export CDM_HEAP_SIZE_MB=8192
```

If `os.totalmem() * 0.8` is below the requested cap, the service
downgrades to a safe value and warns to stderr. 32-bit Node is capped at
1500 MB.

---

## 8. Artifact directory & cleanup `[impl — T011]`

| Mode                                            | Path                                     | Lifetime                                                   |
| ----------------------------------------------- | ---------------------------------------- | ---------------------------------------------------------- |
| Default (no flag)                               | `os.tmpdir()/chrome-devtools-mcp/<pid>/` | Auto-cleaned on `SIGINT` / `SIGTERM` / `uncaughtException` |
| `--artifact-dir <path>` (or `CDM_ARTIFACT_DIR`) | The supplied directory                   | Never auto-cleaned                                         |

Operators that mounted the old behaviour (no artifact files at all because
everything was inline) should ensure their host has at least a few GB of
free space in `os.tmpdir()` once Phase 4 lands.

---

## Status legend

- `[impl]` — already on `main` for this feature branch (commit hash → see
  PR description).
- `[planned]` — scheduled in `tasks.md`; this section will be updated when
  the corresponding T_NNN merges.

---

## 9. New management tools registered by the parallel server

| Tool                         | Returns                                                                                                                                  | Typical caller                                         |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `instance_health`            | `snapshotHealth()` for every instance — `id`, `state`, `lastError`, `lastHealthyAt`, `reconnectAttempts`, `spawnedByService`             | Watchdog scripts, dashboards                           |
| `instance_recreate`          | Re-launches a dead instance with original `launchConfig`, preserving id + `downloadPath`                                                 | Recovery flows after `INSTANCE_DEAD`                   |
| `page_artifact_read_summary` | Trace / heap / response summary read from disk on demand                                                                                 | Avoids piping large blobs back through MCP             |
| `system_observe`             | Per-instance buffer occupancy, process memory (`rssMb` / `heapUsedMb` / `heapPct`), artifact disk usage; optional rolling memory samples | Health probes, soak tests, periodic stderr metric line |

## 10. Full CLI / env matrix `[impl — T019 / T038 / T059 / T070]`

All flags accept an env equivalent prefixed `CDM_` (`snake-case` →
`SCREAMING_SNAKE_CASE`), with CLI taking precedence:

| Flag                            | Env                               | Default                                             |
| ------------------------------- | --------------------------------- | --------------------------------------------------- |
| `--console-buffer-size`         | `CDM_CONSOLE_BUFFER_SIZE`         | `500`                                               |
| `--network-buffer-size`         | `CDM_NETWORK_BUFFER_SIZE`         | `1000`                                              |
| `--record-size-cap-kb`          | `CDM_RECORD_SIZE_CAP_KB`          | `256`                                               |
| `--max-response-size-mb`        | `CDM_MAX_RESPONSE_SIZE_MB`        | `4`                                                 |
| `--inline-payload-max-mb`       | `CDM_INLINE_PAYLOAD_MAX_MB`       | `1`                                                 |
| `--artifact-dir`                | `CDM_ARTIFACT_DIR`                | `<os.tmpdir>/chrome-devtools-mcp/<pid>` (ephemeral) |
| `--heap-size`                   | `CDM_HEAP_SIZE_MB`                | `4096`                                              |
| `--mem-warn-pct`                | `CDM_MEM_WARN_PCT`                | `80`                                                |
| `--mem-danger-pct`              | `CDM_MEM_DANGER_PCT`              | `95`                                                |
| `--mem-sample-interval-sec`     | `CDM_MEM_SAMPLE_INTERVAL_SEC`     | `60`                                                |
| `--reconnect-max-attempts`      | `CDM_RECONNECT_MAX_ATTEMPTS`      | `3`                                                 |
| `--reconnect-backoff-ms`        | `CDM_RECONNECT_BACKOFF_MS`        | `1000`                                              |
| `--circuit-break-after`         | `CDM_CIRCUIT_BREAK_AFTER`         | `3`                                                 |
| `--system-observe-interval-sec` | `CDM_SYSTEM_OBSERVE_INTERVAL_SEC` | `0` (off)                                           |

## 11. Operator checklist when upgrading

1. **Disk budget.** Persistent artifacts land in `--artifact-dir` if
   set, otherwise the per-pid ephemeral dir under `os.tmpdir()`. Plan
   for at least 2 GB of headroom on busy servers — periodic trace +
   heap dumps add up even with the 95 %-heap fail-safe closing idle
   instances first.
2. **Heap respawn.** The bin entry execs itself with
   `--max-old-space-size=<heapSize>` if the inherited limit is below
   ~95 % of `heapSize`. Existing `NODE_OPTIONS` is prepended so caller
   flags survive. Pass `--heap-size 0` to skip the self-check entirely.
3. **Crash logs.** `uncaughtException` and `unhandledRejection` now
   write `<artifactDir>/crashes/<ISOms>.log` containing active instance
   health, recent memory samples, and the last 20 tool calls. Ensure
   the directory is writable by the service user.
4. **Observability.** Set `--system-observe-interval-sec 30` for
   continuous stderr emission of `[observability] {...}` JSON lines —
   compatible with Datadog / Loki ingest without bespoke parsers.

## 12. Behavioural diffs vs. v0.x worth highlighting

- Calling a tool against a `dead` instance is now **fast-fail** — there
  is no implicit reconnect from the dispatch path. Callers must use
  `instance_recreate` (FR-014).
- Puppeteer `Protocol error` is wrapped as `INSTANCE_PROTOCOL_ERROR`.
  The original message is preserved in `structuredContent.error.cause`.
- Buffer eviction is observable but not reversible — once a console
  message is dropped, it's gone. Increase the cap if you need full
  history (or attach your own listener for off-server persistence).
