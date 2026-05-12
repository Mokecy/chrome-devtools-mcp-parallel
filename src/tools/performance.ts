/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {promises as fs} from 'node:fs';
import zlib from 'node:zlib';

import {logger} from '../logger.js';
import {zod, DevTools} from '../third_party/index.js';
import type {Page} from '../third_party/index.js';
import type {InsightName, TraceResult} from '../trace-processing/parse.js';
import {
  parseRawTraceBuffer,
  traceResultIsSuccess,
} from '../trace-processing/parse.js';
import {getArtifactDirManager} from '../utils/artifactDir.js';
import {
  StructuredError,
  StructuredErrorCode,
} from '../utils/structuredError.js';
import {summarizeRawBuffer, summarizeTrace} from '../utils/traceSummary.js';

import {ToolCategory} from './categories.js';
import type {Context, Response} from './ToolDefinition.js';
import {definePageTool} from './ToolDefinition.js';

const filePathSchema = zod
  .string()
  .optional()
  .describe(
    'Optional. Absolute (or cwd-relative) path to write the raw trace data to. When omitted the trace is auto-allocated under the artifact directory (FR-008). Use a `.gz` suffix to gzip-compress the output.',
  );

export const startTrace = definePageTool({
  name: 'performance_start_trace',
  description: `Start a performance trace on the selected webpage. Use to find frontend performance issues, Core Web Vitals (LCP, INP, CLS), and improve page load speed.`,
  annotations: {
    category: ToolCategory.PERFORMANCE,
    readOnlyHint: false,
  },
  schema: {
    reload: zod
      .boolean()
      .default(true)
      .describe(
        'Determines if, once tracing has started, the current selected page should be automatically reloaded. Navigate the page to the right URL using the navigate_page tool BEFORE starting the trace if reload or autoStop is set to true.',
      ),
    autoStop: zod
      .boolean()
      .default(true)
      .describe(
        'Determines if the trace recording should be automatically stopped.',
      ),
    filePath: filePathSchema,
  },
  blockedByDialog: true,
  handler: async (request, response, context) => {
    context.validatePath(request.params.filePath);
    if (context.isRunningPerformanceTrace()) {
      response.appendResponseLine(
        'Error: a performance trace is already running. Use performance_stop_trace to stop it. Only one trace can be running at any given time.',
      );
      return;
    }
    context.setIsRunningPerformanceTrace(true);

    const page = request.page;
    const pageUrlForTracing = page.pptrPage.url();

    if (request.params.reload) {
      // Before starting the recording, navigate to about:blank to clear out any state.
      await page.pptrPage.goto('about:blank', {
        waitUntil: ['networkidle0'],
      });
    }

    // Keep in sync with the categories arrays in:
    // https://source.chromium.org/chromium/chromium/src/+/main:third_party/devtools-frontend/src/front_end/panels/timeline/TimelineController.ts
    // https://github.com/GoogleChrome/lighthouse/blob/master/lighthouse-core/gather/gatherers/trace.js
    const categories = [
      '-*',
      'blink.console',
      'blink.user_timing',
      'devtools.timeline',
      'disabled-by-default-devtools.screenshot',
      'disabled-by-default-devtools.timeline',
      'disabled-by-default-devtools.timeline.invalidationTracking',
      'disabled-by-default-devtools.timeline.frame',
      'disabled-by-default-devtools.timeline.stack',
      'disabled-by-default-v8.cpu_profiler',
      'disabled-by-default-v8.cpu_profiler.hires',
      'latencyInfo',
      'loading',
      'disabled-by-default-lighthouse',
      'v8.execute',
      'v8',
    ];
    await page.pptrPage.tracing.start({
      categories,
    });

    if (request.params.reload) {
      await page.pptrPage.goto(pageUrlForTracing, {
        waitUntil: ['load'],
      });
    }

    if (request.params.autoStop) {
      await new Promise(resolve => setTimeout(resolve, 5_000));
      await stopTracingAndAppendOutput(
        page.pptrPage,
        response,
        context,
        request.params.filePath,
      );
    } else {
      response.appendResponseLine(
        `The performance trace is being recorded. Use performance_stop_trace to stop it.`,
      );
    }
  },
});

export const stopTrace = definePageTool({
  name: 'performance_stop_trace',
  description:
    'Stop the active performance trace recording on the selected webpage.',
  annotations: {
    category: ToolCategory.PERFORMANCE,
    readOnlyHint: false,
  },
  schema: {
    filePath: filePathSchema,
  },
  blockedByDialog: true,
  handler: async (request, response, context) => {
    context.validatePath(request.params.filePath);
    if (!context.isRunningPerformanceTrace()) {
      return;
    }
    const page = request.page;
    await stopTracingAndAppendOutput(
      page.pptrPage,
      response,
      context,
      request.params.filePath,
    );
  },
});

