/**
 * Opt-in integration test: postbote's Matrix backend on GJS decrypts an end-to-end encrypted
 * direct chat, across process restarts, against a real homeserver in a local container.
 *
 *   gjsify workspace postbote-cli test:matrix-e2ee
 *
 * Needs podman (the test is SKIPPED with the reason when it is missing — exit 0, one line) and
 * pulls `forgejo.ellis.link/continuwuation/continuwuity` on first use. Not part of CI.
 *
 * What it does, all with throwaway users on a homeserver that federates with nobody:
 *   1. starts continuwuity on a random localhost port, registers `alice` and `bob`;
 *   2. GJS: `bob` logs in through postbote (`accounts add matrix` in code) — a new device;
 *   3. Node: `alice` (plain matrix-js-sdk, in-memory Rust crypto) creates an encrypted direct
 *      chat, `bob` joins it, `alice` sends two encrypted messages;
 *   4. GJS, a NEW process: postbote restores bob's crypto store from the secret file, syncs,
 *      and must show both messages DECRYPTED;
 *   5. Node: `alice` edits the first, redacts the second, sends a third;
 *   6. GJS again: the edit is applied, the redacted message is gone, the third is there;
 *   7. crash: a GJS process connects and keeps syncing; `alice` sends a fourth message, whose
 *      room key reaches bob's device in a LATER sync cycle (not the first) and is acknowledged
 *      to the server; then the process dies without closing. A new process must decrypt it —
 *      the per-cycle checkpoint of the crypto store is what makes that true;
 *   8. `@bob:localhost` never appeared online: every /sync said `set_presence=offline` (the
 *      read-only gate refuses one that does not, which would have failed a sync above);
 * and checks that neither the password nor the index leaked into the secret file's neighbours.
 * The container and every temporary file are removed at the end, pass or fail.
 */

import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sdk from 'matrix-js-sdk';

const IMAGE = 'forgejo.ellis.link/continuwuation/continuwuity:latest';
const TOKEN = 'postbote-e2ee-test';
const app = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const bundle = join(app, 'dist', 'matrix-e2ee.gjs.mjs');
const log = (...a) => console.log('[matrix-e2ee]', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function have(cmd) {
  return spawnSync(cmd, ['--version'], { stdio: 'ignore' }).status === 0;
}

if (!have('podman')) {
  log('SKIPPED: podman is not installed — this test runs a Matrix homeserver in a container');
  process.exit(0);
}

const quiet = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  getChild() {
    return quiet;
  },
};

const name = `postbote-matrix-e2ee-${process.pid}`;
const work = mkdtempSync(join(tmpdir(), 'postbote-matrix-e2ee-'));
const secrets = join(work, 'secrets');
const index = join(work, 'index.db');
let alice = null;
let failed = false;

function expect(ok, what) {
  if (!ok) throw new Error(`expected ${what}`);
  log(`ok: ${what}`);
}

async function json(url, init) {
  const res = await fetch(url, {
    ...init,
    headers: { 'content-type': 'application/json', ...(init?.headers ?? {}) },
  });
  return res.json();
}

async function register(hs, user, password, token) {
  const { session } = await json(`${hs}/_matrix/client/v3/register`, {
    method: 'POST',
    body: JSON.stringify({ username: user, password }),
  });
  const done = await json(`${hs}/_matrix/client/v3/register`, {
    method: 'POST',
    body: JSON.stringify({
      username: user,
      password,
      inhibit_login: true,
      auth: { type: 'm.login.registration_token', token, session },
    }),
  });
  if (!done.user_id) throw new Error(`registering ${user} failed: ${done.errcode ?? 'unknown'}`);
}

function gjs(step, extra = {}) {
  const run = spawnSync('gjsify', ['run', bundle], {
    cwd: app,
    encoding: 'utf8',
    env: {
      ...process.env,
      MATRIX_E2EE_STEP: step,
      MATRIX_E2EE_SECRETS: secrets,
      MATRIX_E2EE_INDEX: index,
      ...extra,
    },
    timeout: 240_000,
  });
  const line = (run.stdout ?? '').split('\n').find((l) => l.startsWith('{"step"'));
  if (run.status !== 0 || !line) {
    throw new Error(`GJS step ${step} failed (exit ${run.status}):\n${(run.stderr ?? '').slice(-2000)}`);
  }
  return JSON.parse(line);
}

