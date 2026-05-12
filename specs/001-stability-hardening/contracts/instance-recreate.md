# Tool Contract: `instance_recreate`

**Feature**: `001-stability-hardening` | **Source**: [`src/parallel/managementTools/instanceRecreate.ts`](../../../src/parallel/managementTools/instanceRecreate.ts) | **Tests**: [`tests/InstanceRecreate.tool.test.ts`](../../../tests/InstanceRecreate.tool.test.ts)

Recovery path. Re-launches a `dead` instance using the original
`launchConfig` captured at create-time, preserving the public identity
(`id`, `downloadPath`) so client-side bookkeeping stays valid.

Fails fast if the instance is `ready` (no need to recreate) or
`reconnecting` (the watchdog is already on it).

## Input schema

```ts
interface InstanceRecreateInput {
  instanceId: string; // must match an existing entry in InstanceRegistry
}
```

## Output schema

`CallToolResult.structuredContent.recreated`:

```ts
interface InstanceRecreatedOutput {
  id: string;
  mode: 'launch' | 'cdp';
  downloadPath: string;
  state: 'ready'; // post-condition
  reconnectAttempts: 0; // counter is reset on successful recreate
}
```

The `content[0]` text block carries a one-liner suitable for chat UIs,
e.g. `Instance "inst-1" recreated (mode=launch, downloadPath=/tmp/...)`.

## Error codes

| Code                | Recoverable              | Trigger                                                                               |
| ------------------- | ------------------------ | ------------------------------------------------------------------------------------- |
| `INSTANCE_DEAD`     | true (with `nextAction`) | Internal — never returned to caller; recreate path never returns this code on success |
| `DISK_WRITE_FAILED` | true                     | Fresh browser launch failed to create the user-data-dir / download-dir                |
| (generic `Error`)   | n/a                      | Instance not found, or the instance is not in `dead` state                            |

For the "instance is not dead" case the error is a plain `Error` with
message `Instance "<id>" is not dead (current state: <state>); refusing to recreate.`
Operators should call `instance_close` + `instance_create` themselves to
force a rebuild.

## Idempotence

Calling `instance_recreate` against an `id` that has already been
recreated and is back in `ready` is a no-op error (see above). The tool
is therefore safe to retry once; bounded retries should rely on the
state machine, not arbitrary backoff.

## Performance contract

- One puppeteer `puppeteer.launch()` (or `puppeteer.connect()` for CDP
  mode) — typically 500 ms – 2 s.
- Holds the global `InstanceMutex` for the duration to keep the registry
  view consistent.
