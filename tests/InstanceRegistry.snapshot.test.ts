/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * T040 — InstanceRegistry.snapshotHealth + setState wiring (FR-013 / FR-016).
 *
 * Asserts:
 *   - snapshotHealth() returns one entry per registered instance, in
 *     insertion order, with the full health envelope.
 *   - registry.setState() forwards into the underlying state machine.
 *   - setState on an unknown id throws.
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {InstanceRegistry} from '../src/parallel/InstanceRegistry.js';
import {PerInstance} from '../src/parallel/PerInstance.js';
import type {Instance} from '../src/parallel/types.js';

function makeInstance(id: string, mode: 'cdp' | 'launch' = 'launch'): Instance {
  return new PerInstance({
    id,
    mode,
    browser: null,
    context: {} as Instance['context'],
    contextId: '',
    downloadPath: `/tmp/${id}`,
    mcpContext: {} as Instance['mcpContext'],
    spawnedByService: mode === 'launch',
  });
}

describe('InstanceRegistry snapshotHealth + setState (T040)', () => {
  it('snapshotHealth returns full envelope per instance, in insertion order', () => {
    const reg = new InstanceRegistry();
    const a = makeInstance('alpha', 'cdp');
    const b = makeInstance('beta', 'launch');
    reg.add(a);
    reg.add(b);

    const snaps = reg.snapshotHealth();
    assert.equal(snaps.length, 2);
    assert.deepEqual(
      snaps.map(s => s.id),
      ['alpha', 'beta'],
    );
    assert.equal(snaps[0].mode, 'cdp');
    assert.equal(snaps[0].state, 'ready');
    assert.equal(snaps[0].spawnedByService, false);
    assert.equal(snaps[0].lastError, null);
    assert.equal(snaps[0].reconnectAttempts, 0);
    assert.equal(snaps[1].spawnedByService, true);
  });

  it('setState forwards to the instance state machine', () => {
    const reg = new InstanceRegistry();
    reg.add(makeInstance('to-reconnect'));
    reg.setState('to-reconnect', 'reconnecting', new Error('boom'));

    const snap = reg.snapshotHealth()[0];
    assert.equal(snap.state, 'reconnecting');
    assert.equal(snap.lastError, 'boom');
    assert.equal(snap.reconnectAttempts, 1);
  });

  it('setState on unknown id throws (no silent drop)', () => {
    const reg = new InstanceRegistry();
    assert.throws(
      () => reg.setState('ghost', 'dead'),
      /Instance "ghost" not found/,
    );
  });

  it('reflects subsequent transitions', () => {
    const reg = new InstanceRegistry();
    reg.add(makeInstance('flap'));
    reg.setState('flap', 'reconnecting');
    reg.setState('flap', 'ready');
    reg.setState('flap', 'reconnecting', 'second hit');
    reg.setState('flap', 'dead', 'gave up');

    const snap = reg.snapshotHealth()[0];
    assert.equal(snap.state, 'dead');
    assert.equal(snap.lastError, 'gave up');
  });
});