export const analyzeInsight = definePageTool({
  name: 'performance_analyze_insight',
  description:
    'Provides more detailed information on a specific Performance Insight of an insight set that was highlighted in the results of a trace recording.',
  annotations: {
    category: ToolCategory.PERFORMANCE,
    readOnlyHint: true,
  },
  schema: {
    insightSetId: zod
      .string()
      .describe(
        'The id for the specific insight set. Only use the ids given in the "Available insight sets" list.',
      ),
    insightName: zod
      .string()
      .describe(
        'The name of the Insight you want more information on. For example: "DocumentLatency" or "LCPBreakdown"',
      ),
  },
  blockedByDialog: false,
  handler: async (request, response, context) => {
    const lastRecording = context.recordedTraces().at(-1);
    if (!lastRecording) {
      response.appendResponseLine(
        'No recorded traces found. Record a performance trace so you have Insights to analyze.',
      );
      return;
    }

    response.attachTraceInsight(
      lastRecording,
      request.params.insightSetId,
      request.params.insightName as InsightName,
    );
  },
});

async function stopTracingAndAppendOutput(
  page: Page,
  response: Response,
  context: Context,
  filePath?: string,
): Promise<void> {
  try {
    const traceEventsBuffer = await page.tracing.stop();

    // FR-008 — choose the on-disk target. Caller-supplied paths win; otherwise
    // allocate under the central artifact dir so the response can stay tiny.
    const wantsGzip = filePath ? filePath.endsWith('.gz') : false;
    const ext = wantsGzip ? '.json.gz' : '.json';

    let writtenPath: string | undefined;
    let dataToWrite: Uint8Array | undefined;

    if (traceEventsBuffer) {
      let targetPath: string;
      let usedClientPath = false;
      if (filePath) {
        targetPath = filePath;
        usedClientPath = true;
      } else {
        targetPath = getArtifactDirManager().allocate(
          'traces',
          'page',
          ext,
        ).filePath;
      }

      dataToWrite = wantsGzip
        ? await new Promise<Uint8Array>((resolve, reject) => {
            zlib.gzip(traceEventsBuffer, (error, result) => {
              if (error) {
                reject(error);
              } else {
                resolve(result);
              }
            });
          })
        : traceEventsBuffer;

      writtenPath = targetPath;
      try {
        if (usedClientPath) {
          const file = await context.saveFile(dataToWrite, targetPath, ext);
          writtenPath = file.filename;
        } else {
          await fs.writeFile(targetPath, dataToWrite);
        }
      } catch (err) {
        throw new StructuredError({
          code: StructuredErrorCode.DISK_WRITE_FAILED,
          message: `Failed to persist trace to ${targetPath}.`,
          recoverable: true,
          nextAction:
            'Verify the artifact directory is writable, or pass an explicit `filePath`. See `--artifact-dir`.',
          detail: {targetPath},
          cause: err instanceof Error ? err : undefined,
        });
      }

      if (usedClientPath) {
        response.appendResponseLine(
          `The raw trace data was saved to ${writtenPath}.`,
        );
      }
    }

    const result = await parseRawTraceBuffer(traceEventsBuffer);
    response.appendResponseLine('The performance trace has been stopped.');

    if (traceEventsBuffer && writtenPath && dataToWrite) {
      const summary = traceResultIsSuccess(result)
        ? summarizeTrace(traceEventsBuffer, result)
        : summarizeRawBuffer(traceEventsBuffer);

      response.setTracePersistence({
        filePath: writtenPath,
        sizeBytes: dataToWrite.byteLength,
        summary,
      });
    }

    if (traceResultIsSuccess(result)) {
      if (context.isCruxEnabled()) {
        await populateCruxData(result);
      }
      context.storeTraceRecording(result);
      response.attachTraceSummary(result);
    } else {
      throw new Error(
        `There was an unexpected error parsing the trace: ${result.error}`,
      );
    }
  } finally {
    context.setIsRunningPerformanceTrace(false);
  }
}

/** We tell CrUXManager to fetch data so it's available when DevTools.PerformanceTraceFormatter is invoked */
async function populateCruxData(result: TraceResult): Promise<void> {
  logger('populateCruxData called');
  const cruxManager = DevTools.CrUXManager.instance();
  // go/jtfbx. Yes, we're aware this API key is public. ;)
  cruxManager.setEndpointForTesting(
    'https://chromeuxreport.googleapis.com/v1/records:queryRecord?key=AIzaSyBn5gimNjhiEyA_euicSKko6IlD3HdgUfk',
  );
  const cruxSetting =
    DevTools.Common.Settings.Settings.instance().createSetting('field-data', {
      enabled: true,
    });
  cruxSetting.set({enabled: true});

  // Gather URLs to fetch CrUX data for
  const urls = [...(result.parsedTrace.insights?.values() ?? [])].map(c =>
    c.url.toString(),
  );
  urls.push(result.parsedTrace.data.Meta.mainFrameURL);
  const urlSet = new Set(urls);

  if (urlSet.size === 0) {
    logger('No URLs found for CrUX data');
    return;
  }

  logger(
    `Fetching CrUX data for ${urlSet.size} URLs: ${Array.from(urlSet).join(', ')}`,
  );
  const cruxData = await Promise.all(
    Array.from(urlSet).map(async url => {
      const data = await cruxManager.getFieldDataForPage(url);
      logger(`CrUX data for ${url}: ${data ? 'found' : 'not found'}`);
      return data;
    }),
  );

  result.parsedTrace.metadata.cruxFieldData = cruxData;
}
