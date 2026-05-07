/**
 * @license
 * Copyright 2026 netease
 * SPDX-License-Identifier: Apache-2.0
 *
 * instance_create management tool.
 * See specs/001-parallel-instances/contracts/management-tools.md §2.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {launch} from '../../browser.js';
import {logger} from '../../logger.js';
import {McpContext} from '../../McpContext.js';
import type {CallToolResult} from '../../third_party/index.js';
import {applyAuthToContext} from '../AuthCloner.js';
import type {AuthStateHolder} from '../AuthState.js';
import {createBrowserLike} from '../BrowserLike.js';
import {attachBadgeToInstance} from '../InstanceBadge.js';
import type {InstanceRegistry} from '../InstanceRegistry.js';
import {PerInstance} from '../PerInstance.js';
import type {ParallelServerArgs, ConnectedBrowser} from '../types.js';

export interface InstanceCreateParams {
  instanceId: string;
  url?: string;
  cloneAuth?: boolean;
  useCDP?: boolean;
}

export interface InstanceCreateDeps {
  registry: InstanceRegistry;
  serverArgs: ParallelServerArgs;
  connectedBrowser: ConnectedBrowser | null;
  authStateHolder?: AuthStateHolder;
}

export async function instanceCreate(
  params: InstanceCreateParams,
  deps: InstanceCreateDeps,
): Promise<CallToolResult> {
  const {instanceId, url, cloneAuth = true, useCDP} = params;
  const {registry, serverArgs, connectedBrowser} = deps;

  // Validate instanceId
  if (!instanceId || instanceId.trim().length === 0) {
    return {
      content: [{type: 'text', text: 'instanceId must be a non-empty string.'}],
      isError: true,
    };
  }

  // Check duplicate
  if (registry.get(instanceId)) {
    return {
      content: [
        {
          type: 'text',
          text: `Instance ${instanceId} already exists; pick a different id or close the existing one.`,
        },
      ],
      isError: true,
    };
  }

  // Check limit
  if (registry.size() >= registry.maxInstances) {
    return {
      content: [
        {
          type: 'text',
          text: `Instance limit (${registry.maxInstances}) reached. Close an existing instance first or increase --max-instances.`,
        },
      ],
      isError: true,
    };
  }

  // Determine mode
  const wantCDP = useCDP ?? connectedBrowser?.available === true;
  const canUseCDP = connectedBrowser?.available === true;
  const mode = wantCDP && canUseCDP ? 'cdp' : 'launch';
  const fellBackToLaunch = wantCDP && !canUseCDP;

  const lines: string[] = [];

  try {
    // Create download dir
    const downloadPath = path.join(
      os.tmpdir(),
      'chrome-devtools-mcp-parallel-downloads',
      instanceId,
    );
    await fs.mkdir(downloadPath, {recursive: true});

    let instance: PerInstance;

    if (mode === 'cdp' && connectedBrowser) {
      // CDP mode: create new BrowserContext in the connected browser
      const context = await connectedBrowser.browser.createBrowserContext();
      const contextId = context.id ?? '';
      // Ensure context has at least one page so McpContext can select it.
      const existingPages = await context.pages();
      if (existingPages.length === 0) {
        await context.newPage();
      }
      const browserLike = createBrowserLike(context, connectedBrowser.browser);
      const mcpContext = await McpContext.from(browserLike, logger, {
        experimentalDevToolsDebugging: serverArgs.experimentalDevtools ?? false,
        experimentalIncludeAllPages: serverArgs.experimentalIncludeAllPages,
        performanceCrux: serverArgs.performanceCrux,
      });
      // Trigger initial page refresh so selectedPage is populated.
      await mcpContext.createPagesSnapshot();

      instance = new PerInstance({
        id: instanceId,
        mode: 'cdp',
        browser: connectedBrowser.browser,
        context,
        contextId,
        downloadPath,
        mcpContext,
      });
    } else {
      // Launch mode: start a new browser process using upstream launch().
      const chromeArgs: string[] = (serverArgs.chromeArg ?? []).map(String);
      if (serverArgs.proxyServer) {
        chromeArgs.push(`--proxy-server=${serverArgs.proxyServer}`);
      }
      // yargs coerces viewport from "WxH" string to {width, height} at runtime,
      // but the static type is still string. Parse it defensively.
      const rawViewport: unknown = serverArgs.viewport;
      let viewport: {width: number; height: number} | undefined;
      if (
        rawViewport &&
        typeof rawViewport === 'object' &&
        'width' in rawViewport &&
        'height' in rawViewport
      ) {
        const v = rawViewport as {width: number; height: number};
        viewport = {width: v.width, height: v.height};
      } else if (typeof rawViewport === 'string') {
        const m = /^(\d+)x(\d+)$/.exec(rawViewport);
        if (m) viewport = {width: Number(m[1]), height: Number(m[2])};
      }
      const browser = await launch({
        headless: serverArgs.headless ?? false,
        // Each instance uses an isolated user-data-dir to avoid profile lock
        // clashes when multiple instances run in parallel.
        isolated: serverArgs.isolated ?? true,
        channel: serverArgs.channel ?? 'stable',
        executablePath: serverArgs.executablePath,
        userDataDir: serverArgs.userDataDir,
        acceptInsecureCerts: serverArgs.acceptInsecureCerts,
        chromeArgs,
        ignoreDefaultChromeArgs: serverArgs.ignoreDefaultChromeArg?.map(String),
        devtools: false,
        viewport,
        enableExtensions: serverArgs.categoryExtensions,
      });

      const context = browser.defaultBrowserContext();
      const browserLike = createBrowserLike(context, browser);
      const mcpContext = await McpContext.from(browserLike, logger, {
        experimentalDevToolsDebugging: serverArgs.experimentalDevtools ?? false,
        experimentalIncludeAllPages: serverArgs.experimentalIncludeAllPages,
        performanceCrux: serverArgs.performanceCrux,
      });
      // Trigger initial page refresh so selectedPage is populated.
      await mcpContext.createPagesSnapshot();

      instance = new PerInstance({
        id: instanceId,
        mode: 'launch',
        browser,
        context,
        contextId: '',
        downloadPath,
        mcpContext,
      });
    }

    registry.add(instance);
    lines.push(`Instance ${instanceId} created in ${mode} mode.`);

    if (fellBackToLaunch) {
      lines.push(
        'useCDP requested but no connected browser, fell back to launch',
      );
    }

    // Navigate if url provided
    if (url) {
      try {
        const pages = await instance.context.pages();
        const page = pages[0] ?? (await instance.context.newPage());
        await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 10000});
        lines.push(`Navigated to ${url}.`);
      } catch (navErr) {
        const reason =
          navErr instanceof Error ? navErr.message : String(navErr);
        lines.push(`Navigation to ${url} failed: ${reason}`);
      }
    }

    // Badge injection (T055)
    await attachBadgeToInstance(instance);

    // Auth cloning (T034): inject cookies + localStorage into new context
    if (cloneAuth && deps.authStateHolder) {
      const authState = deps.authStateHolder.get();
      if (authState) {
        try {
          const {cookieCount, originCount} = await applyAuthToContext(
            instance.context,
            authState,
          );
          lines.push(
            `Auth cloned: ${cookieCount} cookies, ${originCount} origins.`,
          );
        } catch (authErr) {
          const reason =
            authErr instanceof Error ? authErr.message : String(authErr);
          lines.push(`Auth clone partial failure: ${reason}`);
        }
      }
    }

    return {
      content: [{type: 'text', text: lines.join('\n')}],
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      content: [
        {
          type: 'text',
          text: `Failed to create instance ${instanceId}: ${reason}`,
        },
      ],
      isError: true,
    };
  }
}
