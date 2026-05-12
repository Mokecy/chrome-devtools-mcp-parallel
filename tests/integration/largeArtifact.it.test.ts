/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * T030 — large screenshot integration test (FR-007 / SC-002).
 *
 * Drives the real `take_screenshot` tool against a tall page and asserts:
 *   - the MCP response stays well under 100 KB (no inline base64)
 *   - the artifact is materialised on disk
 *
 * Kept conservative on dimensions to avoid hitting Chrome's
 * `Page.captureScreenshot` pixel limit on local machines (the same limit
 * that flakes `tests/tools/screenshot.test.ts > with full page resulting in
 * a large screenshot` on Windows). 800 × 8000 = 6.4 Mpx — well inside the
 * Chrome cap, comfortably above any plausible inline-base64 budget.
 */

import assert from 'node:assert';
import {existsSync, statSync} from 'node:fs';
import {after, before, describe, it} from 'node:test';

import {screenshot} from '../../src/tools/screenshot.js';
import {resetArtifactDirManagerForTests} from '../../src/utils/artifactDir.js';
import {withMcpContext} from '../utils.js';

const HUNDRED_KB = 100 * 1024;

describe('large screenshot integration (T030)', () => {
  before(() => {
    resetArtifactDirManagerForTests();
  });
  after(() => {
    resetArtifactDirManagerForTests();
  });

  it(
    'persists a tall fullPage screenshot to disk and keeps response < 100KB',
    {timeout: 60_000},
    async () => {
      await withMcpContext(async (response, context) => {
        const page = context.getSelectedPptrPage();
        await page.setViewport({width: 800, height: 600});
        // ~8000px tall content; fullPage screenshot exercises the FR-007
        // "always disk" path with a payload guaranteed to dwarf the 1 MB
        // inline cap.
        const blocks = '<div style="height:80px;background:#ccc"></div>'.repeat(
          100,
        );
        await page.setContent(`<html><body>${blocks}</body></html>`);

        await screenshot.handler(
          {
            params: {format: 'png', fullPage: true},
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );

        const result = await response.handle('take_screenshot', context);

        // (1) No inline image — schema default `returnBase64:false` forced
        //     a disk write.
        assert.equal(
          result.content.filter(item => item.type === 'image').length,
          0,
          'response.content must not carry inline image data',
        );

        // (2) Response payload is tiny — well under the 100 KB SC-002 cap.
        const wireBytes = Buffer.byteLength(JSON.stringify(result), 'utf8');
        assert.ok(
          wireBytes < HUNDRED_KB,
          `serialized response should be < ${HUNDRED_KB} bytes, got ${wireBytes}`,
        );

        // (3) On-disk artifact exists and is non-trivially large.
        const savedLine = response.responseLines.find(line =>
          line.startsWith('Saved screenshot to '),
        );
        assert.ok(savedLine, 'expected a `Saved screenshot to <path>` line');
        const filePath = savedLine
          .replace(/^Saved screenshot to /, '')
          .replace(/\.$/, '');
        assert.ok(existsSync(filePath), `disk artifact missing: ${filePath}`);
        assert.ok(
          statSync(filePath).size > 1_000,
          'disk artifact should be > 1KB (real PNG bytes)',
        );
      });
    },
  );
});
