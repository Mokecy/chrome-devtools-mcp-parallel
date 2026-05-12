/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * T054 — Notifier unit test.
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {InstanceRegistry} from '../../src/parallel/InstanceRegistry.js';
import {Notifier} from '../../src/parallel/Notifier.js';
import {PerInstance} from '../../src/parallel/PerInstance.js';
import type {Instance} from '../../src/parallel/types.js';
import type {McpServer} from '../../src/third_party/index.js';

interface CapturedLog {
  level: string;
  logger?: string;
  data: unknown;
}

function makeFakeServer(): {server: McpServer; logs: CapturedLog[]} {
  const logs: CapturedLog[] = [];
  const inner = {
    sendLoggingMessage(msg: CapturedLog): Promise<void> {
      logs.push(msg);
      return Promise.resolve();
    },
  };
  const server = {server: inner} as unknown as McpServer;
  return {server, logs};
}

function makeInstance(id: string): PerInstance {
  return new PerInstance({
    id,
    mode: 'launch',
    browser: null,
    context: {} as Instance['context'],
    contextId: '',
    downloadPath: `/tmp/${id}`,
    mcpContext: {} as Instance['mcpContext'],
  });
}

describe('Notifier (T054)', () => {
  it('emits a logging notification on every state change', () => {
    const reg = new InstanceRegistry();
    const inst = makeInstance('n1');
    reg.add(inst);

    const {server, logs} = makeFakeServer();
    const n = new Notifier(server, reg);
    n.attach();

    reg.setState('n1', 'reconnecting', 'transport drop');
    reg.setState('n1', 'ready');
    reg.setState('n1', 'dead', 'final');

    assert.equal(logs.length, 3);

    const first = logs[0];
    assert.equal(first.level, 'warning');
    const data = first.data as Record<string, unknown>;
    assert.equal(data['kind'], 'instance_state_change');
    assert.equal(data['instanceId'], 'n1');
    assert.equal(data['prev'], 'ready');
    assert.equal(data['next'], 'reconnecting');
    assert.equal(data['lastError'], 'transport drop');

    assert.equal(logs[1].level, 'info');
    assert.equal(logs[2].level, 'error');
  });

  it('skips identical (no-op) transitions', () => {
    const reg = new InstanceRegistry();
    const inst = makeInstance('n2');
    reg.add(inst);

    const {server, logs} = makeFakeServer();
    new Notifier(server, reg).attach();

    // ready → ready is idempotent and must NOT emit.
    reg.setState('n2', 'ready');
    assert.equal(logs.length, 0);

    reg.setState('n2', 'reconnecting');
    assert.equal(logs.length, 1);
  });

  it('detach() stops emissions', () => {
    const reg = new InstanceRegistry();
    const inst = makeInstance('n3');
    reg.add(inst);

    const {server, logs} = makeFakeServer();
    const n = new Notifier(server, reg);
    n.attach();
    n.detach();

    reg.setState('n3', 'reconnecting');
    assert.equal(logs.length, 0);
  });

  it('listener errors do not break setState', () => {
    const reg = new InstanceRegistry();
    const inst = makeInstance('n4');
    reg.add(inst);

    reg.addStateChangeListener(() => {
      throw new Error('listener boom');
    });

    // Must not throw.
    reg.setState('n4', 'reconnecting');
    assert.equal(inst.state, 'reconnecting');
  });
});
