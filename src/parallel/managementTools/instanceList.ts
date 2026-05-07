/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * instance_list management tool.
 * See specs/001-parallel-instances/contracts/management-tools.md §3.
 */

import type {CallToolResult} from '../../third_party/index.js';
import type {InstanceRegistry} from '../InstanceRegistry.js';

export async function instanceList(
  registry: InstanceRegistry,
): Promise<CallToolResult> {
  const instances = registry.list();

  if (instances.length === 0) {
    return {
      content: [{type: 'text', text: 'No active instances.'}],
    };
  }

  const lines: string[] = [`Instances (${instances.length}):`];

  for (const inst of instances) {
    let url = '?';
    let title = '?';
    try {
      const pages = await inst.context.pages();
      const page = pages[inst.selectedPageIdx] ?? pages[0];
      if (page) {
        url = page.url();
        title = await page.title().catch(() => '?');
      }
    } catch {
      // Fallback to placeholder on failure
    }

    lines.push(
      `- ${inst.id}   [mode=${inst.mode}]   url=${url}   title="${title}"   createdAt=${inst.createdAt.toISOString()}   available=${inst.available}`,
    );
  }

  return {
    content: [{type: 'text', text: lines.join('\n')}],
  };
}
