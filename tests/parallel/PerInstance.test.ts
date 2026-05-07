/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {McpContext} from '../../src/McpContext.js';
import {PerInstance} from '../../src/parallel/PerInstance.js';
import type {PerInstanceInit} from '../../src/parallel/PerInstance.js';
import type {Browser, BrowserContext} from '../../src/third_party/index.js';

function makeInit(overrides: Partial<PerInstanceInit> = {}): PerInstanceInit {
  return {
    id: 'test-1',
    mode: 'launch',
    browser: null,
    context: {} as BrowserContext,
    contextId: '',
    downloadPath: '/tmp/test-downloads/test-1',
    mcpContext: {} as McpContext,
    ...overrides,
  };
}

describe('PerInstance', () => {
  it('constructs with correct defaults', () => {
    const inst = new PerInstance(makeInit({id: 'my-id', mode: 'cdp'}));
    assert.equal(inst.id, 'my-id');
    assert.equal(inst.mode, 'cdp');
    assert.equal(inst.selectedPageIdx, 0);
    assert.equal(inst.prevSnapshot, null);
    assert.equal(inst.prevSnapshotOrigin, null);
    assert.equal(inst.available, true);
    assert.ok(inst.createdAt instanceof Date);
  });

  it('markUnavailable sets available to false', () => {
    const inst = new PerInstance(makeInit());
    inst.markUnavailable();
    assert.equal(inst.available, false);
  });

  it('markAvailable sets available to true', () => {
    const inst = new PerInstance(makeInit());
    inst.markUnavailable();
    inst.markAvailable();
    assert.equal(inst.available, true);
  });

  it('close in CDP mode calls context.close()', async () => {
    let contextClosed = false;
    const fakeContext = {
      close: async () => {
        contextClosed = true;
      },
    } as unknown as BrowserContext;

    const inst = new PerInstance(makeInit({mode: 'cdp', context: fakeContext}));
    await inst.close();

    assert.equal(contextClosed, true);
    assert.equal(inst.available, false);
  });

  it('close in launch mode calls browser.close()', async () => {
    let browserClosed = false;
    const fakeBrowser = {
      close: async () => {
        browserClosed = true;
      },
    } as unknown as Browser;
    const fakeContext = {
      close: async () => {
        throw new Error('should not close context in launch mode');
      },
    } as unknown as BrowserContext;

    const inst = new PerInstance(
      makeInit({mode: 'launch', browser: fakeBrowser, context: fakeContext}),
    );
    await inst.close();

    assert.equal(browserClosed, true);
    assert.equal(inst.available, false);
  });

  it('close in launch mode with null browser does not throw', async () => {
    const inst = new PerInstance(makeInit({mode: 'launch', browser: null}));
    await inst.close(); // should not throw
    assert.equal(inst.available, false);
  });
});
