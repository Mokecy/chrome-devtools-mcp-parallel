/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * BrowserLike adapter: wraps a BrowserContext to present the minimal Browser
 * interface that upstream McpContext requires.
 *
 * Purpose: allow `McpContext.from(browserLike, ...)` to operate on a single
 * context's pages without seeing other contexts' pages.
 * See specs/001-parallel-instances/plan.md "Phase 0 — Research" point 1.
 *
 * NOTE: This adapter intentionally does NOT support all Browser methods.
 * Only methods actually invoked by McpContext are implemented. Methods that
 * are context-irrelevant (extensions, version, etc.) delegate to parent.
 */

import type {Browser, BrowserContext} from '../third_party/index.js';

/**
 * Creates a Browser-like object scoped to a single BrowserContext.
 * The returned object satisfies the structural subset of `Browser` that
 * McpContext actually calls.
 *
 * We use Object.create + property descriptors to produce an object that
 * TS recognizes as Browser without requiring `as` on every method.
 * The parent Browser is still used for operations that are inherently
 * browser-wide (version, createBrowserContext for isolated contexts, etc.).
 */
export function createBrowserLike(
  context: BrowserContext,
  parentBrowser: Browser,
): Browser {
  // We create a proxy that intercepts the key methods McpContext uses.
  // For everything else, we forward to parentBrowser.
  const handler: ProxyHandler<Browser> = {
    get(target, prop, receiver) {
      switch (prop) {
        case 'newPage':
          return async () => context.newPage();

        case 'pages':
          return async () => context.pages();

        case 'targets':
          return () => {
            // targets() is synchronous in puppeteer; filter to this context
            const allTargets = parentBrowser.targets();
            return allTargets.filter(t => t.browserContext() === context);
          };

        case 'defaultBrowserContext':
          return () => context;

        case 'browserContexts':
          return () => [context];

        case 'createBrowserContext':
          return async () => parentBrowser.createBrowserContext();

        case 'on':
          return (event: string, handler: (...args: unknown[]) => void) => {
            context.on(event, handler);
            return receiver;
          };

        case 'off':
          return (event: string, handler: (...args: unknown[]) => void) => {
            context.off(event, handler);
            return receiver;
          };

        case 'version':
          return async () => parentBrowser.version();

        case 'close':
          return async () => context.close();

        case 'connected':
          return parentBrowser.connected;

        default:
          // Forward all other properties to the real browser
          return Reflect.get(parentBrowser, prop, parentBrowser);
      }
    },
  };

  return new Proxy(parentBrowser, handler);
}
