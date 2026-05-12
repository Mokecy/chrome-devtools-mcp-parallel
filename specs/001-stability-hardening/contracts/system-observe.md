# Tool Contract: `system_observe`

**Feature**: `001-stability-hardening` | **Source**: [`src/parallel/managementTools/systemObserve.ts`](../../../src/parallel/managementTools/systemObserve.ts) | **Tests**: [`tests/parallel/Observability.test.ts`](../../../tests/parallel/Observability.test.ts)

Snapshot of runtime observability data: per-instance lifecycle state +
console/network buffer occupancy, process memory (RSS / heapUsed /
heapPct), and artifact directory disk usage. Pair with
`--system-observe-interval-sec` for continuous stderr emission of the
same payload.

## Input schema

```ts
interface SystemObserveInput {
  /**
   * Embed the rolling MemoryMonitor ring buffer (up to `ringCapacity`
   * = 60 by default) in the response. Off by default to keep the wire
   * payload small.
   */
  includeMemorySamples?: boolean;
}
```

## Output schema

The full snapshot is stringified into `content[0].text` (after a
human-readable summary line); structured form lives at
`structuredContent` under no extra key (the snapshot fields are
top-level on `structuredContent`).

```ts
interface ObservabilitySnapshot {
  ts: string; // ISO 8601
  instances: InstanceObservation[];
  memory: {rssMb: number; heapUsedMb: number; heapPct: number};
  artifactDir: {ephemeralBytes: number; persistentBytes: number};
  recentMemorySamples?: MemorySample[]; // present iff includeMemorySamples=true
}

interface InstanceObservation {
  id: string;
  state: 'ready' | 'reconnecting' | 'dead';
  console: {retained: number; evicted: number};
  network: {retained: number; evicted: number};
}

interface MemorySample {
  ts: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  heapLimit: number;
  heapPct: number;
}
```

The text block always opens with:

```
system_observe @ <ts>
memory: rss=<n>MB heapUsed=<n>MB heapPct=<n>%
artifactDir: ephemeral=<size> persistent=<size>
instances (N):
  - <id>  state=<state>  console=<retained>/<retained+evicted>  network=<retained>/<retained+evicted>
```

Followed by a blank line and the JSON snapshot pretty-printed (so
operators can copy-paste into their tooling).

## Error codes

This tool does not throw `StructuredError`. The disk-usage walk is
best-effort (capped at 5 000 entries, errors swallowed) so it never
blocks observability.

## Performance contract

- O(N) over instances + O(M) over recent memory samples (M ≤ 60).
- Disk usage: cached for 10 s; first call after start does a recursive
  walk capped at 5 000 entries.
- Snapshot is synchronous; safe to call from the periodic stderr
  emitter or from any tool that wants a quick health probe.

## Periodic stderr mode

When `--system-observe-interval-sec N` is set (or `CDM_SYSTEM_OBSERVE_INTERVAL_SEC`),
the parallel server emits one line every N seconds:

```
[observability] {"ts":"...","instances":[...],"memory":{...},"artifactDir":{...}}
```

`recentMemorySamples` is **not** included in the periodic line — only
in tool responses where the caller explicitly opted in. This keeps the
log volume manageable for ELK / Loki ingestion.
