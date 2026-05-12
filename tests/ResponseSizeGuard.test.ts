/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * T024: ResponseSizeGuard unit tests (FR-008 / SC-002).
 */

import assert from 'node:assert';
import {existsSync, readFileSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {after, before, describe, it} from 'node:test';

import {ArtifactDirManager} from '../src/utils/artifactDir.js';
import {
  applyResponseSizeGuard,
  estimateResponseBytes,
} from '../src/utils/responseSizeGuard.js';

describe('ResponseSizeGuard (T024)', () => {
  let workDir: string;
  let artifactDir: ArtifactDirManager;

  before(() => {
    workDir = mkdtempSync(path.join(tmpdir(), 'response-guard-test-'));
    artifactDir = new ArtifactDirManager({persistentRoot: workDir});
  });

  after(() => {
    try {
      rmSync(workDir, {recursive: true, force: true});
      artifactDir.cleanupEphemeral();
    } catch {
      // best-effort
    }
  });

  it('passes through small responses unchanged', () => {
    const result = {
      content: [{type: 'text' as const, text: 'hello'}],
    };
    const out = applyResponseSizeGuard(result, {
      artifactDir,
      maxBytes: 1024,
      instanceId: 'inst-1',
      toolName: 'page_navigate',
    });
    assert.strictEqual(out.truncated, false);
    assert.strictEqual(out.result, result, 'must return original by reference');
  });

  it('persists oversize responses to disk and returns descriptor', () => {
    const huge = 'a'.repeat(5 * 1024); // 5 KB string
    const result = {
      content: [{type: 'text' as const, text: huge}],
    };
    const original = estimateResponseBytes(result);
    const out = applyResponseSizeGuard(result, {
      artifactDir,
      maxBytes: 1024,
      instanceId: 'inst-1',
      toolName: 'page_take_screenshot',
    });
    assert.strictEqual(out.truncated, true);
    assert.strictEqual(out.originalSize, original);
    assert.ok(out.filePath, 'filePath must be set');
    assert.ok(existsSync(out.filePath), 'persisted file must exist');

    // The persisted file must contain the *original* result.
    const persisted = JSON.parse(readFileSync(out.filePath, 'utf8'));
    assert.deepStrictEqual(persisted, result);

    // The replacement result must be small and informative.
    const replacedSize = estimateResponseBytes(out.result);
    assert.ok(
      replacedSize < 1024,
      `replacement size ${replacedSize} must stay under cap`,
    );
    assert.ok(
      out.result.content[0].type === 'text' &&
        out.result.content[0].text.includes('persisted to'),
      'replacement must reference the persisted path',
    );

    // Schema-level back-compat: structuredContent.responseGuard is additive.
    const sc = (out.result as {structuredContent?: Record<string, unknown>})
      .structuredContent;
    assert.ok(sc && typeof sc === 'object');
    const guard = (sc as {responseGuard?: Record<string, unknown>})
      .responseGuard;
    assert.ok(guard);
    assert.strictEqual(guard.truncated, true);
    assert.strictEqual(guard.filePath, out.filePath);
    assert.strictEqual(guard.originalSize, original);
  });

  it('preserves isError flag on the replacement', () => {
    const huge = 'a'.repeat(5 * 1024);
    const result = {
      isError: true,
      content: [{type: 'text' as const, text: huge}],
    };
    const out = applyResponseSizeGuard(result, {
      artifactDir,
      maxBytes: 1024,
      instanceId: 'inst-2',
      toolName: 'page_evaluate',
    });
    assert.strictEqual(out.truncated, true);
    assert.strictEqual(out.result.isError, true);
  });

  it('disables guard when maxBytes <= 0', () => {
    const huge = 'a'.repeat(10 * 1024);
    const result = {content: [{type: 'text' as const, text: huge}]};
    const out = applyResponseSizeGuard(result, {
      artifactDir,
      maxBytes: 0,
      instanceId: 'inst-3',
      toolName: 'noop',
    });
    assert.strictEqual(out.truncated, false);
    assert.strictEqual(out.result, result);
  });
});
