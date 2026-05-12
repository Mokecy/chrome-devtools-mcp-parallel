---
description: 'Manual verification quickstart for the stability hardening rollout'
---

# Quickstart — `001-stability-hardening`

**Audience**: operators / reviewers running the stability rollout end-to-end on
a real machine. The CI suite already covers the structural assertions
(`tests/**/*.test.ts` + `tests/integration/*.it.test.ts`); this doc walks the
**three success criteria that need a real environment to prove out**:

| Criterion | What we prove                                              | Cmd                          |
| --------- | ---------------------------------------------------------- | ---------------------------- |
| SC-001    | 8h soak — RSS growth < 200 MB, no crash, eviction working  | `npm run soak-8h`            |
| SC-003    | A killed Chrome flips to `dead` < 5 s; `instance_recreate` rebuilds | manual JSON-RPC walk |
| SC-005    | Heap floor — fresh launch self-respawns to ≥ 4 GB heap     | `chrome-devtools-mcp-parallel --help` + `system_observe` |

> **Prereqs**
>
> - `npm install && npm run build` clean
> - Chromium-class browser available (`PUPPETEER_EXECUTABLE_PATH` if pinning)
> - At least 6 GB free RAM for the heap-floor test
> - Windows: PowerShell 5+ or any pwsh; POSIX: any bash

---

## SC-001 — Long-session soak (8h, FR-001..005)

The committed soak driver wraps the parallel server in stdio JSON-RPC and
drives ≈5 console + 5 network events / sec for the configured duration.

### Run

```bash
npm run build
SOAK_LOG_FILE=./soak.log npm run soak-8h          # 8h, default
# Shorter dry-run to validate the harness (recommended first):
SOAK_HOURS=0.5 SOAK_LOG_FILE=./soak.log npm run soak-8h
```

Each minute the driver appends a single `METRIC` line:

```
[2026-05-13T01:23:45.000Z] METRIC elapsedMin=42.0 rssMb=412.7 heapPct=18.3 state=ready consoleEvicted=12300 networkEvicted=24600 ticks=12600
```

### Pass conditions (auto-asserted in `SUMMARY` + exit code)

- `rssGrowthMb < 200` (final − baseline)
- `consoleEvicted > 0` AND `networkEvicted > 0` (FR-002 ring eviction proven)
- `instanceState != dead` (no recovery path triggered)

Exit code `0` ⇒ pass; `1` ⇒ acceptance gate failed; `2` ⇒ harness crashed.

### Where to look if it fails

- `crashes/<ISOms>.log` under `--artifact-dir` (FR-023 crash dump) — usually
  carries the proximate stack + active instance snapshot
- `responses/*.json` — any oversized tool result the guard dumped (FR-006)
- `traces/`, `heapsnapshots/` — large artifacts produced during the run (FR-007..009)

---

## SC-003 — Browser crash recovery (FR-012..018)

Verifies the Phase 5 state machine end-to-end: a killed Chrome process must
surface as `dead` within 5 s, page tools must short-circuit with the
documented `StructuredError`, and `instance_recreate` must restore the slot.

### 1. Start the parallel server

```bash
node build/src/bin/chrome-devtools-mcp-parallel.js --headless --max-instances 1
```

…or attach a real MCP client (Claude Desktop, custom JSON-RPC harness).

### 2. Create a launch-mode instance

```jsonc
{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"instance_create","arguments":{"instanceId":"crash-target"}}}
```

Take note of the Chrome process PID printed in stderr.

### 3. Kill the browser out-of-band

- **Windows**: `taskkill /F /T /PID <pid>`
- **POSIX**:   `kill -9 <pid>`

### 4. Within 5 s call `instance_health`

```jsonc
{"jsonrpc":"2.0","id":2,"method":"tools/call",
 "params":{"name":"instance_health","arguments":{}}}
```

**Expected** `structuredContent.healthSnapshot[0]`:

