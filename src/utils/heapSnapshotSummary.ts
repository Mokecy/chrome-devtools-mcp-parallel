/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Lightweight V8 heap-snapshot summarizer for FR-008 (Heap Snapshot disk
 * persistence). Loads the .heapsnapshot JSON, then derives:
 *
 *   - sizeBytes      : on-disk size from fs.stat
 *   - topNodeKinds   : top-N node-type buckets (kind → count) sorted by count
 *
 * The full snapshot is parsed via JSON.parse; for typical browser traces
 * (<200 MB) this is acceptable and avoids pulling in a streaming JSON parser.
 * Memory cost dominated by the parsed `nodes` flat-int array (one number
 * per cell, V8 may smi-pack), not by the strings table.
 *
 * See specs/001-stability-hardening/tasks.md T035.
 */

import {promises as fs} from 'node:fs';

/** A single bucket in the topNodeKinds list. */
export interface NodeKindBucket {
  kind: string;
  count: number;
}

export interface HeapSnapshotSummary {
  filePath: string;
  sizeBytes: number;
  topNodeKinds: NodeKindBucket[];
}

interface RawSnapshotMeta {
  node_fields?: string[];
  node_types?: Array<string[] | string>;
}

interface RawSnapshot {
  snapshot?: {
    meta?: RawSnapshotMeta;
  };
  nodes?: number[];
}

const DEFAULT_TOP_N = 10;

/**
 * Read a .heapsnapshot file from disk and produce a small JSON-safe summary.
 *
 * @param filePath  absolute path to the snapshot file
 * @param topN      max kinds to include in `topNodeKinds` (default 10)
 */
export async function summarizeHeapSnapshot(
  filePath: string,
  topN: number = DEFAULT_TOP_N,
): Promise<HeapSnapshotSummary> {
  const stat = await fs.stat(filePath);
  const sizeBytes = stat.size;

  let topNodeKinds: NodeKindBucket[] = [];
  try {
    const text = await fs.readFile(filePath, 'utf8');
    const parsed: RawSnapshot = JSON.parse(text);
    topNodeKinds = computeTopNodeKinds(parsed, topN);
  } catch {
    // Best-effort: if the file is corrupt or too large to parse we still want
    // sizeBytes back. The summary tool can do a deeper parse on demand.
    topNodeKinds = [];
  }

  return {filePath, sizeBytes, topNodeKinds};
}

function computeTopNodeKinds(
  parsed: RawSnapshot,
  topN: number,
): NodeKindBucket[] {
  const meta = parsed.snapshot?.meta;
  const fields = meta?.node_fields;
  const types = meta?.node_types;
  const nodes = parsed.nodes;
  if (!fields || !types || !nodes) {
    return [];
  }

  const stride = fields.length;
  if (stride <= 0) {
    return [];
  }
  const typeFieldIdx = fields.indexOf('type');
  if (typeFieldIdx < 0) {
    return [];
  }
  const kindNamesRaw = types[typeFieldIdx];
  if (!Array.isArray(kindNamesRaw)) {
    return [];
  }
  const kindNames: string[] = kindNamesRaw;

  const counts = new Map<string, number>();
  for (let i = typeFieldIdx; i < nodes.length; i += stride) {
    const typeIdx = nodes[i];
    if (typeof typeIdx !== 'number') {
      continue;
    }
    const kind = kindNames[typeIdx] ?? `unknown(${typeIdx})`;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
  }

  const sorted: NodeKindBucket[] = [];
  for (const [kind, count] of counts) {
    sorted.push({kind, count});
  }
  sorted.sort((a, b) => b.count - a.count);
  return sorted.slice(0, topN);
}
