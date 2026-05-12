/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FakeIssuesManager} from './DevtoolsUtils.js';
import {logger} from './logger.js';
import type {
  Target,
  CDPSession,
  ConsoleMessage,
  Protocol,
  Issue,
} from './third_party/index.js';
import {DevTools} from './third_party/index.js';
import {
  type Browser,
  type Frame,
  type Handler,
  type HTTPRequest,
  type Page,
  type PageEvents as PuppeteerPageEvents,
} from './third_party/index.js';
import {ChunkBuffer, type ChunkMeta} from './utils/chunkBuffer.js';
import {
  collectedAtSymbol,
  createIdGenerator,
  oversizeSymbol,
  stableIdSymbol,
  type WithSymbolId,
} from './utils/id.js';

export interface CollectorDataWithMeta<T> {
  /** Items in oldest-to-newest order from the active (most recent) chunk. */
  items: T[];
  /** Per-chunk metadata, newest chunk first. */
  chunks: ChunkMeta[];
  /** Sum across all chunks. */
  total: ChunkMeta;
}

export class UncaughtError {
  readonly details: Protocol.Runtime.ExceptionDetails;
  readonly targetId: string;

  constructor(details: Protocol.Runtime.ExceptionDetails, targetId: string) {
    this.details = details;
    this.targetId = targetId;
  }
}

interface PageEvents extends PuppeteerPageEvents {
  devtoolsAggregatedIssue: DevTools.AggregatedIssue;
  uncaughtError: UncaughtError;
}

export type ListenerMap<EventMap extends PageEvents = PageEvents> = {
  [K in keyof EventMap]?: (event: EventMap[K]) => void;
};

/** Default cap when caller does not specify one. Large enough to keep tests
 *  that do not care about buffering green; concrete subclasses (Console /
 *  Network) override this with the spec-mandated defaults (FR-002). */
const DEFAULT_MAX_PER_CHUNK = 10_000;