```jsonc
{
  "id": "crash-target",
  "state": "dead",                 // ← key assertion (FR-013)
  "lastError": "browser disconnected",
  "reconnectAttempts": <N>,        // hit `circuitBreakAfter` cap
  "spawnedByService": true
}
```

### 5. Any page tool must reject cleanly

```jsonc
{"jsonrpc":"2.0","id":3,"method":"tools/call",
 "params":{"name":"page_navigate_page",
           "arguments":{"instanceId":"crash-target","url":"https://example.com/"}}}
```

**Expected** `result.isError === true`, `structuredContent`:

```jsonc
{ "code": "INSTANCE_DEAD", "recoverable": true, "nextAction": "Call `instance_recreate` …" }
```

### 6. `instance_recreate` rebuilds the slot

```jsonc
{"jsonrpc":"2.0","id":4,"method":"tools/call",
 "params":{"name":"instance_recreate","arguments":{"instanceId":"crash-target"}}}
```

**Expected** `result.isError === false`, response text starts with `recreated`.
Re-check `instance_health` — `state` back to `ready`, `lastHealthyAt` updated,
the slot accepts page tools again.

---

## SC-005 — Default heap floor (FR-019)

Verifies the bin self-respawn lands at ≥ 4 GB even with no `NODE_OPTIONS`.

### 1. Cold start without any heap flag

```bash
unset NODE_OPTIONS                                # POSIX
# Remove-Item Env:NODE_OPTIONS                    # PowerShell
node build/src/bin/chrome-devtools-mcp-parallel.js --headless --max-instances 1
```

Stderr should carry **one** of:

- `[heap] respawning with --max-old-space-size=4096` (parent process)
- silently nothing (already at ≥ 4 GB on this Node build)

### 2. Confirm via `system_observe`

```jsonc
{"jsonrpc":"2.0","id":1,"method":"tools/call",
 "params":{"name":"system_observe","arguments":{}}}
```

**Expected** `structuredContent.memory.heapPct < 0.05` immediately after start
AND the underlying `v8.getHeapStatistics().heap_size_limit ≥ 4 * 1024² * 1024`
(the bin emits this on stderr at startup; capture and grep for `heap_size_limit`
to record the exact bytes).

### 3. (Optional) 32-bit / low-RAM fallback

On a 32-bit Node build OR a host with `os.totalmem() * 0.8 < 4096 MB`, the
self-respawn caps at 1500 MB and emits a downgrade warning:

```
[heap] downgrading to 1500 MB (host has 1.8 GB available, < 4 GB target)
```

This path is exercised by `tests/parallel/HeapSizeResolver.test.ts` — manual
verification only required when shipping on an unusual host.

---

## Recording results

When walking these for a release sign-off, capture one paragraph per criterion:

```
SC-001: 8h run on <host>, baseline=380 MB, final=485 MB, growth=105 MB ✅
        consoleEvicted=147600 networkEvicted=295200 state=ready
        log: ./soak-<date>.log
SC-003: launch-mode kill-recover round-trip ≈ 2.1 s; INSTANCE_DEAD surfaced;
        instance_recreate restored — verified on Chrome <ver> ✅
SC-005: cold start respawn → heap_size_limit = 4294836224 (4.0 GB) ✅
```

Stash the log file alongside the release tag (`release/v0.X.Y/soak-<date>.log`)
so a future regression can A/B-compare the eviction ratio + RSS curve.

---

## See also

- [Migration guide](./migration.md) — full CLI/env matrix, behaviour deltas vs v0.x
- [Data model](./data-model.md) — `MemorySample` / `ToolCallRecord` / `ObservabilitySnapshot` shapes
- [Contracts](./contracts/README.md) — `instance_health` / `instance_recreate` / `page_artifact_read_summary` / `system_observe`
- [Tasks](./tasks.md) — T015 / T064 / T015 / T084 cross-references
