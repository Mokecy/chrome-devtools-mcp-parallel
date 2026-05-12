/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {InstanceRegistry} from '../../src/parallel/InstanceRegistry.js';
import {PerInstance} from '../../src/parallel/PerInstance.js';
import type {Instance} from '../../src/parallel/types.js';

function makeStubInstance(
  id: string,
  mode: 'cdp' | 'launch' = 'launch',
): Instance {
  // Use real PerInstance so the FR-012 state machine fires; opaque
  // BrowserContext / McpContext are fine since the registry only touches
  // identity + state.
  return new PerInstance({
    id,
    mode,
    browser: null,
    context: {} as Instance['context'],
    contextId: '',
    downloadPath: `/tmp/test/${id}`,
    mcpContext: {} as Instance['mcpContext'],
  });
}

describe('InstanceRegistry', () => {
  it('add and get', () => {
    const reg = new InstanceRegistry();
    const inst = makeStubInstance('task-1');
    reg.add(inst);
    assert.equal(reg.get('task-1'), inst);
    assert.equal(reg.size(), 1);
  });

  it('throws on duplicate id', () => {
    const reg = new InstanceRegistry();
    reg.add(makeStubInstance('dup'));
    assert.throws(() => reg.add(makeStubInstance('dup')), /already exists/);
  });

  it('throws when exceeding max instances', () => {
    const reg = new InstanceRegistry(2);
    reg.add(makeStubInstance('a'));
    reg.add(makeStubInstance('b'));
    assert.throws(
      () => reg.add(makeStubInstance('c')),
      /Maximum instance limit/,
    );
  });

  it('list returns all instances', () => {
    const reg = new InstanceRegistry();
    reg.add(makeStubInstance('x'));
    reg.add(makeStubInstance('y'));
    const list = reg.list();
    assert.equal(list.length, 2);
    const ids = list.map(i => i.id).sort();
    assert.deepEqual(ids, ['x', 'y']);
  });

  it('remove deletes instance', () => {
    const reg = new InstanceRegistry();
    reg.add(makeStubInstance('r'));
    assert.equal(reg.remove('r'), true);
    assert.equal(reg.get('r'), undefined);
    assert.equal(reg.size(), 0);
  });

  it('remove returns false for nonexistent id', () => {
    const reg = new InstanceRegistry();
    assert.equal(reg.remove('nope'), false);
  });

  it('refreshCdpBrowser updates all cdp instances', () => {
    const reg = new InstanceRegistry();
    const cdpInst = makeStubInstance('c1', 'cdp');
    cdpInst.available = false;
    const launchInst = makeStubInstance('l1', 'launch');
    launchInst.available = false;
    reg.add(cdpInst);
    reg.add(launchInst);

    const fakeBrowser = {
      version: () => 'new',
    } as unknown as Instance['browser'];
    reg.refreshCdpBrowser(fakeBrowser!);

    // CDP instance gets new browser and available = true
    assert.equal(cdpInst.browser, fakeBrowser);
    assert.equal(cdpInst.available, true);

    // Launch instance untouched
    assert.equal(launchInst.browser, null);
    assert.equal(launchInst.available, false);
  });
});
