# Data Model: Stability Hardening

**Feature**: `001-stability-hardening` | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)

This document defines the runtime entities introduced or extended by the
stability hardening feature. Items prefixed `[impl]` are already in the code
base; `[planned]` are scheduled but not yet wired.

---

## 1. Instance (extended) `[impl — T049/T051]`

`src/parallel/types.ts > Instance`

Existing fields (unchanged): `id`, `mode`, `browser`, `context`, `contextId`,
`selectedPageIdx`, `downloadPath`, `badgeInjected`, `prevSnapshot`,
`prevSnapshotOrigin`, `mcpContext`, `createdAt`, `close()`.

New / changed:

| Field               | Type                                                       | Source | Notes                                                                                          |
| ------------------- | ---------------------------------------------------------- | ------ | ---------------------------------------------------------------------------------------------- |
| `state`             | `'ready' \| 'reconnecting' \| 'dead'`                      | T049   | Drives `available` getter                                                                      |
| `available`         | `boolean` (getter)                                         | T049   | `state === 'ready'`; setter retained for back-compat                                           |
| `lastError`         | `{ code: string; message: string; at: Date } \| undefined` | T049   | Last reconnect / protocol failure                                                              |
| `lastHealthyAt`     | `Date`                                                     | T049   | Timestamp when state last left `'ready'`                                                       |
| `reconnectAttempts` | `number`                                                   | T049   | Cumulative since instance creation; resets on `instance_recreate`                              |
| `spawnedByService`  | `boolean`                                                  | T049   | True for `mode === 'launch'` and CDP launches we initiated; false for external `--browser-url` |
| `launchConfig`      | `LaunchConfigSnapshot \| undefined`                        | T049   | Captured at create-time so `instance_recreate` can rebuild with same args                      |

`LaunchConfigSnapshot` is a frozen subset of `ParallelServerArgs` plus the
`PerInstance` constructor inputs needed to reproduce the browser process.

---

## 2. RingBuffer `[impl — T009]`

`src/utils/ringBuffer.ts > RingBuffer<T>`

Bounded FIFO queue with O(1) push and eviction. `Array.shift` is intentionally
not used.

| Field         | Type                  |
| ------------- | --------------------- |
| `capacity`    | `number` (immutable)  |
| `size`        | `number` (≤ capacity) |
| `totalPushed` | `number` (lifetime)   |
| `evicted`     | `number` (lifetime)   |

Methods: `push`, `toArray` (oldest→newest), `forEach`, `clear`.
`clear` resets `size` but preserves `totalPushed` / `evicted`.

---

## 3. ChunkBuffer `[impl — T016]`

`src/utils/chunkBuffer.ts > ChunkBuffer<T>`

Wraps a single `RingBuffer<T>` and adds the `replaceItems(items)` helper
needed by `NetworkCollector.splitAfterNavigation` (the chunk's underlying
ring is rebuilt while historical `evicted` / `totalPushed` are preserved).

`meta()` returns `{ size, totalPushed, evicted }`.

---

## 4. CollectorDataWithMeta<T> `[impl — T016]`

`src/PageCollector.ts > CollectorDataWithMeta<T>`

```ts
interface CollectorDataWithMeta<T> {
  items: T[]; // active chunk only (or aggregated if includePreservedData)
  chunks: ChunkMeta[]; // newest first
  total: ChunkMeta; // sum across chunks
}
```

Surfaced through `McpContext.getNetworkBufferMeta` /
`McpContext.getConsoleBufferMeta` and consumed by
`McpResponse.format()` to render the FR-003 eviction footer.

---

## 5. Artifact `[impl — T011]`

`src/utils/artifactDir.ts > AllocatedArtifact`

```ts
interface AllocatedArtifact {
  filePath: string; // absolute, OS-normalized
  lifetime: 'ephemeral' | 'persistent';
}
```

`ArtifactKind`: `'screenshots' | 'traces' | 'heapsnapshots' | 'responses' | 'crashes'`.

The owning instance, producing tool, size, creation time, summary, etc.,
remain on the call site (formatter / response payload). The file path itself
is deterministic enough to act as a stable identifier; collisions are
prevented by the `<instanceId>-<ISOms>-<rand4>` pattern.

---

## 6. StructuredError `[impl — T010]`

`src/utils/structuredError.ts > StructuredError`

```ts
class StructuredError extends Error {
  code: StructuredErrorCodeValue;
  recoverable: boolean;
  nextAction: string;
  detail: Record<string, unknown>;
}
```

`StructuredErrorCode` enumerates the shipping codes:
`INSTANCE_DEAD`, `INSTANCE_RECONNECTING`, `INSTANCE_PROTOCOL_ERROR`,
`RESPONSE_TOO_LARGE`, `INLINE_PAYLOAD_TOO_LARGE`, `DISK_WRITE_FAILED`,
`RECORD_TOO_LARGE`.

