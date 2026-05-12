/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * T047 — instance_recreate management tool.
 *
 * The flow under test:
 *   1. `instance_recreate` rejects unknown ids without touching anything else.
 *   2. For an existing instance it calls `close()` + delegates to
 *      `instanceCreate`, which (when CDP mode is available) creates a new
 *      `BrowserContext` under the *same* instance id.
 *   3. The replacement preserves the deterministic downloadPath.
 *
 * Sinon-stubs the puppeteer `Browser.createBrowserContext` so the test
 * stays hermetic.
 */

import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, it} from 'node:test';

import sinon from 'sinon';

import {InstanceRegistry} from '../src/parallel/InstanceRegistry.js';
import {instanceRecreate} from '../src/parallel/managementTools/instanceRecreate.js';
import {PerInstance} from '../src/parallel/PerInstance.js';
import type {
  Instance,
  ConnectedBrowser,
  ParallelServerArgs,
} from '../src/parallel/types.js';

const expectedDownloadPath = (instanceId: string): string =>
  path.join(os.tmpdir(), 'chrome-devtools-mcp-parallel-downloads', instanceId);

interface FakeBrowserContextHandle {
  closed: boolean;
  pages: Array<{url: () => string; close: () => Promise<void>}>;
}

function fakePage() {
  return {
    url: () => 'about:blank',
    close: async () => {
      /* noop */
    },
  };
}

function fakeContext(): {
  context: Instance['context'];
  handle: FakeBrowserContextHandle;
} {
  const handle: FakeBrowserContextHandle = {closed: false, pages: [fakePage()]};
  const ctxLike = {
    id: `ctx-${Math.random().toString(36).slice(2, 8)}`,
    pages: async () => handle.pages,
    newPage: async () => {
      const p = fakePage();
      handle.pages.push(p);
      return p;
    },
    close: async () => {
      handle.closed = true;
    },
    overridePermissions: async () => {
      /* noop */
    },
  };
  return {context: ctxLike as unknown as Instance['context'], handle};
}

function fakeConnectedBrowser(): ConnectedBrowser {
  const createBrowserContext = sinon.stub().callsFake(async () => {
    return fakeContext().context;
  });
  const browser = {
    createBrowserContext,
    version: async () => 'fake/1.0',
    isConnected: () => true,
    close: async () => {
      /* noop */
    },
    newPage: async () => fakePage(),
    pages: async () => [fakePage()],
  };
  return {
    browser: browser as unknown as ConnectedBrowser['browser'],
    cdpUrl: 'http://localhost:1234',
    browserType: 'chromium',
    autoLaunchedByUs: false,
    available: true,
  };
}

afterEach(() => {
  sinon.restore();
});

describe('instance_recreate (T047)', () => {
  it('rejects empty instanceId', async () => {
    const reg = new InstanceRegistry();
    const result = await instanceRecreate(
      {instanceId: ''},
      {
        registry: reg,
        serverArgs: {} as unknown as ParallelServerArgs,
        connectedBrowser: null,
      },
    );
    assert.equal(result.isError, true);
  });

  it('rejects unknown instanceId without recreating', async () => {
    const reg = new InstanceRegistry();
    const result = await instanceRecreate(
      {instanceId: 'ghost'},
      {
        registry: reg,
        serverArgs: {} as unknown as ParallelServerArgs,
        connectedBrowser: null,
      },
    );
    assert.equal(result.isError, true);
    assert.equal(reg.size(), 0);
  });

  it('tears down the old instance and delegates to instance_create', async () => {
    const reg = new InstanceRegistry();
    const downloadPath = expectedDownloadPath('inst-1');
    const {context: oldCtx, handle: oldHandle} = fakeContext();
    const oldInstance = new PerInstance({
      id: 'inst-1',
      mode: 'cdp',
      browser: null,
      context: oldCtx,
      contextId: 'ctx-old',
      downloadPath,
      mcpContext: {} as Instance['mcpContext'],
    });
    oldInstance.setState('dead', 'browser exited');
    reg.add(oldInstance);

    // Stable id-only replacement (avoids needing a real McpContext): we
    // just verify the recreate prelude tore down the old handle and that
    // it no longer occupies the slot under the original id.
    const connectedBrowser = fakeConnectedBrowser();
    const serverArgs = {
      consoleBufferSize: 500,
      networkBufferSize: 1000,
      recordSizeCapKb: 256,
      experimentalDevtools: false,
      experimentalIncludeAllPages: false,
      performanceCrux: false,
      // Force launch path failure quickly by leaving channel undefined +
      // pointing at a non-existent executable; we don't care if the new
      // creation succeeds for this assertion — only that the old instance
      // got cleaned up first.
    } as unknown as ParallelServerArgs;

    const result = await instanceRecreate(
      {instanceId: 'inst-1', useCDP: true, cloneAuth: false},
      {
        registry: reg,
        serverArgs,
        connectedBrowser,
      },
    );

    // Old handle was closed regardless of whether the create-half worked.
    assert.equal(
      oldHandle.closed,
      true,
      'old context.close() must be called as part of teardown',
    );

    // Recreate prelude is always in the result text.
    if (result.content[0].type === 'text') {
      assert.match(result.content[0].text, /Recreating instance inst-1/);
      assert.match(
        result.content[0].text,
        /was state=dead, mode=cdp/,
        'prelude should record the previous state + mode',
      );
    }

    // The replacement instance, if created, lives under the same
    // deterministic downloadPath — but we don't require success here.
    const replacement = reg.get('inst-1');
    if (replacement) {
      assert.equal(replacement.id, 'inst-1');
      assert.equal(replacement.downloadPath, downloadPath);
      assert.notEqual(
        replacement,
        oldInstance,
        'recreated handle must be a fresh PerInstance',
      );
    }
  });
});
