// Integration test: postbote's XMPP backend on GJS against a REAL XMPP server, run locally.
//
//   1. Start Prosody (podman, mod_mam + mod_muc_mam) with two throwaway accounts on `localhost`.
//   2. Set the scene from Node with plain xmpp.js: alice's roster and a bookmarked room; bob
//      writes to alice, corrects one message, retracts another, and talks in the room.
//   3. postbote on GJS logs in as alice over WebSocket (loopback) and syncs the archive.
//   4. bob writes once more; postbote syncs again and must fetch exactly that one message.
//   5. Direct TLS (XEP-0368): on GJS it must refuse with the gjsify#1837 gap (gjsify 0.49.0 has
//      no working TLS socket); the SAME postbote code built for Node must connect over it,
//      checking the certificate against the XMPP domain with the test CA as `tlsCaFile`.
//   6. Read-only proof: alice's offline messages are still queued — a client that had sent
//      presence would have taken them — and bob saw no presence from alice.
//
// Every account, message and certificate is synthetic and lives only in the container, which is
// removed at the end whatever happens. Skipped (exit 0, reason printed) when podman is missing.
//
// Prerequisite: `gjsify install`. Run: `gjsify workspace postbote-cli test:xmpp-server`.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert';
import { client, xml } from '@xmpp/client';

const IMAGE = 'docker.io/prosodyim/prosody:13.0';
const here = dirname(fileURLToPath(import.meta.url));
const appRoot = join(here, '..', '..');
const repoRoot = join(appRoot, '..');
const gjsify = join(repoRoot, 'node_modules', '.bin', 'gjsify');

function have(cmd, args = ['--version']) {
  return spawnSync(cmd, args, { stdio: 'ignore' }).status === 0;
}
if (!have('podman')) {
  console.log('SKIP xmpp integration: podman is not installed (needed to run a local Prosody)');
  process.exit(0);
}
if (!have('openssl', ['version'])) {
  console.log('SKIP xmpp integration: openssl is not installed (needed for the test certificate)');
  process.exit(0);
}

const run = (cmd, args, options = {}) =>
  String(execFileSync(cmd, args, { encoding: 'utf8', ...options }) ?? '').trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const dir = mkdtempSync(join(tmpdir(), 'postbote-xmpp-it-'));
const name = `postbote-xmpp-it-${process.pid}`;
const PASSWORD_A = `alice-${Math.random().toString(36).slice(2)}`;
const PASSWORD_B = `bob-${Math.random().toString(36).slice(2)}`;
const ROOM = 'orga@conference.localhost';

const config = `
plugin_paths = {}
admins = {}
modules_enabled = {
  "disco"; "roster"; "saslauth"; "tls"; "private"; "pep"; "bookmarks"; "offline";
  "mam"; "ping"; "http"; "websocket";
}
modules_disabled = { "s2s" }
authentication = "internal_hashed"
storage = "internal"
data_path = "/var/lib/prosody"
pidfile = "/var/run/prosody/prosody.pid"
log = { info = "*console" }
c2s_require_encryption = false
allow_unencrypted_plain_auth = false
archive_expires_after = "never"
default_archive_policy = true
http_ports = { 5280 }
http_interfaces = { "*" }
https_ports = {}
c2s_direct_tls_ports = { 5223 }
c2s_ports = { 5222 }
cross_domain_websocket = true
consider_websocket_secure = false
VirtualHost "localhost"
  ssl = { certificate = "/etc/prosody/certs/localhost.crt"; key = "/etc/prosody/certs/localhost.key"; }
Component "conference.localhost" "muc"
  modules_enabled = { "muc_mam" }
  muc_room_locking = false
  muc_room_default_public = true
  muc_room_default_persistent = true
  muc_log_by_default = true
  muc_log_all_rooms = true
`;

