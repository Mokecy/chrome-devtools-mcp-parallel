/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * Tests for the bounded buffer behaviour added to PageCollector (T012).
 * See specs/001-stability-hardening/tasks.md WP-1.
 */

import assert from 'node:assert';
import {describe, it} from 'node:test';

import type {HTTPRequest} from 'puppeteer-core';

import {
  DEFAULT_CONSOLE_BUFFER_SIZE,
  DEFAULT_NETWORK_BUFFER_SIZE,
  NetworkCollector,
  PageCollector,
  type ListenerMap,
} from '../src/PageCollector.js';

import {getMockBrowser, getMockRequest} from './utils.js';

describe('PageCollector buffer caps (FR-001..003)', () => {
  it('caps active chunk at maxPerChunk and tracks evicted/totalPushed', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    const collector = new PageCollector<HTTPRequest>(
      browser,
      collect => {
        return {
          request: req => {
            collect(req);
          },
        } as ListenerMap;
      },
      {maxPerChunk: 500},
    );
    await collector.init([page]);

    for (let i = 0; i < 600; i++) {
      page.emit('request', getMockRequest());
    }

    const items = collector.getData(page);
    assert.strictEqual(items.length, 500, 'active chunk capped at 500');

    const meta = collector.getDataWithMeta(page);
    assert.strictEqual(meta.items.length, 500);
    assert.strictEqual(meta.chunks.length, 1);
    assert.strictEqual(meta.chunks[0].size, 500);
    assert.strictEqual(meta.chunks[0].totalPushed, 600);
    assert.strictEqual(meta.chunks[0].evicted, 100);
    assert.strictEqual(meta.total.size, 500);
    assert.strictEqual(meta.total.totalPushed, 600);
    assert.strictEqual(meta.total.evicted, 100);
  });

  it('keeps latest 500 of 600 in arrival order', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    let counter = 0;
    interface Tagged {
      seq: number;
    }
    const collector = new PageCollector<Tagged>(
      browser,
      collect => {
        return {
          request: () => {
            collect({seq: counter++});
          },
        } as ListenerMap;
      },
      {maxPerChunk: 500},
    );
    await collector.init([page]);
    for (let i = 0; i < 600; i++) {
      page.emit('request', getMockRequest());
    }
    const items = collector.getData(page);
    assert.strictEqual(items.length, 500);
    assert.strictEqual(items[0].seq, 100);
    assert.strictEqual(items[items.length - 1].seq, 599);
  });

  it('default ConsoleCollector cap is 500', () => {
    assert.strictEqual(DEFAULT_CONSOLE_BUFFER_SIZE, 500);
  });

  it('default NetworkCollector cap is 1000', () => {
    assert.strictEqual(DEFAULT_NETWORK_BUFFER_SIZE, 1000);
  });

  it('NetworkCollector navigation split preserves carried items + chunk meta', async () => {
    const browser = getMockBrowser();
    const page = (await browser.pages())[0];
    const mainFrame = page.mainFrame();
    const collector = new NetworkCollector(browser, collect => {
      return {
        request: req => {
          collect(req);
        },
      } as ListenerMap;
    });
    await collector.init([page]);

    // The nav-request lookup uses `request.frame() === page.mainFrame()`, so
    // requests must claim the same Frame object as the page reports.
    page.emit('request', getMockRequest({frame: mainFrame}));
    page.emit('request', getMockRequest({frame: mainFrame}));
    page.emit('request', getMockRequest({frame: mainFrame}));
    page.emit(
      'request',
      getMockRequest({frame: mainFrame, navigationRequest: true}),
    );
    page.emit('request', getMockRequest({frame: mainFrame}));
    page.emit('request', getMockRequest({frame: mainFrame}));

    page.emit('framenavigated', mainFrame);

    const meta = collector.getDataWithMeta(page);
    assert.strictEqual(meta.chunks.length, 2);
    assert.strictEqual(meta.chunks[0].size, 3, 'new chunk has nav + 2 subs');
    assert.strictEqual(meta.chunks[1].size, 3, 'old chunk keeps first 3');

    const active = collector.getData(page);
    assert.strictEqual(active.length, 3);

    const all = collector.getData(page, true);
    assert.strictEqual(all.length, 6);
  });
});
