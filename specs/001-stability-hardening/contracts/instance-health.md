# Tool Contract: `instance_health`

**Feature**: `001-stability-hardening` | **Source**: [`src/parallel/managementTools/instanceHealth.ts`](../../../src/parallel/managementTools/instanceHealth.ts) | **Tests**: [`tests/InstanceHealth.tool.test.ts`](../../../tests/InstanceHealth.tool.test.ts)

Read-only. Returns the lifecycle state for every registered instance.
Cheap enough to call on a tight loop from a watchdog or dashboard.

## Input schema

```ts
// no parameters
{
}
```

## Output schema

`CallToolResult.structuredContent.healthSnapshot`:

```ts
interface InstanceHealthSnapshot {
  id: string;
  mode: 'launch' | 'cdp';
  state: 'ready' | 'reconnecting' | 'dead';
  available: boolean; // === state === 'ready'
  lastError: string | null; // human-readable; full payload elsewhere
  lastHealthyAt: string; // ISO 8601
  reconnectAttempts: number; // cumulative since instance created
  spawnedByService: boolean;
  createdAt: string; // ISO 8601
}

interface InstanceHealthOutput {
  healthSnapshot: InstanceHealthSnapshot[];
}
```

The `content[0]` text block carries a human-readable summary line per
instance, e.g.:

```
inst-1  ready  reconnects=0  lastHealthy=2026-05-12T07:14:02.310Z
inst-2  dead   reconnects=3  lastError="Browser closed unexpectedly"
```

## Error codes

This tool does not throw `StructuredError`. If the registry is empty the
result has `healthSnapshot: []` and a single text line `(no instances)`.

## Performance contract

- O(N) over registered instances (N capped by `--max-instances`, default 10).
- No I/O. Safe to call from a periodic poller every second.
