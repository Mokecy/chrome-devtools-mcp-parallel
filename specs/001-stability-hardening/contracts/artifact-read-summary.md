# Tool Contract: `page_artifact_read_summary`

**Feature**: `001-stability-hardening` | **Source**: [`src/parallel/managementTools/artifactReadSummary.ts`](../../../src/parallel/managementTools/artifactReadSummary.ts) | **Tests**: [`tests/ArtifactReadSummary.test.ts`](../../../tests/ArtifactReadSummary.test.ts)

Read a previously persisted artifact (heap snapshot, performance trace,
or oversized response stub) and return a small JSON summary. Avoids
round-tripping the raw bytes through the MCP pipe (FR-008).

The artifact must already exist on disk — usually because an earlier
tool call (screenshot, `performance_stop_trace`, `take_memory_snapshot`,
or the global response-size guard) wrote it. Callers pass the same
`filePath` that was reported in `structuredContent.*Persistence`.

## Input schema

```ts
interface ArtifactReadSummaryInput {
  filePath: string; // absolute or repo-relative
  kind?: 'trace' | 'heap' | 'response'; // default: inferred from extension + parent dir
  sliceStart?: number; // bytes; only honoured when kind === 'response'
  sliceEnd?: number; // bytes; default: sliceStart + 4096
}
```

`kind` inference rules (when omitted):

- `*.heapsnapshot` → `'heap'`
- `*.json` under `<artifactDir>/responses/` → `'response'`
- `*.json` (any other dir) → `'trace'`
- otherwise → `StructuredError(DISK_WRITE_FAILED, message='Cannot infer artifact kind from <filePath>')`

## Output schema

Discriminated union via `kind`:

```ts
type ArtifactReadSummaryOutput =
  | {kind: 'heap'; summary: HeapSnapshotSummary}
  | {kind: 'trace'; summary: TraceSummary}
  | {kind: 'response'; summary: ResponseSummary};

interface HeapSnapshotSummary {
  filePath: string;
  sizeBytes: number;
  topNodeKinds: Array<{kind: string; count: number; size: number}>;
}

interface TraceSummary {
  filePath: string;
  sizeBytes: number;
  events: number;
  samplingWindowMs: number;
  coreMetrics: {lcpMs?: number; inpMs?: number; clsScore?: number};
}

interface ResponseSummary {
  filePath: string;
  sizeBytes: number;
  topLevelKeys: string[];
  slice: {start: number; end: number; bytes: string}; // bytes is utf-8 substring
}
```

The `content[0]` text block prints a compact summary line:

```
Heap snapshot: 18 MB, top kinds: HiddenClass×12 481 (4.1 MB), Object×8 312 (2.7 MB)
Trace: 4 312 events, 30 200 ms window, LCP=1.2s INP=92ms CLS=0.04
Response: 12 keys (content,structuredContent,...), slice 0..4096 of 7.3 MB
```

## Error codes

| Code                | Recoverable | Trigger                                                                                                                                                                          |
| ------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DISK_WRITE_FAILED` | true        | File missing, permission denied, JSON parse error, or unrecognised extension. Reused (rather than introducing a `READ_FAILED` code) so existing client error tables remain valid |

## Performance contract

- Heap & trace summaries do **not** load the full file into memory when
  the parser supports streaming (heap uses `meta.node_fields` stride
  scan; trace falls back to byte-counting if the parser fails).
- Response summary reads the whole file once into memory, then returns
  a 4 KiB byte slice — fine for the 2-MB cap that triggered the
  persistence in the first place.