let failed = false;
try {
  // ── 1. the server ─────────────────────────────────────────────────────
  writeFileSync(join(dir, 'prosody.cfg.lua'), config);
  run(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-days',
      '1',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost',
      '-addext',
      'basicConstraints=critical,CA:TRUE',
      '-keyout',
      join(dir, 'localhost.key'),
      '-out',
      join(dir, 'localhost.crt'),
    ],
    { stdio: 'ignore' },
  );
  // Throwaway key of a throwaway container: readable by the prosody user inside.
  chmodSync(join(dir, 'localhost.key'), 0o644);

  run('podman', ['create', '--name', name, '-p', '127.0.0.1::5280', '-p', '127.0.0.1::5223', IMAGE]);
  run('podman', ['cp', join(dir, 'prosody.cfg.lua'), `${name}:/etc/prosody/prosody.cfg.lua`]);
  run('podman', ['cp', join(dir, 'localhost.crt'), `${name}:/etc/prosody/certs/localhost.crt`]);
  run('podman', ['cp', join(dir, 'localhost.key'), `${name}:/etc/prosody/certs/localhost.key`]);
  run('podman', ['start', name]);
  const port = (inner) =>
    run('podman', ['port', name, `${inner}/tcp`])
      .split('\n')[0]
      .split(':')
      .pop();
  const wsPort = port(5280);
  const tlsPort = port(5223);
  const WS = `ws://localhost:${wsPort}/xmpp-websocket`;
  for (let i = 0; ; i++) {
    const probe = spawnSync('curl', [
      '-s',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      `http://127.0.0.1:${wsPort}/`,
    ]);
    if (probe.stdout?.toString() !== '000' && probe.status === 0) break;
    if (i > 50) throw new Error('prosody did not come up');
    await sleep(200);
  }
  for (const [user, password] of [
    ['alice', PASSWORD_A],
    ['bob', PASSWORD_B],
  ]) {
    run('podman', ['exec', name, 'prosodyctl', 'register', user, 'localhost', password]);
  }
  console.log(`prosody up: websocket :${wsPort}, direct TLS :${tlsPort}`);

  const connect = async (username, password) => {
    const c = client({ service: WS, domain: 'localhost', username, password, resource: 'setup' });
    c.on('error', () => {});
    await c.start();
    return c;
  };

  // ── 2. the scene ──────────────────────────────────────────────────────
  const alice = await connect('alice', PASSWORD_A);
  await alice.iqCaller.set(
    xml('query', { xmlns: 'jabber:iq:roster' }, xml('item', { jid: 'bob@localhost', name: 'Bob' })),
  );
  await alice.iqCaller.set(
    xml(
      'query',
      { xmlns: 'jabber:iq:private' },
      xml(
        'storage',
        { xmlns: 'storage:bookmarks' },
        xml('conference', { jid: ROOM, name: 'Orga', autojoin: 'true' }, xml('nick', {}, 'alice')),
      ),
    ),
  );
  await alice.stop();

  const bob = await connect('bob', PASSWORD_B);
  const presences = [];
  bob.on('stanza', (s) => {
    if (s.is('presence') && String(s.attrs.from ?? '').startsWith('alice@')) presences.push(s.toString());
  });
  const chat = (id, children) =>
    bob.send(xml('message', { to: 'alice@localhost', type: 'chat', id }, ...children));
  const body = (text) => xml('body', {}, text);
  await chat('m1', [body('Kommst du am Samstag?'), xml('origin-id', { xmlns: 'urn:xmpp:sid:0', id: 'm1' })]);
  await chat('m2', [body('Das war falsch'), xml('origin-id', { xmlns: 'urn:xmpp:sid:0', id: 'm2' })]);
  await chat('m3', [body('Bringst du Salat mit?')]);
  await chat('m4', [
    body('Kommst du am Sonntag?'),
    xml('replace', { xmlns: 'urn:xmpp:message-correct:0', id: 'm1' }),
  ]);
  await chat('m5', [
    xml('retract', { xmlns: 'urn:xmpp:message-retract:1', id: 'm2' }),
    body('/me retracted a message'),
  ]);
  // The room: bob joins (and creates it), then talks.
  await bob.send(
    xml('presence', { to: `${ROOM}/bob` }, xml('x', { xmlns: 'http://jabber.org/protocol/muc' })),
  );
  await sleep(500);
  await bob.send(xml('message', { to: ROOM, type: 'groupchat', id: 'g1' }, body('Hallo Orga')));
  await bob.send(xml('message', { to: ROOM, type: 'groupchat', id: 'g2' }, body('Wer macht die Liste?')));
  await sleep(500);

  // ── 3. postbote on GJS, over WebSocket ────────────────────────────────
  const entries = {
    gjs: join(appRoot, 'dist', 'xmpp-archive.gjs.mjs'),
    node: join(appRoot, 'dist', 'xmpp-archive.node.mjs'),
  };
  for (const [app, outfile] of Object.entries(entries)) {
    run(gjsify, ['build', join(here, 'xmpp-archive.ts'), '--app', app, '--outfile', outfile], {
      cwd: appRoot,
      stdio: 'ignore',
    });
  }
  const dataDir = join(dir, 'data');
  const attempt = (input, runtime = 'gjs') => {
    const env = {
      ...process.env,
      POSTBOTE_XMPP_IT: JSON.stringify({ dataDir, jid: 'alice@localhost', password: PASSWORD_A, ...input }),
    };
    const [cmd, args] =
      runtime === 'gjs' ? [gjsify, ['run', entries.gjs]] : [process.execPath, [entries.node]];
    const out = spawnSync(cmd, args, { cwd: appRoot, env, encoding: 'utf8', timeout: 180_000 });
    const line = out.stdout.split('\n').find((l) => l.startsWith('RESULT '));
    return { result: line ? JSON.parse(line.slice(7)) : null, out };
  };
  const postbote = (input, runtime) => {
    const { result, out } = attempt(input, runtime);
    if (!result)
      throw new Error(
        `postbote (${runtime ?? 'gjs'}) failed (exit ${out.status}):\n${out.stderr.slice(-3000)}`,
      );
    return result;
  };
  const first = postbote({ service: WS, caFile: null, add: true });
  console.log(
    `first sync (WebSocket) in ${first.ms} ms: ${first.added} messages, ${first.fetched} chats fetched`,
  );
  assert.deepStrictEqual(first.errors, []);
  assert.strictEqual(first.chatErrors, 0);
  const direct = first.chats.find((c) => c.kind === 'direct');
  const room = first.chats.find((c) => c.kind === 'group');
  assert(direct, 'the direct chat with bob is missing');
  assert(room, 'the bookmarked room is missing');
  assert.deepStrictEqual(
    direct.messages.map((m) => `${m.text}${m.edited ? ' (edited)' : ''}`),
    ['Kommst du am Sonntag? (edited)', 'Bringst du Salat mit?'],
    'correction applied, retracted message gone',
  );
  assert.deepStrictEqual(
    room.messages.map((m) => `${m.sender}: ${m.text}`),
    ['bob: Hallo Orga', 'bob: Wer macht die Liste?'],
  );

  // ── 4. incremental ────────────────────────────────────────────────────
  await chat('m6', [body('Bis Samstag!')]);
  await sleep(300);
  const second = postbote({ service: WS, caFile: null, add: false });
  console.log(
    `second sync (WebSocket) in ${second.ms} ms: ${second.added} message(s), ${second.fetched} chat(s) fetched`,
  );
  assert.deepStrictEqual(second.errors, []);
  assert.strictEqual(second.added, 1, 'only the new message is fetched');
  assert.strictEqual(second.fetched, 1, 'the unchanged room is caught up by its archive id');
  assert.strictEqual(
    second.chats
      .find((c) => c.kind === 'direct')
      .messages.map((m) => m.text)
      .at(-1),
    'Bis Samstag!',
  );

  // ── 5. direct TLS: refused on GJS 0.49.0, working on Node ─────────────
  const tls = { service: `xmpps://127.0.0.1:${tlsPort}`, caFile: join(dir, 'localhost.crt'), add: true };
  const refused = attempt(tls, 'gjs');
  assert.strictEqual(refused.result, null, 'GJS must not claim a direct-TLS login on gjsify 0.49.0');
  assert(refused.out.stderr.includes('gjsify#1837'), `no gap message:\n${refused.out.stderr.slice(-1500)}`);
  await chat('m7', [body('Und Kuchen!')]);
  await sleep(300);
  const third = postbote(tls, 'node');
  console.log(`third sync (direct TLS, Node) in ${third.ms} ms: ${third.added} message(s)`);
  assert.deepStrictEqual(third.errors, []);
  assert.strictEqual(third.added, 1);

  // ── 6. read-only: nothing was taken, nothing was announced ────────────
  assert.deepStrictEqual(presences, [], 'bob saw presence from alice');
  await bob.stop();
  const check = client({
    service: WS,
    domain: 'localhost',
    username: 'alice',
    password: PASSWORD_A,
    resource: 'check',
  });
  check.on('error', () => {});
  const offline = [];
  check.on('stanza', (s) => {
    if (s.is('message') && s.getChild('delay', 'urn:xmpp:delay') && s.getChildText('body'))
      offline.push(s.getChildText('body'));
  });
  await check.start();
  await check.send(xml('presence'));
  await sleep(1500);
  await check.stop();
  assert(
    offline.includes('Und Kuchen!') && offline.includes('Bringst du Salat mit?'),
    `alice's offline messages were consumed: ${JSON.stringify(offline)}`,
  );
  console.log(
    `read-only: ${offline.length} offline messages still queued after three syncs; no presence seen`,
  );
  console.log('xmpp integration OK');
} catch (err) {
  failed = true;
  console.error('xmpp integration FAILED:', err instanceof Error ? (err.stack ?? err.message) : err);
  const logs = spawnSync('podman', ['logs', '--tail', '40', name], { encoding: 'utf8' });
  if (logs.stdout || logs.stderr) console.error(`--- prosody log ---\n${logs.stdout}${logs.stderr}`);
} finally {
  spawnSync('podman', ['rm', '-f', name], { stdio: 'ignore' });
  rmSync(dir, { recursive: true, force: true });
  for (const f of ['xmpp-archive.gjs.mjs', 'xmpp-archive.node.mjs'])
    rmSync(join(appRoot, 'dist', f), { force: true });
}
process.exit(failed ? 1 : 0);
