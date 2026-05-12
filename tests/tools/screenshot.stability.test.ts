/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * T025 / T026: behaviour added by stability hardening (FR-006 / FR-007).
 *  - default (no filePath, no returnBase64) → screenshot is written to disk,
 *    response carries the path and no inline image.
 *  - returnBase64:true under inline cap → inline image as before.
 *  - returnBase64:true over inline cap → INLINE_PAYLOAD_TOO_LARGE.
 */

import assert from 'node:assert';
import {access, rm} from 'node:fs/promises';
import {after, before, describe, it} from 'node:test';

import {screenshot} from '../../src/tools/screenshot.js';
import {
  StructuredError,
  StructuredErrorCode,
} from '../../src/utils/structuredError.js';
import {screenshots} from '../snapshot.js';
import {withMcpContext} from '../utils.js';

describe('screenshot stability behaviour (T025 / T026)', () => {
  // Track the original env so we can restore deterministic state for other
  // suites in the same run.
  let prevCap: string | undefined;
  before(() => {
    prevCap = process.env['CDM_INLINE_PAYLOAD_MAX_MB'];
  });
  after(() => {
    if (prevCap === undefined) {
      delete process.env['CDM_INLINE_PAYLOAD_MAX_MB'];
    } else {
      process.env['CDM_INLINE_PAYLOAD_MAX_MB'] = prevCap;
    }
  });

  it('persists to disk by default (no filePath, no returnBase64) — T025', async () => {
    await withMcpContext(async (response, context) => {
      const fixture = screenshots.basic;
      const page = context.getSelectedPptrPage();
      await page.setContent(fixture.html);
      await screenshot.handler(
        {params: {format: 'png'}, page: context.getSelectedMcpPage()},
        response,
        context,
      );

      assert.equal(
        response.images.length,
        0,
        'default should NOT inline base64',
      );
      assert.equal(
        response.responseLines.at(0),
        "Took a screenshot of the current page's viewport.",
      );
      const savedLine = response.responseLines.at(1);
      assert.ok(
        savedLine && /^Saved screenshot to .+\.png\.?$/.test(savedLine),
        `expected "Saved screenshot to <path>.png" line, got: ${savedLine}`,
      );

      // Path is "Saved screenshot to <path>." — strip prefix + trailing dot.
      const filepath = savedLine
        .replace(/^Saved screenshot to /, '')
        .replace(/\.$/, '');
      await access(filepath);
      await rm(filepath, {force: true});
    });
  });

  it('inlines base64 when returnBase64:true and payload <= cap — T026 (under cap)', async () => {
    // 4 MB is plenty of headroom for the small `basic` fixture.
    process.env['CDM_INLINE_PAYLOAD_MAX_MB'] = '4';
    await withMcpContext(async (response, context) => {
      const fixture = screenshots.basic;
      const page = context.getSelectedPptrPage();
      await page.setContent(fixture.html);
      await screenshot.handler(
        {
          params: {format: 'png', returnBase64: true},
          page: context.getSelectedMcpPage(),
        },
        response,
        context,
      );

      assert.equal(response.images.length, 1);
      assert.equal(response.images[0].mimeType, 'image/png');
    });
  });

  it('rejects with INLINE_PAYLOAD_TOO_LARGE when over cap — T026 (over cap)', async () => {
    // 1 byte cap forces the cap check to fail for any real screenshot.
    process.env['CDM_INLINE_PAYLOAD_MAX_MB'] = String(1 / (1024 * 1024));
    await withMcpContext(async (response, context) => {
      const fixture = screenshots.basic;
      const page = context.getSelectedPptrPage();
      await page.setContent(fixture.html);

      let caught: unknown;
      try {
        await screenshot.handler(
          {
            params: {format: 'png', returnBase64: true},
            page: context.getSelectedMcpPage(),
          },
          response,
          context,
        );
      } catch (err) {
        caught = err;
      }
      assert.ok(
        caught instanceof StructuredError,
        `expected StructuredError, got: ${String(caught)}`,
      );
      assert.equal(
        (caught as StructuredError).code,
        StructuredErrorCode.INLINE_PAYLOAD_TOO_LARGE,
      );
      assert.equal((caught as StructuredError).recoverable, true);
      assert.match(
        (caught as StructuredError).nextAction,
        /returnBase64|filePath|CDM_INLINE_PAYLOAD_MAX_MB/,
      );
    });
  });
});