`toToolResult(err)` returns a `StructuredCallToolResult` (CallToolResult +
optional `structuredContent` extension recognised by MCP clients).

---

## 7. HealthEvent `[impl — T053/T054]`

Logical record emitted whenever an instance state transition fires; never
persisted on disk, only routed through MCP `notifications/resourceUpdated`
and the in-memory `recentToolCalls` ring used by `CrashLogger`.

| Field        | Type                                                          |
| ------------ | ------------------------------------------------------------- |
| `timestamp`  | `number` (epoch ms)                                           |
| `instanceId` | `string`                                                      |
| `source`     | `'disconnect' \| 'reconnect' \| 'circuit_break' \| 'rebuild'` |
| `from`       | `'ready' \| 'reconnecting' \| 'dead'`                         |
| `to`         | `'ready' \| 'reconnecting' \| 'dead'`                         |
| `error?`     | `{ code: string; message: string }`                           |

---

## 8. ParallelServerArgs (extended) `[impl — T005/T019]`

`src/parallel/types.ts > ParallelServerArgs`

Added stability fields (all required after parser fills defaults via
`STABILITY_DEFAULTS`):

```
consoleBufferSize        : number    // 500
networkBufferSize        : number    // 1000
recordSizeCapKb          : number    // 256
artifactDir              : string?   // unset → ephemeral root
maxResponseSizeMb        : number    // 2
inlinePayloadMaxMb       : number    // 1
reconnectMaxAttempts     : number    // 3
reconnectBackoffMs       : number    // 1000
circuitBreakAfter        : number    // 3
heapSize                 : number    // 4096
memWarnPct               : number    // 80
memDangerPct             : number    // 95
memSampleIntervalSec     : number    // 60
```

Precedence: CLI flag > env (`CDM_*` prefix) > built-in default.

The `--system-observe-interval-sec` knob (default `0` = off) was added by
T077 alongside the items above and is also resolved through
`STABILITY_DEFAULTS`.

---

## 9. MemorySample `[impl — T066]`

`src/parallel/MemoryMonitor.ts > MemorySample`

Single point sampled by `MemoryMonitor.tick()` and stored in a fixed-size
ring (`ringCapacity`, default 60). Consumed by `system_observe`,
`CrashLogger`, and the periodic stderr line.

```ts
interface MemorySample {
  ts: number; // epoch ms
  rss: number; // bytes — process.memoryUsage().rss
  heapUsed: number; // bytes — process.memoryUsage().heapUsed
  heapTotal: number; // bytes — process.memoryUsage().heapTotal
  heapLimit: number; // bytes — v8.getHeapStatistics().heap_size_limit
  heapPct: number; // 0..100, integer rounded
}
```

Edge-trigger semantics:

- WARN (`heapPct >= memWarnPct`, default 80) emits **once** per crossing.
- DANGER (`heapPct >= memDangerPct`, default 95) fires `onDanger` on
  every tick while above threshold (no edge dampening — danger needs
  repeated pressure relief).

---

## 10. ToolCallRecord `[impl — T068]`

`src/parallel/ToolCallRing.ts > ToolCallRecord`

Captured by `PageToolAdapter` at dispatch entry, kept in a 20-deep ring,
and serialized into crash logs.

```ts
interface ToolCallRecord {
  ts: number; // epoch ms
  toolName: string; // e.g. 'page_navigate_page'
  instanceId: string;
  status?: 'ok' | 'error' | 'health_blocked';
  errorCode?: string; // populated when status === 'error'/'health_blocked'
}
```

The ring is process-wide, not per-instance — operators investigating an
OOM look at "what did this server do in the last 20 calls", not "what
happened to this one tab".

---

## 11. ObservabilitySnapshot `[impl — T075]`

`src/parallel/Observability.ts > ObservabilitySnapshot`

Returned by `Observability.snapshot()` and rendered as the JSON body of
both the `system_observe` MCP tool and the `[observability] {...}`
periodic stderr line.

```ts
interface ObservabilitySnapshot {
  ts: string; // ISO 8601
  instances: InstanceObservation[];
  memory: {rssMb: number; heapUsedMb: number; heapPct: number};
  artifactDir: {ephemeralBytes: number; persistentBytes: number};
  recentMemorySamples?: MemorySample[]; // omitted unless requested
}

interface InstanceObservation {
  id: string;
  state: 'ready' | 'reconnecting' | 'dead';
  console: {retained: number; evicted: number};
  network: {retained: number; evicted: number};
}
```

Disk usage is cached for ~10 s (a recursive `du`-like walk capped at
5 000 entries) so the periodic logger stays cheap on busy servers.