export class PageCollector<T> {
  #browser: Browser;
  #listenersInitializer: (
    collector: (item: T) => void,
  ) => ListenerMap<PageEvents>;
  #listeners = new WeakMap<Page, ListenerMap>();
  protected maxNavigationSaved = 3;
  protected readonly maxPerChunk: number;
  /** FR-005: per-record byte budget; `0` disables the check. */
  protected readonly recordSizeCapBytes: number;
  /** Best-effort byte estimator for incoming records; subclasses override. */
  protected estimateRecordBytes(_item: T): number {
    return 0;
  }

  /**
   * Maps a Page to its navigation history, newest navigation first. Each
   * navigation is a {@link ChunkBuffer} bounded by {@link maxPerChunk}; older
   * records are evicted FIFO once the cap is hit (FR-001..002).
   */
  protected storage = new WeakMap<Page, Array<ChunkBuffer<WithSymbolId<T>>>>();

  constructor(
    browser: Browser,
    listeners: (collector: (item: T) => void) => ListenerMap<PageEvents>,
    options: {maxPerChunk?: number; recordSizeCapBytes?: number} = {},
  ) {
    this.#browser = browser;
    this.#listenersInitializer = listeners;
    this.maxPerChunk = options.maxPerChunk ?? DEFAULT_MAX_PER_CHUNK;
    this.recordSizeCapBytes = options.recordSizeCapBytes ?? 0;
  }

  async init(pages: Page[]) {
    for (const page of pages) {
      this.addPage(page);
    }

    this.#browser.on('targetcreated', this.#onTargetCreated);
    this.#browser.on('targetdestroyed', this.#onTargetDestroyed);
  }

  dispose() {
    this.#browser.off('targetcreated', this.#onTargetCreated);
    this.#browser.off('targetdestroyed', this.#onTargetDestroyed);
  }

  #onTargetCreated = async (target: Target) => {
    try {
      const page = await target.page();
      if (!page) {
        return;
      }
      this.addPage(page);
    } catch (err) {
      logger('Error getting a page for a target onTargetCreated', err);
    }
  };

  #onTargetDestroyed = async (target: Target) => {
    try {
      const page = await target.page();
      if (!page) {
        return;
      }
      this.cleanupPageDestroyed(page);
    } catch (err) {
      logger('Error getting a page for a target onTargetDestroyed', err);
    }
  };

  public addPage(page: Page) {
    this.#initializePage(page);
  }

  #initializePage(page: Page) {
    if (this.storage.has(page)) {
      return;
    }
    const idGenerator = createIdGenerator();
    const storedLists: Array<ChunkBuffer<WithSymbolId<T>>> = [
      new ChunkBuffer<WithSymbolId<T>>(this.maxPerChunk),
    ];
    this.storage.set(page, storedLists);

    const listeners = this.#listenersInitializer(value => {
      const withId = value as WithSymbolId<T>;
      withId[stableIdSymbol] = idGenerator();
      // FR-004: stamp wall-clock so `since` filtering can run at query time.
      if (withId[collectedAtSymbol] === undefined) {
        try {
          withId[collectedAtSymbol] = Date.now();
        } catch {
          // value is a primitive (e.g. test fixture using numbers) — ignore.
        }
      }
      // FR-005: estimate record size and stamp oversize marker without
      // mutating the underlying Puppeteer object.
      if (this.recordSizeCapBytes > 0) {
        try {
          const bytes = this.estimateRecordBytes(value);
          if (bytes > this.recordSizeCapBytes) {
            withId[oversizeSymbol] = true;
          }
        } catch {
          // estimator must not throw; ignore measurement failure.
        }
      }

      const navigations = this.storage.get(page);
      if (!navigations || navigations.length === 0) {
        return;
      }
      navigations[0].push(withId);
    });

    listeners['framenavigated'] = (frame: Frame) => {
      // Only split the storage on main frame navigation
      if (frame !== page.mainFrame()) {
        return;
      }
      this.splitAfterNavigation(page);
    };

    for (const [name, listener] of Object.entries(listeners)) {
      page.on(name, listener as Handler<unknown>);
    }

    this.#listeners.set(page, listeners);
  }

  protected splitAfterNavigation(page: Page) {
    const navigations = this.storage.get(page);
    if (!navigations) {
      return;
    }
    // Add the latest navigation first
    navigations.unshift(new ChunkBuffer<WithSymbolId<T>>(this.maxPerChunk));
    navigations.splice(this.maxNavigationSaved);
  }

  protected cleanupPageDestroyed(page: Page) {
    const listeners = this.#listeners.get(page);
    if (listeners) {
      for (const [name, listener] of Object.entries(listeners)) {
        page.off(name, listener as Handler<unknown>);
      }
    }
    this.storage.delete(page);
  }

  getData(page: Page, includePreservedData?: boolean): T[] {
    const navigations = this.storage.get(page);
    if (!navigations) {
      return [];
    }

    if (!includePreservedData) {
      return navigations[0].toArray();
    }

    const data: T[] = [];
    for (let index = this.maxNavigationSaved; index >= 0; index--) {
      const chunk = navigations[index];
      if (chunk) {
        data.push(...chunk.toArray());
      }
    }
    return data;
  }

  /**
   * Same as {@link getData} but returns per-chunk and aggregated metadata so
   * the caller can surface eviction / total-seen counters in the tool
   * response (FR-003).
   */
  getDataWithMeta(
    page: Page,
    includePreservedData?: boolean,
  ): CollectorDataWithMeta<T> {
    const navigations = this.storage.get(page);
    if (!navigations || navigations.length === 0) {
      return {
        items: [],
        chunks: [],
        total: {size: 0, totalPushed: 0, evicted: 0},
      };
    }

    const chunks: ChunkMeta[] = [];
    for (const chunk of navigations) {
      chunks.push(chunk.meta());
    }

    const total: ChunkMeta = {size: 0, totalPushed: 0, evicted: 0};
    for (const meta of chunks) {
      total.size += meta.size;
      total.totalPushed += meta.totalPushed;
      total.evicted += meta.evicted;
    }

    const items = includePreservedData
      ? this.getData(page, true)
      : navigations[0].toArray();

    return {items, chunks, total};
  }

  getIdForResource(resource: WithSymbolId<T>): number {
    return resource[stableIdSymbol] ?? -1;
  }

  /**
   * Returns the wall-clock epoch ms at which `resource` was inserted into the
   * collector, or `undefined` when the value cannot carry a symbol property
   * (e.g. primitive test fixtures). FR-004.
   */
  getCollectedAt(resource: WithSymbolId<T>): number | undefined {
    return resource[collectedAtSymbol];
  }

  /** FR-005: returns true if the record exceeded the configured cap at push time. */
  isOversize(resource: WithSymbolId<T>): boolean {
    return resource[oversizeSymbol] === true;
  }

  getById(page: Page, stableId: number): T {
    const navigations = this.storage.get(page);
    if (!navigations) {
      throw new Error('No requests found for selected page');
    }

    const item = this.find(page, item => item[stableIdSymbol] === stableId);

    if (item) {
      return item;
    }

    throw new Error('Request not found for selected page');
  }

  find(
    page: Page,
    filter: (item: WithSymbolId<T>) => boolean,
  ): WithSymbolId<T> | undefined {
    const navigations = this.storage.get(page);
    if (!navigations) {
      return;
    }

    for (const navigation of navigations) {
      const item = navigation.toArray().find(filter);
      if (item) {
        return item;
      }
    }
    return;
  }
}

