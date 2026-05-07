/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * instance_export_auth management tool.
 * See specs/001-parallel-instances/contracts/management-tools.md §6.
 */

import type {CallToolResult} from '../../third_party/index.js';
import type {AuthStateHolder} from '../AuthState.js';
import {extractCookies, extractLocalStorage} from '../BrowserConnector.js';
import type {InstanceRegistry} from '../InstanceRegistry.js';
import type {ConnectedBrowser} from '../types.js';

export interface InstanceExportAuthParams {
  instanceId?: string;
}

export interface InstanceExportAuthDeps {
  registry: InstanceRegistry;
  authStateHolder: AuthStateHolder;
  connectedBrowser: ConnectedBrowser | null;
}

export async function instanceExportAuth(
  params: InstanceExportAuthParams,
  deps: InstanceExportAuthDeps,
): Promise<CallToolResult> {
  const {instanceId} = params;
  const {registry, authStateHolder, connectedBrowser} = deps;

  if (instanceId) {
    // Export from a specific instance
    const instance = registry.get(instanceId);
    if (!instance) {
      return {
        content: [{type: 'text', text: `Instance ${instanceId} not found.`}],
        isError: true,
      };
    }

    try {
      const pages = await instance.context.pages();
      const page = pages[0];
      if (!page) {
        return {
          content: [
            {
              type: 'text',
              text: `Instance ${instanceId} context is closed; cannot export.`,
            },
          ],
          isError: true,
        };
      }

      // Extract cookies from the context
      const cookies = await instance.context.cookies();
      const authCookies = cookies.map(c => ({
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        expires: c.expires ?? -1,
        httpOnly: c.httpOnly ?? false,
        secure: c.secure,
        sameSite: normalizeSameSite(c.sameSite),
      }));

      // Extract localStorage from current page
      const origins = await extractLocalStorage(page);

      authStateHolder.set(authCookies, origins, 'instance_export_auth');

      return {
        content: [
          {
            type: 'text',
            text: `AuthState updated from instance ${instanceId}: ${authCookies.length} cookies, ${origins.length} origins with localStorage.`,
          },
        ],
      };
    } catch {
      return {
        content: [
          {
            type: 'text',
            text: `Instance ${instanceId} context is closed; cannot export.`,
          },
        ],
        isError: true,
      };
    }
  }

  // Export from connected browser
  if (!connectedBrowser || !connectedBrowser.available) {
    return {
      content: [
        {
          type: 'text',
          text: 'No source to export from. Call browser_connect first or supply instanceId.',
        },
      ],
      isError: true,
    };
  }

  const cookies = await extractCookies(connectedBrowser.browser);
  const pages = await connectedBrowser.browser.pages();
  const nonBlankPages = pages.filter(
    p => p.url() !== 'about:blank' && !p.url().startsWith('chrome://'),
  );
  const origins = await extractLocalStorage(nonBlankPages[0] ?? pages[0]);

  authStateHolder.set(cookies, origins, 'instance_export_auth');

  return {
    content: [
      {
        type: 'text',
        text: `AuthState updated from connected browser: ${cookies.length} cookies, ${origins.length} origins with localStorage.`,
      },
    ],
  };
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
