/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * system_observe management tool (T076 / FR-024b).
 *
 * Returns the current `ObservabilitySnapshot` as both a human-readable
 * summary line and a structured JSON blob in `content`. Useful as a
 * one-shot health probe from a calling agent without parsing the
 * periodic stderr stream.
 */

import type {CallToolResult} from '../../third_party/index.js';
import type {Observability} from '../Observability.js';

export interface SystemObserveParams {
  /**
   * If true, the response embeds the rolling MemoryMonitor ring buffer
   * (up to 60 samples). Default false to keep the wire payload small.
   */
  includeMemorySamples?: boolean;
}

export async function systemObserve(
  params: SystemObserveParams,
  observability: Observability,
): Promise<CallToolResult> {
  const snap = observability.snapshot({
    includeMemorySamples: params.includeMemorySamples ?? false,
  });

  const summary = formatSummary(snap);
  const json = JSON.stringify(snap, null, 2);

  return {
    content: [{type: 'text', text: `${summary}\n\n${json}`}],
  };
}

function formatSummary(snap: {
  ts: string;
  instances: ReadonlyArray<{
    id: string;
    state: string;
    console: {retained: number; evicted: number};
    network: {retained: number; evicted: number};
  }>;
  memory: {rssMb: number; heapUsedMb: number; heapPct: number};
  artifactDir: {ephemeralBytes: number; persistentBytes: number};
}): string {
  const lines: string[] = [];
  lines.push(`system_observe @ ${snap.ts}`);
  lines.push(
    `memory: rss=${snap.memory.rssMb}MB heapUsed=${snap.memory.heapUsedMb}MB heapPct=${snap.memory.heapPct}%`,
  );
  lines.push(
    `artifactDir: ephemeral=${formatBytes(snap.artifactDir.ephemeralBytes)} persistent=${formatBytes(snap.artifactDir.persistentBytes)}`,
  );
  if (snap.instances.length === 0) {
    lines.push('instances: (none)');
  } else {
    lines.push(`instances (${snap.instances.length}):`);
    for (const inst of snap.instances) {
      lines.push(
        `  - ${inst.id}  state=${inst.state}  console=${inst.console.retained}/${inst.console.retained + inst.console.evicted}  network=${inst.network.retained}/${inst.network.retained + inst.network.evicted}`,
      );
    }
  }
  return lines.join('\n');
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes}B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)}KB`;
  }
  if (bytes < 1024 * 1024 * 1024) {
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  }
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)}GB`;
}
