/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * BrowserConnector: discover, auto-launch, and connect to a Chrome/Edge
 * instance with remote debugging enabled.
 * See specs/001-parallel-instances/contracts/management-tools.md §1.
 */

import type {Browser, Page} from '../third_party/index.js';
import {puppeteer} from '../third_party/index.js';

import type {
  ConnectedBrowser,
  ConnectedBrowserType,
  AuthCookie,
  AuthOriginStorage,
} from './types.js';

const DEFAULT_PORTS = [9222, 9223, 9224];

/**
 * Try to discover a running debug browser at common ports.
 */
async function discoverPort(ports: number[]): Promise<string | null> {
  for (const port of ports) {
    const url = `http://127.0.0.1:${port}`;
    try {
      const response = await fetch(`${url}/json/version`, {
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        return url;
      }
    } catch {
      // Port not listening, continue
    }
  }
  return null;
}

/**
 * Connect to a browser at the given CDP URL.
 */
export async function connectToBrowser(cdpUrl: string): Promise<Browser> {
  const browser = await puppeteer.connect({
    browserURL: cdpUrl,
    // Preserve the browser's natural viewport instead of forcing 800x600
    // whenever a page is activated.
    defaultViewport: null,
  });
  return browser;
}

/**
 * Detect browser type from version string.
 */
function detectBrowserType(versionStr: string): ConnectedBrowserType {
  const lower = versionStr.toLowerCase();
  if (lower.includes('edg')) {
    return 'edge';
  }
  if (lower.includes('chromium')) {
    return 'chromium';
  }
  return 'chrome';
}

/**
 * Extract cookies from the browser's default context.
 */
export async function extractCookies(browser: Browser): Promise<AuthCookie[]> {
  const cookies = await browser.cookies();
  return cookies.map(c => ({
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path,
    expires: c.expires ?? -1,
    httpOnly: c.httpOnly ?? false,
    secure: c.secure,
    sameSite: normalizeSameSite(c.sameSite),
  }));
}

function normalizeSameSite(
  s: string | undefined,
): 'Strict' | 'Lax' | 'None' | undefined {
  if (!s) {
    return undefined;
  }
  const lower = s.toLowerCase();
  if (lower === 'strict') {
    return 'Strict';
  }
  if (lower === 'lax') {
    return 'Lax';
  }
  if (lower === 'none') {
    return 'None';
  }
  return undefined;
}

/**
 * Extract localStorage entries from a page, grouped by origin.
 */
export async function extractLocalStorage(
  page: Page,
): Promise<AuthOriginStorage[]> {
  try {
    const origin = new URL(page.url()).origin;
    if (origin === 'null' || origin.startsWith('chrome')) {
      return [];
    }

    const items = await page.evaluate(() => {
      const result: Array<[string, string]> = [];
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key !== null) {
          const value = localStorage.getItem(key);
          if (value !== null) {
            result.push([key, value]);
          }
        }
      }
      return result;
    });

    if (items.length === 0) {
      return [];
    }

    return [{origin, items}];
  } catch {
    return [];
  }
}

export interface BrowserConnectResult {
  connectedBrowser: ConnectedBrowser;
  cookies: AuthCookie[];
  origins: AuthOriginStorage[];
}

/**
 * Full connect flow:
 * 1. Resolve CDP URL (explicit or discover)
 * 2. Connect via puppeteer
 * 3. Extract auth state
 */
export async function browserConnect(options: {
  cdpUrl?: string;
  pageIndex?: number;
  autoLaunch?: boolean;
}): Promise<BrowserConnectResult> {
  const {cdpUrl, pageIndex = 0} = options;

  // Resolve endpoint
  let endpoint: string;
  if (cdpUrl) {
    endpoint = cdpUrl;
  } else {
    const discovered = await discoverPort(DEFAULT_PORTS);
    if (!discovered) {
      throw new Error(
        'No debug port detected. Start Chrome manually: chrome.exe --remote-debugging-port=9222 --user-data-dir=<path>',
      );
    }
    endpoint = discovered;
  }

  // Connect
  let browser: Browser;
  try {
    browser = await connectToBrowser(endpoint);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to connect to ${endpoint}: ${reason}`);
  }

  // Detect type
  let versionStr = '';
  try {
    versionStr = await browser.version();
  } catch {
    // Fallback
  }
  const browserType = detectBrowserType(versionStr);

  // Extract auth
  const cookies = await extractCookies(browser);

  let origins: AuthOriginStorage[] = [];
  const pages = await browser.pages();
  // Find the target page for localStorage extraction
  const nonBlankPages = pages.filter(
    p => p.url() !== 'about:blank' && !p.url().startsWith('chrome://'),
  );
  const targetPage = nonBlankPages[pageIndex] ?? nonBlankPages[0];
  if (targetPage) {
    origins = await extractLocalStorage(targetPage);
  }

  const connectedBrowser: ConnectedBrowser = {
    browser,
    cdpUrl: endpoint,
    browserType,
    autoLaunchedByUs: false,
    available: true,
  };

  return {connectedBrowser, cookies, origins};
}
