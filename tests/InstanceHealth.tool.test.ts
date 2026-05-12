/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * T046 — instance_health management tool.
 *
 * Pure-registry tool; no Chrome needed. Asserts the structured payload
 * mirrors `registry.snapshotHealth()` and the human-readable text body
 * lists every instance with its state envelope.
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {InstanceRegistry} from '../src/parallel/InstanceRegistry.js';
import {instanceHealth} from '../src/parallel/managementTools/instanceHealth.js';
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

describe('instance_health (T046)', () => {
  it('reports "No active instances." when registry is empty', async () => {
    const reg = new InstanceRegistry();
    const result = await instanceHealth(reg);
    assert.equal(result.content[0].type, 'text');
    if (result.content[0].type === 'text') {
      assert.match(result.content[0].text, /No active instances\./);
    }
    const sc = result.structuredContent;
    assert.ok(sc && typeof sc === 'object');
    assert.deepEqual(Reflect.get(sc, 'instances'), []);
  });

  it('returns a structured snapshot per instance + text summary', async () => {
    const reg = new InstanceRegistry();
    reg.add(makeInstance('alpha', 'cdp'));
    reg.add(makeInstance('beta'));
    reg.setState('beta', 'reconnecting', new Error('hangup'));

    const result = await instanceHealth(reg);
    assert.equal(result.content[0].type, 'text');
    if (result.content[0].type === 'text') {
      const text = result.content[0].text;
      assert.match(text, /Instance health \(2\)/);
      assert.match(text, /alpha .* state=ready/);
      assert.match(
        text,
        /beta .* state=reconnecting .* reconnectAttempts=1 .* lastError="hangup"/,
      );
    }

    const sc = result.structuredContent;
    assert.ok(sc && typeof sc === 'object');
    const instances = Reflect.get(sc, 'instances');
    assert.ok(Array.isArray(instances));
    assert.equal(instances.length, 2);
    assert.equal(instances[0].id, 'alpha');
    assert.equal(instances[0].state, 'ready');
    assert.equal(instances[1].id, 'beta');
    assert.equal(instances[1].state, 'reconnecting');
    assert.equal(instances[1].reconnectAttempts, 1);
    assert.equal(instances[1].lastError, 'hangup');
    assert.equal(instances[1].spawnedByService, true);
  });
});