/** FR-002: console buffer default 500 records per navigation chunk. */
export const DEFAULT_CONSOLE_BUFFER_SIZE = 500;

export class ConsoleCollector extends PageCollector<
  ConsoleMessage | Error | DevTools.AggregatedIssue | UncaughtError
> {
  #subscribedPages = new WeakMap<Page, PageEventSubscriber>();

  constructor(
    browser: Browser,
    listeners: (
      collector: (
        item: ConsoleMessage | Error | DevTools.AggregatedIssue | UncaughtError,
      ) => void,
    ) => ListenerMap<PageEvents>,
    options: {maxPerChunk?: number; recordSizeCapBytes?: number} = {},
  ) {
    super(browser, listeners, {
      maxPerChunk: options.maxPerChunk ?? DEFAULT_CONSOLE_BUFFER_SIZE,
      recordSizeCapBytes: options.recordSizeCapBytes,
    });
  }

  /**
   * FR-005: cheap byte estimate for the textual payload that ConsoleFormatter
   * would later surface. We deliberately keep this O(1) per record by skipping
   * arg materialization (which is async / expensive) and only inspecting the
   * synchronous text/details fields.
   */
  protected override estimateRecordBytes(
    item: ConsoleMessage | Error | DevTools.AggregatedIssue | UncaughtError,
  ): number {
    if (item instanceof UncaughtError) {
      return (
        (item.details.text?.length ?? 0) +
        (item.details.exception?.description?.length ?? 0)
      );
    }
    if (item instanceof Error) {
      return (item.message?.length ?? 0) + (item.stack?.length ?? 0);
    }
    if (item instanceof DevTools.AggregatedIssue) {
      // AggregatedIssue is internal — fall back to a constant lower bound.
      return 0;
    }
    // ConsoleMessage: .text() is sync, args() returns handles (skip).
    try {
      const text = item.text();
      return typeof text === 'string' ? text.length : 0;
    } catch {
      return 0;
    }
  }

  override addPage(page: Page): void {
    super.addPage(page);
    if (!this.#subscribedPages.has(page)) {
      const subscriber = new PageEventSubscriber(page);
      this.#subscribedPages.set(page, subscriber);
      void subscriber.subscribe();
    }
  }

  protected override cleanupPageDestroyed(page: Page): void {
    super.cleanupPageDestroyed(page);
    this.#subscribedPages.get(page)?.unsubscribe();
    this.#subscribedPages.delete(page);
  }
}

class PageEventSubscriber {
  #issueManager = new FakeIssuesManager();
  #issueAggregator = new DevTools.IssueAggregator(this.#issueManager);
  #seenKeys = new Set<string>();
  #seenIssues = new Set<DevTools.AggregatedIssue>();
  #page: Page;
  #session: CDPSession;
  #targetId: string;

  constructor(page: Page) {
    this.#page = page;
    // @ts-expect-error use existing CDP client (internal Puppeteer API).
    this.#session = this.#page._client() as CDPSession;
    // @ts-expect-error use internal Puppeteer API to get target ID
    this.#targetId = this.#session.target()._targetId;
  }

