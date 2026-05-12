/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for FR-004 / FR-005:
 *   - `PageCollector` stamps wall-clock so `since` filtering works.
 *   - `NetworkCollector` / `ConsoleCollector` flag oversize records via the
 *     `oversizeSymbol` marker without mutating the underlying object.
 *
 * See specs/001-stability-hardening/tasks.md T013 / T017 / T022 / T023.
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import {NetworkCollector} from '../src/PageCollector.js';

import {getMockBrowser, getMockRequest} from './utils.js';

describe('PageCollector record-cap + collectedAt (FR-004 / FR-005)', () => {
  it('stamps collectedAt on every pushed item', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    const collector = new NetworkCollector(browser, undefined, {
      maxPerChunk: 50,
    });
    await collector.init([page]);

    const before = Date.now();
    page.emit('request', getMockRequest());
    const after = Date.now();

    const items = collector.getData(page);
    assert.strictEqual(items.length, 1);
    const ts = collector.getCollectedAt(items[0]);
    assert.ok(typeof ts === 'number', 'collectedAt must be a number');
    assert.ok(
      ts >= before && ts <= after,
      `collectedAt ${ts} must be within [${before}, ${after}]`,
    );
  });

  it('marks oversize records via oversizeSymbol when over recordSizeCapBytes', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    // Cap = 64 bytes; a request whose URL exceeds 64 chars should be flagged.
    const collector = new NetworkCollector(browser, undefined, {
      maxPerChunk: 50,
      recordSizeCapBytes: 64,
    });
    await collector.init([page]);

    const small = getMockRequest({url: 'http://x/'});
    const huge = getMockRequest({
      url: 'http://example.com/' + 'a'.repeat(200),
    });
    page.emit('request', small);
    page.emit('request', huge);

    const items = collector.getData(page);
    assert.strictEqual(items.length, 2);
    assert.strictEqual(
      collector.isOversize(items[0]),
      false,
      'small request must not be flagged',
    );
    assert.strictEqual(
      collector.isOversize(items[1]),
      true,
      'large request must be flagged oversize',
    );
  });

  it('does not flag any record when recordSizeCapBytes is omitted (back-compat)', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    const collector = new NetworkCollector(browser, undefined, {
      maxPerChunk: 10,
    });
    await collector.init([page]);

    page.emit('request', getMockRequest({url: 'http://x/' + 'a'.repeat(5000)}));

    const items = collector.getData(page);
    assert.strictEqual(items.length, 1);
    assert.strictEqual(collector.isOversize(items[0]), false);
  });
});
