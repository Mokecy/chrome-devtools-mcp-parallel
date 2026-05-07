/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * InstanceBadge: injects a draggable 🤖 <instanceId> fixed badge into pages.
 * See specs/001-parallel-instances/tasks.md T054.
 *
 * - Injects via `evaluateOnNewDocument` on existing + new pages
 * - Skips about:, chrome:, devtools:, chrome-extension: URLs
 * - Failures are silently swallowed (never throws)
 */

import type {Page} from '../third_party/index.js';

import type {Instance} from './types.js';

/** URLs to skip badge injection */
const SKIP_URL_PREFIXES = [
  'about:',
  'chrome:',
  'devtools:',
  'chrome-extension:',
];

function shouldSkipUrl(url: string): boolean {
  for (const prefix of SKIP_URL_PREFIXES) {
    if (url.startsWith(prefix)) {
      return true;
    }
  }
  return false;
}

/**
 * Badge script template. Injected as evaluateOnNewDocument.
 * Uses IIFE to avoid polluting global scope.
 */
function buildBadgeScript(instanceId: string): string {
  return `
(function() {
  if (document.getElementById('__mcp_instance_badge')) return;
  var badge = document.createElement('div');
  badge.id = '__mcp_instance_badge';
  badge.textContent = '🤖 ${instanceId}';
  badge.style.cssText = 'position:fixed;bottom:8px;right:8px;z-index:2147483647;' +
    'background:rgba(0,0,0,0.8);color:#0f0;padding:4px 10px;border-radius:6px;' +
    'font:12px/1.4 monospace;cursor:grab;user-select:none;pointer-events:auto;';
  var dragging = false, offsetX = 0, offsetY = 0;
  badge.addEventListener('mousedown', function(e) {
    dragging = true;
    offsetX = e.clientX - badge.getBoundingClientRect().left;
    offsetY = e.clientY - badge.getBoundingClientRect().top;
    badge.style.cursor = 'grabbing';
    e.preventDefault();
  });
  document.addEventListener('mousemove', function(e) {
    if (!dragging) return;
    badge.style.left = (e.clientX - offsetX) + 'px';
    badge.style.top = (e.clientY - offsetY) + 'px';
    badge.style.right = 'auto';
    badge.style.bottom = 'auto';
  });
  document.addEventListener('mouseup', function() {
    dragging = false;
    badge.style.cursor = 'grab';
  });
  if (document.body) {
    document.body.appendChild(badge);
  } else {
    document.addEventListener('DOMContentLoaded', function() {
      document.body.appendChild(badge);
    });
  }
})();
`;
}

/**
 * Inject badge into a single page. Swallows errors.
 */
async function injectBadge(
  page: Page,
  instanceId: string,
  badgeInjected: WeakSet<Page>,
): Promise<void> {
  if (badgeInjected.has(page)) {
    return;
  }
  try {
    const url = page.url();
    if (shouldSkipUrl(url)) {
      return;
    }
    const script = buildBadgeScript(instanceId);
    await page.evaluateOnNewDocument(script);
    // Also inject immediately for already-loaded pages
    await page.evaluate(script).catch(() => {
      /* noop */
    });
    badgeInjected.add(page);
  } catch {
    // Silently swallow
  }
}

/**
 * Attach badge injection to an instance.
 * Handles existing pages + listens for new pages.
 */
export async function attachBadgeToInstance(instance: Instance): Promise<void> {
  const {id, context, badgeInjected} = instance;

  // Inject into existing pages
  try {
    const pages = await context.pages();
    for (const page of pages) {
      await injectBadge(page, id, badgeInjected);
    }
  } catch {
    // Context may be closed
  }

  // Listen for new pages
  try {
    context.on('targetcreated', async target => {
      try {
        const page = await target.page();
        if (page) {
          await injectBadge(page, id, badgeInjected);
        }
      } catch {
        // Swallow
      }
    });
  } catch {
    // Some contexts may not support this event
  }
}