try {
  execFileSync(
    'podman',
    [
      'run',
      '-d',
      '--rm',
      '--name',
      name,
      '-p',
      '127.0.0.1::8008',
      '-e',
      'CONTINUWUITY_SERVER_NAME=localhost',
      '-e',
      'CONTINUWUITY_DATABASE_PATH=/tmp/db',
      '-e',
      'CONTINUWUITY_ADDRESS=0.0.0.0',
      '-e',
      'CONTINUWUITY_PORT=8008',
      '-e',
      'CONTINUWUITY_ALLOW_REGISTRATION=true',
      '-e',
      `CONTINUWUITY_REGISTRATION_TOKEN=${TOKEN}`,
      '-e',
      'CONTINUWUITY_ALLOW_FEDERATION=false',
      '-e',
      'CONTINUWUITY_ALLOW_CHECK_FOR_UPDATES=false',
      IMAGE,
    ],
    { stdio: ['ignore', 'ignore', 'inherit'] },
  );
  const port = execFileSync('podman', ['port', name, '8008'], { encoding: 'utf8' }).trim().split(':').pop();
  const hs = `http://127.0.0.1:${port}`;
  // The first account must use a one-time token the server prints on its first start.
  let firstToken = null;
  for (let i = 0; i < 60 && !firstToken; i++) {
    await sleep(500);
    const logs = spawnSync('podman', ['logs', name], { encoding: 'utf8' });
    firstToken =
      /registration token \S*?([A-Za-z0-9]{16})\S*? \./.exec(
        `${logs.stdout}${logs.stderr}`.replace(/\x1b\[[0-9;]*m/g, ''),
      )?.[1] ?? null;
  }
  if (!firstToken) throw new Error('the homeserver printed no first-run registration token');
  await register(hs, 'alice', 'alice-password-1', firstToken);
  await register(hs, 'bob', 'bob-password-1', TOKEN);
  log(`homeserver up on ${hs}, users registered`);

  // 2. bob logs in through postbote, on GJS.
  const login = gjs('login', {
    MATRIX_E2EE_HS: hs,
    MATRIX_E2EE_USER: 'bob',
    MATRIX_E2EE_PASSWORD: 'bob-password-1',
  });
  expect(login.account.identity === '@bob:localhost', 'postbote logged in as @bob:localhost');
  const files = readdirSync(secrets);
  expect(
    files.length === 1 && files[0] === `${login.account.id}.db`,
    'exactly one account file, no pending leftovers',
  );
  const secretFile = join(secrets, files[0]);
  expect((statSync(secretFile).mode & 0o777) === 0o600, 'the account file is 0600');
  expect(!readFileSync(secretFile).includes('bob-password-1'), 'the password is not stored');

  // 3. alice creates an encrypted DM; bob joins (a second, key-less device does the join, so the
  //    postbote device stays read-only); alice sends two encrypted messages.
  const aliceLogin = await sdk.createClient({ baseUrl: hs, logger: quiet }).loginRequest({
    type: 'm.login.password',
    identifier: { type: 'm.id.user', user: 'alice' },
    password: 'alice-password-1',
  });
  alice = sdk.createClient({
    baseUrl: hs,
    accessToken: aliceLogin.access_token,
    userId: aliceLogin.user_id,
    deviceId: aliceLogin.device_id,
    logger: quiet,
  });
  await alice.initRustCrypto({ useIndexedDB: false });
  await new Promise((resolve) => {
    alice.on(sdk.ClientEvent.Sync, (state) => state === 'PREPARED' && resolve());
    alice.startClient({ initialSyncLimit: 1 });
  });
  const { room_id: roomId } = await alice.createRoom({
    is_direct: true,
    invite: ['@bob:localhost'],
    preset: 'trusted_private_chat',
    initial_state: [
      { type: 'm.room.encryption', state_key: '', content: { algorithm: 'm.megolm.v1.aes-sha2' } },
    ],
  });
  const helper = await json(`${hs}/_matrix/client/v3/login`, {
    method: 'POST',
    body: JSON.stringify({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'bob' },
      password: 'bob-password-1',
    }),
  });
  await json(`${hs}/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
    method: 'POST',
    body: '{}',
    headers: { authorization: `Bearer ${helper.access_token}` },
  });
  for (let i = 0; alice.getRoom(roomId)?.getMember('@bob:localhost')?.membership !== 'join'; i++) {
    if (i > 120) throw new Error('bob never showed up as joined');
    await sleep(250);
  }
  const first = await alice.sendTextMessage(roomId, 'Synthetic secret one');
  const second = await alice.sendTextMessage(roomId, 'Synthetic secret two');
  const raw = await json(
    `${hs}/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(first.event_id)}`,
    { headers: { authorization: `Bearer ${helper.access_token}` } },
  );
  expect(raw.type === 'm.room.encrypted', 'the homeserver only ever saw ciphertext');

  // 4. A new GJS process decrypts, with the crypto store from the secret file.
  let sync = gjs('sync');
  expect(sync.errors === 0, `the first sync had no errors (${sync.error ?? 'none'})`);
  let chat = sync.conversations[0];
  let texts = chat?.messages.map((m) => m.text) ?? [];
  expect(
    texts.includes('Synthetic secret one') && texts.includes('Synthetic secret two'),
    `both messages decrypted (got ${JSON.stringify(texts)})`,
  );
  expect(
    chat.messages.find((m) => m.remoteId === first.event_id)?.sender === '@alice:localhost',
    'the sender is @alice:localhost',
  );

  // 5. alice edits the first, redacts the second, sends a third.
  await alice.sendEvent(roomId, 'm.room.message', {
    msgtype: 'm.text',
    body: '* Synthetic secret one, edited',
    'm.new_content': { msgtype: 'm.text', body: 'Synthetic secret one, edited' },
    'm.relates_to': { rel_type: 'm.replace', event_id: first.event_id },
  });
  await alice.redactEvent(roomId, second.event_id);
  await alice.sendTextMessage(roomId, 'Synthetic secret three');

  // 6. Incremental sync in yet another process.
  sync = gjs('sync');
  expect(sync.errors === 0, `the second sync had no errors (${sync.error ?? 'none'})`);
  chat = sync.conversations[0];
  texts = chat?.messages.map((m) => m.text) ?? [];
  expect(
    !texts.includes('Synthetic secret two') && sync.removed >= 1,
    'the redacted message is gone from the index',
  );
  expect(texts.includes('Synthetic secret one, edited'), 'the edit is applied');
  expect(texts.includes('Synthetic secret three'), 'the new message arrived and decrypted');

  // 7. A crash after a key-receiving sync cycle.
  const crasher = spawn('gjsify', ['run', bundle], {
    cwd: app,
    env: {
      ...process.env,
      MATRIX_E2EE_STEP: 'crash',
      MATRIX_E2EE_SECRETS: secrets,
      MATRIX_E2EE_CRASH_AFTER_MS: '10000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let crashErr = '';
  crasher.stderr.on('data', (d) => (crashErr += d));
  const exited = new Promise((resolve) => crasher.on('exit', (code) => resolve(code)));
  await new Promise((resolve, reject) => {
    let out = '';
    crasher.stdout.on('data', (d) => {
      out += d;
      if (out.includes('"crash-ready"')) resolve();
    });
    crasher.on('exit', (code) =>
      reject(new Error(`crash step ended early (${code}): ${crashErr.slice(-1500)}`)),
    );
  });
  // A NEW room key, so the message cannot ride on a key bob's store already has: without the
  // rotation this step passed with the checkpoint removed (measured), i.e. it proved nothing.
  await alice.getCrypto().forceDiscardSession(roomId);
  await alice.sendTextMessage(roomId, 'Synthetic secret four');
  const code = await exited;
  expect(code === 3, `the crash process died hard (exit ${code})`);
  sync = gjs('sync');
  expect(sync.errors === 0, `the sync after the crash had no errors (${sync.error ?? 'none'})`);
  texts = sync.conversations[0]?.messages.map((m) => m.text) ?? [];
  expect(
    texts.includes('Synthetic secret four'),
    `the key received before the crash survived it (got ${JSON.stringify(texts)})`,
  );

  // 8. Never online.
  const presence = await json(
    `${hs}/_matrix/client/v3/presence/${encodeURIComponent('@bob:localhost')}/status`,
    {
      headers: { authorization: `Bearer ${aliceLogin.access_token}` },
    },
  );
  expect(
    presence.presence !== 'online',
    `@bob:localhost never showed as online (presence: ${presence.presence ?? presence.errcode})`,
  );
  log('PASSED');
} catch (err) {
  failed = true;
  console.error('[matrix-e2ee] FAILED:', err instanceof Error ? err.message : err);
} finally {
  alice?.stopClient();
  spawnSync('podman', ['rm', '-f', name], { stdio: 'ignore' });
  rmSync(work, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
