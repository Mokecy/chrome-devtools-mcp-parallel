#!/usr/bin/env node
/**
 * E2E smoke test for parallel MCP server.
 * Launches build/src/bin/chrome-devtools-mcp-parallel.js via stdio,
 * drives JSON-RPC, validates instance_create + page_* tools work.
 *
 * Usage: node scripts/e2e-parallel.mjs
 */

import {spawn} from 'node:child_process';
import {setTimeout as sleep} from 'node:timers/promises';

const SERVER = 'build/src/bin/chrome-devtools-mcp-parallel.js';
const ARGS = ['--headless', '--isolated', '--max-instances', '3'];

const proc = spawn(process.execPath, [SERVER, ...ARGS], {
  stdio: ['pipe', 'pipe', 'pipe'],
});

let stderrBuf = '';
proc.stderr.on('data', d => {
  stderrBuf += d.toString();
});
proc.on('exit', code => {
  console.log(`[server exited code=${code}]`);
});

let nextId = 1;
const pending = new Map();
let buf = '';

proc.stdout.on('data', chunk => {
  buf += chunk.toString();
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (!line) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.id && pending.has(msg.id)) {
        const {resolve, reject} = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    } catch {
      // ignore non-JSON
    }
  }
});

function rpc(method, params) {
  const id = nextId++;
  const payload = {jsonrpc: '2.0', id, method, params};
  return new Promise((resolve, reject) => {
    pending.set(id, {resolve, reject});
    proc.stdin.write(JSON.stringify(payload) + '\n');
    setTimeout(() => {
      if (pending.has(id)) {
        pending.delete(id);
        reject(new Error(`timeout waiting for ${method}`));
      }
    }, 120000);
  });
}

function notify(method, params) {
  proc.stdin.write(
    JSON.stringify({jsonrpc: '2.0', method, params: params ?? {}}) + '\n',
  );
}

function textOf(result) {
  const item = result?.content?.find?.(c => c.type === 'text');
  return item?.text ?? JSON.stringify(result);
}

const failures = [];
function expect(cond, msg) {
  if (!cond) {
    failures.push(msg);
    console.log(`  ✗ ${msg}`);
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

async function main() {
  console.log('→ initialize');
  const initRes = await rpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: {name: 'e2e', version: '1'},
  });
  expect(initRes?.serverInfo, 'initialize returns serverInfo');
  notify('notifications/initialized');

  console.log('→ tools/list');
  const toolsRes = await rpc('tools/list', {});
  const toolNames = new Set(toolsRes.tools.map(t => t.name));
  expect(toolNames.has('instance_create'), 'has instance_create tool');
  expect(toolNames.has('page_navigate_page'), 'has page_navigate_page tool');
  expect(toolNames.has('page_list_pages'), 'has page_list_pages tool');

  // launch-mode instance
  console.log('→ instance_create (launch mode, t1)');
  const createRes = await rpc('tools/call', {
    name: 'instance_create',
    arguments: {instanceId: 't1'},
  });
  const createText = textOf(createRes);
  console.log('  resp:', createText);
  expect(
    !createRes.isError,
    'instance_create succeeds without puppeteer-core channel error',
  );
  expect(
    /created in (launch|cdp) mode/.test(createText),
    'response mentions mode',
  );

  // navigate
  console.log('→ page_navigate_page (t1 → example.com)');
  const navRes = await rpc('tools/call', {
    name: 'page_navigate_page',
    arguments: {instanceId: 't1', url: 'https://example.com/'},
  });
  const navText = textOf(navRes);
  console.log('  resp (first 200):', navText.slice(0, 200));
  expect(
    !navRes.isError,
    'page_navigate_page succeeds (no "No page selected")',
  );
  expect(
    !/No page selected/i.test(navText),
    'no "No page selected" in response',
  );

  // list pages
  console.log('→ page_list_pages (t1)');
  const listRes = await rpc('tools/call', {
    name: 'page_list_pages',
    arguments: {instanceId: 't1'},
  });
  const listText = textOf(listRes);
  console.log('  resp (first 300):', listText.slice(0, 300));
  expect(!listRes.isError, 'page_list_pages succeeds');
  expect(/example\.com|about:blank/i.test(listText), 'list mentions a page');

  // close
  console.log('→ instance_close (t1)');
  const closeRes = await rpc('tools/call', {
    name: 'instance_close',
    arguments: {instanceId: 't1'},
  });
  console.log('  resp:', textOf(closeRes));
  expect(!closeRes.isError, 'instance_close succeeds');

  console.log('→ shutting down');
  proc.stdin.end();
  await sleep(500);
  if (!proc.killed) proc.kill();
}

main()
  .then(() => {
    console.log('');
    if (failures.length === 0) {
      console.log(`✓ E2E passed (${nextId - 1} RPC calls)`);
      process.exit(0);
    } else {
      console.log(`✗ E2E failed (${failures.length} assertion(s)):`);
      for (const f of failures) console.log('  - ' + f);
      console.log('\n--- stderr ---');
      console.log(stderrBuf.slice(-4000));
      process.exit(1);
    }
  })
  .catch(err => {
    console.error('E2E crashed:', err);
    console.log('\n--- stderr ---');
    console.log(stderrBuf.slice(-4000));
    try {
      proc.kill();
    } catch {}
    process.exit(2);
  });
