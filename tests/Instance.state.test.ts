/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * T039 — Instance state machine (FR-012).
 *
 * Verifies the `PerInstance` lifecycle:
 *   ready → reconnecting → ready / dead   (legal)
 *   ready → dead                            (legal — markUnavailable)
 *   dead  → anything                        (illegal)
 *   ready → ready                           (idempotent)
 *
 * Plus: `available` derived flag, reconnectAttempts counter, lastError /
 * lastHealthyAt bookkeeping, and snapshotHealth shape.
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {PerInstance} from '../src/parallel/PerInstance.js';
import type {Instance} from '../src/parallel/types.js';

function makeInstance(id = 'inst-1'): Instance {
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

describe('Instance state machine (T039)', () => {
  it('starts in `ready` with available=true and no errors', () => {
    const inst = makeInstance();
    assert.equal(inst.state, 'ready');
    assert.equal(inst.available, true);
    assert.equal(inst.lastError, null);
    assert.equal(inst.reconnectAttempts, 0);
    assert.ok(inst.lastHealthyAt instanceof Date);
  });

  it('ready → reconnecting increments reconnectAttempts and stores lastError', () => {
    const inst = makeInstance();
    inst.setState('reconnecting', new Error('socket hangup'));
    assert.equal(inst.state, 'reconnecting');
    assert.equal(inst.available, false);
    assert.equal(inst.lastError, 'socket hangup');
    assert.equal(inst.reconnectAttempts, 1);
  });

  it('reconnecting → ready resets attempts, clears error, refreshes lastHealthyAt', async () => {
    const inst = makeInstance();
    const t0 = inst.lastHealthyAt.getTime();
    inst.setState('reconnecting', 'transient');
    await new Promise(resolve => setTimeout(resolve, 5));
    inst.setState('ready');
    assert.equal(inst.state, 'ready');
    assert.equal(inst.available, true);
    assert.equal(inst.lastError, null);
    assert.equal(inst.reconnectAttempts, 0);
    assert.ok(
      inst.lastHealthyAt.getTime() > t0,
      'lastHealthyAt should advance after a successful reconnect',
    );
  });

  it('ready → dead is legal (hard kill path)', () => {
    const inst = makeInstance();
    inst.setState('dead', 'browser process exited');
    assert.equal(inst.state, 'dead');
    assert.equal(inst.available, false);
    assert.equal(inst.lastError, 'browser process exited');
  });

  it('reconnecting → dead is legal (circuit breaker)', () => {
    const inst = makeInstance();
    inst.setState('reconnecting');
    inst.setState('dead', 'max attempts reached');
    assert.equal(inst.state, 'dead');
    assert.equal(inst.lastError, 'max attempts reached');
  });

  it('dead → anything throws — terminal state', () => {
    const inst = makeInstance();
    inst.setState('dead', 'rip');
    assert.throws(() => inst.setState('ready'), /Illegal instance state/);
    assert.throws(
      () => inst.setState('reconnecting'),
      /Illegal instance state/,
    );
  });

  it('idempotent transition is a no-op but refreshes lastError when given', () => {
    const inst = makeInstance();
    inst.setState('reconnecting', 'first');
    const beforeAttempts = inst.reconnectAttempts;
    inst.setState('reconnecting', 'second');
    assert.equal(
      inst.reconnectAttempts,
      beforeAttempts,
      'must not double-count',
    );
    assert.equal(inst.lastError, 'second');
  });

  it('legacy `available = false` parks in reconnecting (watchdog hint)', () => {
    const inst = makeInstance();
    inst.available = false;
    assert.equal(inst.state, 'reconnecting');
    inst.available = true;
    assert.equal(inst.state, 'ready');
  });

  it('legacy `available = true` cannot resurrect a dead instance', () => {
    const inst = makeInstance();
    inst.setState('dead');
    inst.available = true;
    assert.equal(inst.state, 'dead');
    assert.equal(inst.available, false);
  });

  it('snapshotHealth returns ISO timestamps + state envelope', () => {
    const inst = makeInstance('snap-1');
    inst.setState('reconnecting', 'flaky');
    const snap = inst.snapshotHealth();
    assert.equal(snap.id, 'snap-1');
    assert.equal(snap.mode, 'launch');
    assert.equal(snap.state, 'reconnecting');
    assert.equal(snap.lastError, 'flaky');
    assert.equal(snap.reconnectAttempts, 1);
    assert.equal(snap.spawnedByService, false);
    assert.match(snap.lastHealthyAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.match(snap.createdAt, /^\d{4}-\d{2}-\d{2}T/);
  });
});
