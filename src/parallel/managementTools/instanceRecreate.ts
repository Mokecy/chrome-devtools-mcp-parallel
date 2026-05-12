/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * instance_recreate management tool (T057 / FR-014).
 *
 * Hard-rebuilds a registered instance under the same id, reusing the
 * deterministic downloadPath that `instanceCreate` derives from the id.
 * Idiomatic recovery flow after the watchdog has parked an instance in
 * `dead` (e.g. browser process exited, CDP socket gone permanently):
 *
 *   1. look up the existing instance (id must already exist)
 *   2. tear down any leftover browser / context (best-effort, swallow errs)
 *   3. drop the entry from the registry
 *   4. delegate to `instanceCreate` with the same id (and an optional
 *      starting URL); it will spawn a fresh browser, build a new
 *      `McpContext`, re-apply auth + badge.
 */

import type {CallToolResult} from '../../third_party/index.js';
import type {AuthStateHolder} from '../AuthState.js';
import type {ConnectionWatchdog} from '../ConnectionWatchdog.js';
import type {InstanceRegistry} from '../InstanceRegistry.js';
import type {ConnectedBrowser, ParallelServerArgs} from '../types.js';

import {instanceCreate} from './instanceCreate.js';

export interface InstanceRecreateParams {
  instanceId: string;
  /** Optional URL to load after the new browser is up. */
  url?: string;
  /** Pass through the auth-cloning toggle. Defaults to true. */
  cloneAuth?: boolean;
  /** Force CDP / launch (else uses the same default rules as `instanceCreate`). */
  useCDP?: boolean;
}

export interface InstanceRecreateDeps {
  registry: InstanceRegistry;
  serverArgs: ParallelServerArgs;
  connectedBrowser: ConnectedBrowser | null;
  authStateHolder?: AuthStateHolder;
  /** Optional watchdog reference forwarded to `instanceCreate` for crash auto-recovery wiring. */
  watchdog?: ConnectionWatchdog;
}

export async function instanceRecreate(
  params: InstanceRecreateParams,
  deps: InstanceRecreateDeps,
): Promise<CallToolResult> {
  const {instanceId, url, cloneAuth, useCDP} = params;

  if (!instanceId || instanceId.trim().length === 0) {
    return {
      content: [{type: 'text', text: 'instanceId must be a non-empty string.'}],
      isError: true,
    };
  }

  const existing = deps.registry.get(instanceId);
  if (!existing) {
    return {
      content: [
        {
          type: 'text',
          text:
            `Instance "${instanceId}" not found. ` +
            `Use instance_create for a fresh id, or instance_list to see what's tracked.`,
        },
      ],
      isError: true,
    };
  }

  const lines: string[] = [];
  const previousState = existing.state;
  const previousMode = existing.mode;

  // Step 1–3: tear down + de-register the dead/broken instance.
  try {
    await existing.close();
  } catch (err) {
    // Stale browser handles are expected here — log + continue.
    const reason = err instanceof Error ? err.message : String(err);
    lines.push(`Best-effort close of ${instanceId} failed: ${reason}`);
  }
  deps.registry.remove(instanceId);

  lines.push(
    `Recreating instance ${instanceId} (was state=${previousState}, mode=${previousMode}).`,
  );

  // Step 4: delegate to the standard creation path so we share the auth +
  // badge + permissions wiring.
  const created = await instanceCreate(
    {instanceId, url, cloneAuth, useCDP},
    {
      registry: deps.registry,
      serverArgs: deps.serverArgs,
      connectedBrowser: deps.connectedBrowser,
      authStateHolder: deps.authStateHolder,
      watchdog: deps.watchdog,
    },
  );

  // Splice the recreate prelude into the wrapped result so callers see
  // the full story without losing the structured isError flag.
  if (created.content[0] && created.content[0].type === 'text') {
    const original = created.content[0];
    if ('text' in original) {
      const merged = `${lines.join('\n')}\n${original.text}`.trim();
      original.text = merged;
    }
  }
  return created;
}
