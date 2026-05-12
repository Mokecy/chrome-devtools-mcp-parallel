/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Notifier (T054 / FR-024).
 *
 * Bridges per-instance lifecycle state changes onto the MCP server's
 * logging-notification channel so subscribed clients can react in real
 * time without polling `instance_health`. The MCP protocol's resource
 * subscription model is heavier (requires per-instance URIs and a server
 * resource registry) — for stability hardening we use logging notifications
 * which are already declared in `capabilities.logging`.
 *
 * Each transition produces a structured payload:
 *
 * ```json
 * {
 *   "kind": "instance_state_change",
 *   "instanceId": "agent-7",
 *   "prev": "ready",
 *   "next": "reconnecting",
 *   "lastError": "browser disconnected",
 *   "reconnectAttempts": 1,
 *   "at": "2026-..."
 * }
 * ```
 *
 * Wire-up:
 *   const notifier = new Notifier(server, registry);
 *   notifier.attach();
 *   // ... server lifetime ...
 *   notifier.detach();
 */

import {logger} from '../logger.js';
import type {McpServer} from '../third_party/index.js';

import type {InstanceRegistry} from './InstanceRegistry.js';
import type {Instance, InstanceState} from './types.js';

interface InstanceStateChangePayload {
  readonly kind: 'instance_state_change';
  readonly instanceId: string;
  readonly prev: InstanceState;
  readonly next: InstanceState;
  readonly lastError: string | null;
  readonly reconnectAttempts: number;
  readonly at: string;
}

/** Map our internal state → MCP logging severity. */
function severityFor(next: InstanceState): 'info' | 'warning' | 'error' {
  switch (next) {
    case 'ready':
      return 'info';
    case 'reconnecting':
      return 'warning';
    case 'dead':
      return 'error';
  }
}

export class Notifier {
  readonly #server: McpServer;
  readonly #registry: InstanceRegistry;
  #disposer: (() => void) | null = null;

  constructor(server: McpServer, registry: InstanceRegistry) {
    this.#server = server;
    this.#registry = registry;
  }

  attach(): void {
    if (this.#disposer) {
      return;
    }
    this.#disposer = this.#registry.addStateChangeListener(
      (instance, prev, next) => {
        this.#emit(instance, prev, next);
      },
    );
  }

  detach(): void {
    if (this.#disposer) {
      this.#disposer();
      this.#disposer = null;
    }
  }

  #emit(instance: Instance, prev: InstanceState, next: InstanceState): void {
    const payload: InstanceStateChangePayload = {
      kind: 'instance_state_change',
      instanceId: instance.id,
      prev,
      next,
      lastError: instance.lastError,
      reconnectAttempts: instance.reconnectAttempts,
      at: new Date().toISOString(),
    };

    // The MCP McpServer wraps the underlying low-level server; we call
    // the inner server's notification helper. If the transport is gone
    // (shutdown race), swallow + log locally so no listener error
    // propagates back into the registry.
    try {
      const inner = this.#server.server;
      void inner.sendLoggingMessage({
        level: severityFor(next),
        logger: 'chrome-devtools-mcp-parallel',
        data: payload,
      });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      logger(`Notifier: failed to emit state change: ${reason}`);
    }
  }
}