  #resetIssueAggregator() {
    this.#issueManager = new FakeIssuesManager();
    if (this.#issueAggregator) {
      this.#issueAggregator.removeEventListener(
        DevTools.IssueAggregatorEvents.AGGREGATED_ISSUE_UPDATED,
        this.#onAggregatedIssue,
      );
    }
    this.#issueAggregator = new DevTools.IssueAggregator(this.#issueManager);
    this.#issueAggregator.addEventListener(
      DevTools.IssueAggregatorEvents.AGGREGATED_ISSUE_UPDATED,
      this.#onAggregatedIssue,
    );
  }

  async subscribe() {
    this.#resetIssueAggregator();
    this.#page.on('framenavigated', this.#onFrameNavigated);
    this.#page.on('issue', this.#onIssueAdded);
    this.#session.on('Runtime.exceptionThrown', this.#onExceptionThrown);
  }

  unsubscribe() {
    this.#seenKeys.clear();
    this.#seenIssues.clear();
    this.#page.off('framenavigated', this.#onFrameNavigated);
    this.#page.off('issue', this.#onIssueAdded);
    this.#session.off('Runtime.exceptionThrown', this.#onExceptionThrown);
    if (this.#issueAggregator) {
      this.#issueAggregator.removeEventListener(
        DevTools.IssueAggregatorEvents.AGGREGATED_ISSUE_UPDATED,
        this.#onAggregatedIssue,
      );
    }
  }

  #onAggregatedIssue = (
    event: DevTools.Common.EventTarget.EventTargetEvent<DevTools.AggregatedIssue>,
  ) => {
    if (this.#seenIssues.has(event.data)) {
      return;
    }
    this.#seenIssues.add(event.data);
    this.#page.emit('devtoolsAggregatedIssue', event.data);
  };

  #onExceptionThrown = (event: Protocol.Runtime.ExceptionThrownEvent) => {
    this.#page.emit(
      'uncaughtError',
      new UncaughtError(event.exceptionDetails, this.#targetId),
    );
  };

  // On navigation, we reset issue aggregation.
  #onFrameNavigated = (frame: Frame) => {
    // Only split the storage on main frame navigation
    if (frame !== frame.page().mainFrame()) {
      return;
    }
    this.#seenKeys.clear();
    this.#seenIssues.clear();
    this.#resetIssueAggregator();
  };

  #onIssueAdded = (inspectorIssue: Issue) => {
    try {
      // DevTools currently defines this protocol issue code but has no
      // IssuesManager handler for it, so calling into the mapper only warns.
      if (String(inspectorIssue.code) === 'PerformanceIssue') {
        return;
      }
      const issue = DevTools.createIssuesFromProtocolIssue(
        null,
        // @ts-expect-error Protocol types diverge.
        inspectorIssue,
      )[0];
      if (!issue) {
        logger('No issue mapping for for the issue: ', inspectorIssue.code);
        return;
      }

      const primaryKey = issue.primaryKey();
      if (this.#seenKeys.has(primaryKey)) {
        return;
      }
      this.#seenKeys.add(primaryKey);
      this.#issueManager.dispatchEventToListeners(
        DevTools.IssuesManagerEvents.ISSUE_ADDED,
        {
          issue,
          // @ts-expect-error We don't care that issues model is null
          issuesModel: null,
        },
      );
    } catch (error) {
      logger('Error creating a new issue', error);
    }
  };
}

/** FR-002: network buffer default 1000 records per navigation chunk. */
export const DEFAULT_NETWORK_BUFFER_SIZE = 1000;

export class NetworkCollector extends PageCollector<HTTPRequest> {
  constructor(
    browser: Browser,
    listeners: (
      collector: (item: HTTPRequest) => void,
    ) => ListenerMap<PageEvents> = collect => {
      return {
        request: req => {
          collect(req);
        },
      } as ListenerMap;
    },
    options: {maxPerChunk?: number; recordSizeCapBytes?: number} = {},
  ) {
    super(browser, listeners, {
      maxPerChunk: options.maxPerChunk ?? DEFAULT_NETWORK_BUFFER_SIZE,
      recordSizeCapBytes: options.recordSizeCapBytes,
    });
  }

  /**
   * FR-005: estimate retained bytes from URL plus request-header values. The
   * response body is fetched on demand and isn't held by the collector, so we
   * only bound what would actually live in heap until the response settles.
   */
  protected override estimateRecordBytes(item: HTTPRequest): number {
    let bytes = 0;
    try {
      bytes += item.url().length;
      const headers = item.headers();
      for (const [key, value] of Object.entries(headers)) {
        bytes += key.length + (value?.length ?? 0);
      }
    } catch {
      // ignore — Puppeteer may throw on detached requests.
    }
    return bytes;
  }

  override splitAfterNavigation(page: Page) {
    const navigations = this.storage.get(page);
    if (!navigations || navigations.length === 0) {
      return;
    }

    const currentChunk = navigations[0];
    const requests = currentChunk.toArray();

    const lastRequestIdx = requests.findLastIndex(request => {
      return request.frame() === page.mainFrame()
        ? request.isNavigationRequest()
        : false;
    });

    if (lastRequestIdx !== -1) {
      // Carry requests from the latest navigation request onward into the new
      // chunk; preserve the rest in the historical chunk so eviction counters
      // still reflect what happened there.
      const carried = requests.slice(lastRequestIdx);
      const remaining = requests.slice(0, lastRequestIdx);
      currentChunk.replaceItems(remaining);

      const newChunk = new ChunkBuffer<WithSymbolId<HTTPRequest>>(
        this.maxPerChunk,
      );
      for (const item of carried) {
        newChunk.push(item);
      }
      navigations.unshift(newChunk);
    } else {
      navigations.unshift(
        new ChunkBuffer<WithSymbolId<HTTPRequest>>(this.maxPerChunk),
      );
    }
    navigations.splice(this.maxNavigationSaved);
  }
}
