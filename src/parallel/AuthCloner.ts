/**
 * @license
 * Copyright 26 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * AuthCloner: inject captured AuthState (cookies + localStorage) into a
 * new BrowserContext so the instance starts in a logged-in state.
 * See specs/001-parallel-instances/data-model.md §3.
 */

import {logger} from '../logger.js';
import type {BrowserContext} from '../third_party/index.js';

import type {AuthState} from './types.js';

/**
 * Apply AuthState to a BrowserContext before any navigation occurs.
 *
 * Strategy:
 * 1. Cookies: `context.setCookie(...)` for each cookie
 * 2. localStorage: inject via `page.evaluateOnNewDocument` with an IIFE that
 *    checks `location.origin` and populates matching items.
 *
 * Returns the number of cookies set and origins configured.
 */
export async function applyAuthToContext(
  context: BrowserContext,
  authState: AuthState,
): Promise<{cookieCount: number; originCount: number}> {
  // 1. Set cookies on the context
  const cookiesForPuppeteer = authState.cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires === -1 ? undefined : c.expires,
    httpOnly: c.httpOnly,
    secure: c.secure,
    sameSite: mapSameSite(c.sameSite),
  }));

  try {
    await context.setCookie(...cookiesForPuppeteer);
  } catch (err) {
    logger('AuthCloner: setCookie failed:', err);
  }

  // 2. Inject localStorage via evaluateOnNewDocument on existing pages
  //    and new pages that will be created in this context
  const originsJson = JSON.stringify(
    authState.origins.map(o => ({origin: o.origin, items: o.items})),
  );

  // The script to inject into every page load
  const localStorageScript = `
    (function() {
      try {
        var origins = ${originsJson};
        var currentOrigin = location.origin;
        for (var i = 0; i < origins.length; i++) {
          if (origins[i].origin === currentOrigin) {
            var items = origins[i].items;
            for (var j = 0; j < items.length; j++) {
              localStorage.setItem(items[j][0], items[j][1]);
            }
            break;
          }
        }
      } catch(e) {}
    })();
  `;

  // Apply to all existing pages in context
  const pages = await context.pages();
  for (const page of pages) {
    try {
      await page.evaluateOnNewDocument(localStorageScript);
    } catch {
      // Page might be closed, ignore
    }
  }

  // Also register for future pages via context event
  // This is best-effort; if context doesn't support 'targetcreated', skip
  try {
    context.on('targetcreated', async target => {
      try {
        const page = await target.page();
        if (page) {
          await page.evaluateOnNewDocument(localStorageScript);
        }
      } catch {
        // Ignore failures on new pages
      }
    });
  } catch {
    // Some contexts may not support this event
  }

  return {
    cookieCount: authState.cookies.length,
    originCount: authState.origins.length,
  };
}

function mapSameSite(
  sameSite: 'Strict' | 'Lax' | 'None' | undefined,
): 'Strict' | 'Lax' | 'None' | undefined {
  return sameSite;
}
