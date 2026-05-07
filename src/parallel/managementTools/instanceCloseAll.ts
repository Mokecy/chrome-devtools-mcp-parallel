/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * instance_close_all management tool.
 * See specs/001-parallel-instances/contracts/management-tools.md §5.
 */

import type {CallToolResult} from '../../third_party/index.js';
import type {InstanceRegistry} from '../InstanceRegistry.js';

export async function instanceCloseAll(
  registry: InstanceRegistry,
): Promise<CallToolResult> {
  const instances = registry.list();
  const count = instances.length;
  const warnings: string[] = [];

  for (const instance of instances) {
    try {
      await instance.close();
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(`Warning: ${instance.id} close failed: ${reason}`);
    }
    registry.remove(instance.id);
  }

  const lines = [`Closed ${count} instances.`, ...warnings];
  return {
    content: [{type: 'text', text: lines.join('\n')}],
  };
}
