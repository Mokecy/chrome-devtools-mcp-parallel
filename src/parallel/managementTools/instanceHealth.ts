/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * instance_health management tool (T056 / FR-016).
 *
 * Returns a structured health snapshot of every registered instance —
 * lifecycle state, last error, last healthy timestamp, reconnect counter,
 * and whether the service spawned the underlying browser. Designed to be
 * cheap (pure registry read; no Chrome roundtrip) so callers can poll it
 * during recovery flows without disturbing live work.
 */

import type {CallToolResult} from '../../third_party/index.js';
import type {InstanceRegistry} from '../InstanceRegistry.js';
import type {InstanceHealthSnapshot} from '../types.js';

function formatLine(s: InstanceHealthSnapshot): string {
  const err = s.lastError ? ` lastError="${s.lastError}"` : '';
  return (
    `- ${s.id}   [mode=${s.mode}]   state=${s.state}` +
    `   reconnectAttempts=${s.reconnectAttempts}` +
    `   lastHealthyAt=${s.lastHealthyAt}` +
    `   spawnedByService=${s.spawnedByService}` +
    err
  );
}

export async function instanceHealth(
  registry: InstanceRegistry,
): Promise<CallToolResult> {
  const snapshots = registry.snapshotHealth();
  const lines: string[] =
    snapshots.length === 0
      ? ['No active instances.']
      : [
          `Instance health (${snapshots.length}):`,
          ...snapshots.map(formatLine),
        ];

  return {
    content: [{type: 'text', text: lines.join('\n')}],
    structuredContent: {
      instances: snapshots,
    },
  };
}
