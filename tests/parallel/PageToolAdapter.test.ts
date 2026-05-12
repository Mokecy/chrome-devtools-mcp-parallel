/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for PageToolAdapter schema derivation and dispatch error paths.
 * T038 + T045.
 */

import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {z as zod} from 'zod';

import {InstanceMutex} from '../../src/parallel/InstanceMutex.js';
import {InstanceRegistry} from '../../src/parallel/InstanceRegistry.js';
import {derivePageTool} from '../../src/parallel/PageToolAdapter.js';
import {PerInstance} from '../../src/parallel/PerInstance.js';
import type {Instance, ParallelServerArgs} from '../../src/parallel/types.js';
import type {ToolDefinition} from '../../src/tools/ToolDefinition.js';

function makeFakeUpstream(name: string): ToolDefinition {
  return {
    name,
    description: `Do ${name} things`,
    schema: {
      url: zod.string().describe('URL to navigate'),
    },
    handler: async () => {
      /* stub */
    },
    annotations: {
      title: name,
      readOnlyHint: true,
      category: 'core',
      conditions: [],
    },
    blockedByDialog: false,
  } as unknown as ToolDefinition;
}

function makeDeps() {
  return {
    registry: new InstanceRegistry(),
    mutex: new InstanceMutex(),
    serverArgs: {} as unknown as ParallelServerArgs,
  };
}

describe('PageToolAdapter', () => {
  describe('schema derivation', () => {
    it('derived name is page_<upstream>', () => {
      const derived = derivePageTool(
        makeFakeUpstream('navigate_page'),
        makeDeps(),
      );
      assert.equal(derived.name, 'page_navigate_page');
    });

    it('description has [Parallel] prefix', () => {
      const derived = derivePageTool(makeFakeUpstream('click'), makeDeps());
      assert.ok(derived.description.startsWith('[Parallel]'));
      assert.ok(derived.description.includes('operates on specified instance'));
    });

    it('schema has instanceId as first key', () => {
      const derived = derivePageTool(makeFakeUpstream('fill'), makeDeps());
      const keys = Object.keys(derived.schema);
      assert.equal(keys[0], 'instanceId');
    });

    it('schema preserves upstream fields after instanceId', () => {
      const derived = derivePageTool(
        makeFakeUpstream('navigate_page'),
        makeDeps(),
      );
      const keys = Object.keys(derived.schema);
      assert.ok(keys.includes('url'));
    });
  });

  describe('dispatch error paths', () => {
    it('missing instanceId returns error', async () => {
      const derived = derivePageTool(makeFakeUpstream('click'), makeDeps());
      const result = await derived.dispatch({});
      assert.equal(result.isError, true);
      assert.ok(
        result.content[0].type === 'text' &&
          result.content[0].text.includes('instanceId is required'),
      );
    });

    it('nonexistent instance returns error', async () => {
      const derived = derivePageTool(makeFakeUpstream('click'), makeDeps());
      const result = await derived.dispatch({instanceId: 'nope'});
      assert.equal(result.isError, true);
      assert.ok(
        result.content[0].type === 'text' &&
          result.content[0].text.includes('not found'),
      );
    });

    it('dead instance returns INSTANCE_DEAD structured error (T045)', async () => {
      const deps = makeDeps();
      const stubInstance: Instance = new PerInstance({
        id: 'down',
        mode: 'launch',
        browser: null,
        context: {} as Instance['context'],
        contextId: '',
        downloadPath: '/tmp',
        mcpContext: {} as Instance['mcpContext'],
      });
      stubInstance.setState('dead', 'simulated');
      deps.registry.add(stubInstance);

      const derived = derivePageTool(makeFakeUpstream('click'), deps);
      const result = await derived.dispatch({instanceId: 'down'});
      assert.equal(result.isError, true);
      assert.ok(result.content[0].type === 'text');
      // FR-013 / FR-018 — structured payload + recovery hint.
      const sc = Reflect.get(result, 'structuredContent');
      assert.ok(sc, 'should carry structuredContent');
      assert.equal(Reflect.get(sc, 'code'), 'INSTANCE_DEAD');
      assert.equal(Reflect.get(sc, 'recoverable'), true);
      assert.match(String(Reflect.get(sc, 'nextAction')), /instance_recreate/);
    });
  });
});
