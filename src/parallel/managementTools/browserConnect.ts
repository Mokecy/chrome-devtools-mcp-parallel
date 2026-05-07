/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * browser_connect management tool.
 * See specs/001-parallel-instances/contracts/management-tools.md §1.
 */

import type {CallToolResult} from '../../third_party/index.js';
import type {AuthStateHolder} from '../AuthState.js';
import {browserConnect as doConnect} from '../BrowserConnector.js';
import type {ConnectedBrowser} from '../types.js';

export interface BrowserConnectParams {
  cdpUrl?: string;
  pageIndex?: number;
  autoLaunch?: boolean;
}

export interface BrowserConnectDeps {
  authStateHolder: AuthStateHolder;
  setConnectedBrowser: (cb: ConnectedBrowser) => void;
  defaultAutoLaunch: boolean;
}

export async function browserConnectTool(
  params: BrowserConnectParams,
  deps: BrowserConnectDeps,
): Promise<CallToolResult> {
  const {cdpUrl, pageIndex, autoLaunch} = params;
  const shouldAutoLaunch = autoLaunch ?? deps.defaultAutoLaunch;

  try {
    const result = await doConnect({
      cdpUrl,
      pageIndex,
      autoLaunch: shouldAutoLaunch,
    });

    // Store connected browser reference
    deps.setConnectedBrowser(result.connectedBrowser);

    // Store auth state
    deps.authStateHolder.set(result.cookies, result.origins, 'browser_connect');

    // Build success message
    const lines: string[] = [
      `Connected to ${result.connectedBrowser.browserType} at ${result.connectedBrowser.cdpUrl}.`,
      `AuthState captured: ${result.cookies.length} cookies, ${result.origins.length} origins with localStorage.`,
    ];

    // Warn if no usable page for localStorage
    if (result.origins.length === 0) {
      lines.push(
        'Connected but no usable page to extract localStorage; cookies captured.',
      );
    }

    return {
      content: [{type: 'text', text: lines.join('\n')}],
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      content: [{type: 'text', text: reason}],
      isError: true,
    };
  }
}
