// Smoke test: the postbote MCP stdio server runs natively on GJS and answers a real
// `initialize` + `tools/list` + `tools/call` handshake driven by the MCP SDK client, EXITS when
// its client goes away, and DROPS a tool that declares itself mutating.
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
  'mail_search_local',
  'mail_sync_status',
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

// ── 3. the read-only gate actually CLOSES ─────────────────────────────────────
//
// Section 1 asserts every served tool is read-only. That is necessary and NOT sufficient: all
// ten real tools declare `readOnlyHint: true`, so a gate that had quietly stopped wrapping
// `registerTool` would serve exactly the same catalogue and section 1 would still pass. It
// cannot distinguish a working gate from no gate at all.
//
// So ask the gate to do the thing it exists for. `POSTBOTE_MCP_GATE_CANARY=1` registers one
// tool declaring `readOnlyHint: false`, through the same `server.registerTool` the real tools
// use, after the gate has wrapped it.
//
// TWO runs, and the second is the point. "Canary absent" alone is worthless evidence: it is
// equally consistent with the gate dropping it and with the canary never being registered. The
// run with writes ALLOWED must show the canary present, which is what proves the first run's
// absence was the gate acting rather than nothing happening.

async function listToolNames(extraEnv) {
  const t = new StdioClientTransport({
    command: gjsify,
    args: ['run', bundle, 'mcp'],
    env: { ...env, ...extraEnv },
    cwd: appRoot,
    stderr: 'inherit',
  });
  const c = new Client({ name: 'gate-probe', version: '1.0.0' }, { capabilities: {} });
  await c.connect(t);
  const { tools: list } = await c.listTools();
  await c.close();
  return list.map((x) => x.name).sort();
}

// Both must be dropped, and they fail for DIFFERENT reasons — see gate-canary.ts. The
// unannotated one is the load-bearing case: with only the declared-mutating canary, the gate
// was sabotaged to the fail-open spelling and this whole file still passed.
const CANARIES = ['gate_canary_write', 'gate_canary_unannotated'];

const gated = await listToolNames({ POSTBOTE_MCP_GATE_CANARY: '1' });
for (const canary of CANARIES) {
  assert(!gated.includes(canary), `READ-ONLY GATE IS OPEN: ${canary} was served — ${gated.join(', ')}`);
}
assert.deepEqual(gated, EXPECTED_TOOLS, 'gated catalogue drifted');
console.log(`OK: gate DROPS both canaries (${gated.length} tools served, neither canary present)`);

// The discriminator. If this fails, the canary is not reaching the server at all and the
// assertion above proved nothing.
const ungated = await listToolNames({
  POSTBOTE_MCP_GATE_CANARY: '1',
  POSTBOTE_MCP_ALLOW_WRITE: '1',
});
for (const canary of CANARIES) {
  assert(
    ungated.includes(canary),
    `${canary} never registered — the drop above was a FALSE NEGATIVE, not a working gate (${ungated.join(', ')})`,
  );
}
console.log(`OK: discriminator — with writes allowed both canaries ARE served (${ungated.length} tools)`);

process.exit(0);
