/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {zod} from '../third_party/index.js';
import type {ElementHandle, Page} from '../third_party/index.js';
import {
  StructuredError,
  StructuredErrorCode,
} from '../utils/structuredError.js';

import {ToolCategory} from './categories.js';
import {definePageTool} from './ToolDefinition.js';

/**
 * FR-006 / FR-007 — default cap for inline base64 payloads when the caller
 * explicitly opts in via `returnBase64: true`. Falls back to 1 MB unless
 * `CDM_INLINE_PAYLOAD_MAX_MB` is set; CLI override is plumbed through the
 * env so tools that don't see `ParallelServerArgs` still respect it.
 */
const DEFAULT_INLINE_PAYLOAD_MAX_MB = 1;

function inlinePayloadMaxBytes(): number {
  const raw = process.env['CDM_INLINE_PAYLOAD_MAX_MB'];
  const parsed = raw === undefined ? NaN : Number(raw);
  const mb =
    Number.isFinite(parsed) && parsed > 0
      ? parsed
      : DEFAULT_INLINE_PAYLOAD_MAX_MB;
  return Math.floor(mb * 1024 * 1024);
}

export const screenshot = definePageTool({
  name: 'take_screenshot',
  description: `Take a screenshot of the page or element.`,
  annotations: {
    category: ToolCategory.DEBUGGING,
    // Not read-only due to filePath param.
    readOnlyHint: false,
  },
  schema: {
    format: zod
      .enum(['png', 'jpeg', 'webp'])
      .default('png')
      .describe('Type of format to save the screenshot as. Default is "png"'),
    quality: zod
      .number()
      .min(0)
      .max(100)
      .optional()
      .describe(
        'Compression quality for JPEG and WebP formats (0-100). Higher values mean better quality but larger file sizes. Ignored for PNG format.',
      ),
    uid: zod
      .string()
      .optional()
      .describe(
        'The uid of an element on the page from the page content snapshot. If omitted, takes a page screenshot.',
      ),
    fullPage: zod
      .boolean()
      .optional()
      .describe(
        'If set to true takes a screenshot of the full page instead of the currently visible viewport. Incompatible with uid.',
      ),
    filePath: zod
      .string()
      .optional()
      .describe(
        'The absolute path, or a path relative to the current working directory, to save the screenshot to instead of attaching it to the response.',
      ),
    returnBase64: zod
      .boolean()
      .default(false)
      .optional()
      .describe(
        'When true, return the screenshot inline as base64 in the MCP response (legacy behaviour). Default false: the screenshot is always persisted to disk to keep the MCP pipe small (FR-007). Inline base64 is rejected when the payload exceeds CDM_INLINE_PAYLOAD_MAX_MB (default 1 MB) with a structured INLINE_PAYLOAD_TOO_LARGE error.',
      ),
  },
  blockedByDialog: true,
  handler: async (request, response, context) => {
    context.validatePath(request.params.filePath);
    if (request.params.uid && request.params.fullPage) {
      throw new Error('Providing both "uid" and "fullPage" is not allowed.');
    }

    let pageOrHandle: Page | ElementHandle;
    if (request.params.uid) {
      pageOrHandle = await request.page.getElementByUid(request.params.uid);
    } else {
      pageOrHandle = request.page.pptrPage;
    }

    const format = request.params.format;
    const quality = format === 'png' ? undefined : request.params.quality;

    const screenshot = await pageOrHandle.screenshot({
      type: format,
      fullPage: request.params.fullPage,
      quality,
      optimizeForSpeed: true, // Bonus: optimize encoding for speed
    });

    if (request.params.uid) {
      response.appendResponseLine(
        `Took a screenshot of node with uid "${request.params.uid}".`,
      );
    } else if (request.params.fullPage) {
      response.appendResponseLine(
        'Took a screenshot of the full current page.',
      );
    } else {
      response.appendResponseLine(
        "Took a screenshot of the current page's viewport.",
      );
    }

    // 1) Caller specified a target file path — honour it and stop.
    if (request.params.filePath) {
      const result = await context.saveFile(
        screenshot,
        request.params.filePath,
        `.${format}`,
      );
      response.appendResponseLine(`Saved screenshot to ${result.filename}.`);
      return;
    }

    // 2) Caller wants the legacy inline base64 path.
    if (request.params.returnBase64) {
      const cap = inlinePayloadMaxBytes();
      if (screenshot.length > cap) {
        throw new StructuredError({
          code: StructuredErrorCode.INLINE_PAYLOAD_TOO_LARGE,
          message: `Screenshot is ${screenshot.length} bytes; the inline-base64 cap is ${cap} bytes.`,
          recoverable: true,
          nextAction:
            'Re-call without `returnBase64`, or pass `filePath` to write the file yourself, or raise CDM_INLINE_PAYLOAD_MAX_MB.',
          detail: {
            payloadBytes: screenshot.length,
            inlineCapBytes: cap,
            format,
          },
        });
      }
      response.attachImage({
        mimeType: `image/${format}`,
        data: Buffer.from(screenshot).toString('base64'),
      });
      return;
    }

    // 3) Default (FR-007): persist to disk; the response only carries the path.
    const {filepath} = await context.saveTemporaryFile(
      screenshot,
      `screenshot.${format}`,
    );
    response.appendResponseLine(`Saved screenshot to ${filepath}.`);
  },
});
