/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * instance_close management tool.
 * See specs/001-parallel-instances/contracts/management-tools.md §4.
 */

import type {CallToolResult} from '../../third_party/index.js';
import type {InstanceRegistry} from '../InstanceRegistry.js';

export interface InstanceCloseParams {
  instanceId: string;
}

export async function instanceClose(
  params: InstanceCloseParams,
  registry: InstanceRegistry,
): Promise<CallToolResult> {
  const {instanceId} = params;

  const instance = registry.get(instanceId);
  if (!instance) {
    return {
      content: [{type: 'text', text: `Instance ${instanceId} not found.`}],
      isError: true,
    };
  }

  const mode = instance.mode;
  let warning = '';

  try {
    await instance.close();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    warning = `\nInstance ${instanceId} removed from registry but puppeteer reported: ${reason}`;
  }

  registry.remove(instanceId);

  const text = `Instance ${instanceId} closed (${mode}).${warning}`;
  return {
    content: [{type: 'text', text}],
  };
}
