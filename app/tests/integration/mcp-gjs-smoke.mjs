// Smoke test: the postbote MCP stdio server runs natively on GJS and answers a real
// `initialize` + `tools/list` + `tools/call` handshake driven by the MCP SDK client — then
// EXITS when its client goes away.
//
// Launched via `gjsify run` (the production entry): it resolves every dependency's native
// prebuild paths on its own and keeps stdout uncontaminated (its banner goes to stderr), so we
// spawn it with a CLEAN env — no manual LD_LIBRARY_PATH / GI_TYPELIB_PATH. A green run proves
// no launcher wrapper is needed.
//
// Prerequisite: `gjsify install` + `gjsify workspace postbote-cli build`, and gjs on PATH.
// Run with: `node app/tests/integration/mcp-gjs-smoke.mjs`.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';

const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..', '..'); // tests/integration -> app
const repoRoot = join(appRoot, '..'); // app -> repo root
const bundle = join(appRoot, 'dist', 'postbote.gjs.mjs');
assert(existsSync(bundle), 'build first — app/dist/postbote.gjs.mjs missing');

// The gjsify bin lives in the WORKSPACE ROOT's node_modules, not app/'s.
const gjsify = join(repoRoot, 'node_modules', '.bin', 'gjsify');
assert(existsSync(gjsify), 'run `gjsify install` first — @gjsify/cli bin missing');

// Clean env: strip native paths so success proves `gjsify run` resolves them itself.
const env = { ...process.env };
delete env.LD_LIBRARY_PATH;
delete env.GI_TYPELIB_PATH;

const EXPECTED_TOOLS = [
  'accounts_list',
  'calendar_list_events',
  'contacts_search',
  'mail_get_message',
  'mail_list_folders',
  'mail_list_parts',
  'mail_save_attachment',
  'mail_search',
];

// ── 1. handshake, catalogue, and one real call ──────────────────────────────

const transport = new StdioClientTransport({
  command: gjsify,
  args: ['run', bundle, 'mcp'],
  env,
  cwd: appRoot,
  stderr: 'inherit',
});

const client = new Client({ name: 'gjs-smoke', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);

const info = client.getServerVersion();
assert.equal(info?.name, 'postbote', `unexpected server name: ${info?.name}`);

const { tools } = await client.listTools();
assert.deepEqual(
  tools.map((t) => t.name).sort(),
  EXPECTED_TOOLS,
  'tool catalogue drifted — update EXPECTED_TOOLS deliberately, it is the client contract',
);

// The read-only promise, asserted ON THE WIRE rather than in the source: this is what an MCP
// client actually sees. A tool that lost its annotation would have been dropped by the gate and
// failed the catalogue check above; one that gained `readOnlyHint: false` fails here.
for (const tool of tools) {
  assert.equal(tool.annotations?.readOnlyHint, true, `tool ${tool.name} is not marked read-only`);
}
console.log(`OK: MCP stdio server on GJS — ${tools.length} read-only tools (${info.name} ${info.version})`);

// A real tools/call. Tolerate environments without GOA (headless CI has no session bus): we
// assert the server answers with a well-formed result, not that it succeeds.
const res = await client.callTool({ name: 'accounts_list', arguments: {} });
assert(Array.isArray(res.content) && res.content.length > 0, 'accounts_list returned no content');
if (res.isError) {
  console.log(
    `OK: accounts_list callable (GOA unavailable here: ${String(res.content[0].text).slice(0, 80)})`,
  );
} else {
  const payload = JSON.parse(res.content[0].text);
  assert(Array.isArray(payload.accounts), 'expected an accounts array');
  console.log(`OK: accounts_list → ${payload.accounts.length} account(s)`);
}

await client.close();

// ── 2. the server exits when its client goes away ───────────────────────────
//
// A regression test, not a nicety. The obvious park — `await new Promise(() => {})` — is
// unsettleable, so a server whose client died kept running forever; such processes were found
// REPARENTED TO `systemd --user`, which only happens once their spawner is gone. The SDK will
// not report EOF (its StdioServerTransport listens for `data`/`error` only), so this is the
// server author's job and nothing else would catch a regression.
//
// Driven with a raw spawn on purpose: StdioClientTransport.close() KILLS the child, which would
// pass whether or not EOF is handled.

const child = spawn(gjsify, ['run', bundle, 'mcp'], {
  env,
  cwd: appRoot,
  stdio: ['pipe', 'pipe', 'inherit'],
});
const exitedEarly = await Promise.race([
  new Promise((r) => child.once('exit', (code) => r(`exited early with ${code}`))),
  new Promise((r) => setTimeout(() => r(null), 4000)),
]);
assert.equal(exitedEarly, null, `server did not stay up while stdin was open: ${exitedEarly}`);

child.stdin.end(); // EOF — "your client is gone"
const outcome = await Promise.race([
  new Promise((r) => child.once('exit', (code) => r(code))),
  new Promise((r) => setTimeout(() => r('timeout'), 15000)),
]);
if (outcome === 'timeout') {
  child.kill('SIGKILL');
  assert.fail('server did not exit within 15s of stdin EOF — it would be orphaned');
}
assert.equal(outcome, 0, `server exited with ${outcome} on stdin EOF, expected 0`);
console.log('OK: server exits cleanly on stdin EOF (no orphan)');

process.exit(0);
