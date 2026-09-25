/**
 * The GJS half of the Matrix E2EE integration test — driven by `matrix-e2ee.mjs`, never run on
 * its own. One step per invocation, because the other side (a plain matrix-js-sdk client on
 * Node) has to act between them:
 *
 *   login  — `postbote accounts add matrix` in code: password login, a new device, its keys
 *            uploaded, the crypto store saved into the account's secret file.
 *   sync   — a NEW process connects that account (crypto store restored from the file), runs
 *            `syncChats` into the index, and prints what the conversation view shows as JSON.
 *
 * Every value comes from the environment the driver sets; the accounts are throwaway users on a
 * homeserver in a local container.
 */

import { MatrixBackend } from '@postbote/matrix';
import {
  getConversation,
  listConversations,
  migrate,
  openIndexDb,
  rebuildConversations,
  syncChats,
} from '@postbote/store';

const env = process.env;
const step = env.MATRIX_E2EE_STEP;
const context = { settings: {}, env: {}, secretsDir: env.MATRIX_E2EE_SECRETS ?? '' };
const backend = new MatrixBackend(context);

async function login(): Promise<void> {
  const account = await backend.addAccount({
    ask: async (label) => {
      if (label.startsWith('Homeserver')) return env.MATRIX_E2EE_HS ?? '';
      if (label.startsWith('Matrix user')) return env.MATRIX_E2EE_USER ?? '';
      return env.MATRIX_E2EE_PASSWORD ?? '';
    },
    notify: () => {},
  });
  console.log(JSON.stringify({ step: 'login', account }));
}

async function sync(): Promise<void> {
  const db = openIndexDb(env.MATRIX_E2EE_INDEX ?? '');
  try {
    migrate(db);
    const result = await syncChats(db, backend, { fullScan: env.MATRIX_E2EE_FULL === '1' });
    rebuildConversations(db);
    const chats = listConversations(db).filter((c) => c.backend === 'matrix');
    const conversations = chats.map((c) => ({
      title: c.title,
      kind: c.kind,
      messages: (getConversation(db, c.id, { includeBodies: true })?.messages ?? []).map((m) => ({
        remoteId: m.ref.remoteId,
        fromSelf: m.fromSelf,
        sender: m.senderAddress?.value ?? null,
        text: m.bodyText ?? null,
        editedAt: m.editedAt ?? null,
      })),
    }));
    console.log(
      JSON.stringify({
        step: 'sync',
        added: result.added,
        removed: result.removed,
        errors: result.errors,
        error: result.accounts[0]?.error ?? null,
        conversations,
      }),
    );
  } finally {
    db.close();
  }
}

let ok = false;
try {
  if (step === 'login') await login();
  else if (step === 'sync') await sync();
  else throw new Error(`unknown step ${JSON.stringify(step)}`);
  ok = true;
} catch (err) {
  console.error(`matrix e2ee step ${step} FAILED:`, err instanceof Error ? (err.stack ?? err.message) : err);
}
process.exit(ok ? 0 : 1);
