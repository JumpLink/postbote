/**
 * The GJS half of the XMPP integration test: postbote's real XMPP client (xmpp.js on gjsify's
 * WebSocket / TLS) logs in to a local test server, and `syncChats` reads its archive into a
 * temporary index. Prints one `RESULT <json>` line for the Node orchestrator
 * (`xmpp-archive.mjs`), which runs the server and checks what arrived.
 *
 * Input (environment, never real accounts — the orchestrator creates throwaway ones):
 *   POSTBOTE_XMPP_IT = {"dataDir", "jid", "password", "service", "caFile", "add": boolean}
 */

import type { AccountPrompter } from '@postbote/protocol';
import {
  chatConversationId,
  getConversation,
  listConversations,
  migrate,
  openIndexDb,
  rebuildConversations,
  syncChats,
} from '@postbote/store';
import { XmppBackend } from '@postbote/xmpp';
import { join } from 'node:path';

interface Input {
  dataDir: string;
  jid: string;
  password: string;
  service: string;
  caFile: string | null;
  add: boolean;
}

const input = JSON.parse(process.env.POSTBOTE_XMPP_IT ?? '{}') as Input;

let ok = false;
try {
  const backend = new XmppBackend({
    settings: input.caFile ? { tlsCaFile: input.caFile } : {},
    env: {},
    secretsDir: join(input.dataDir, 'secrets', 'xmpp'),
  });
  if (input.add) {
    const answers = [input.jid, input.password, input.service];
    const prompter: AccountPrompter = {
      ask: async () => answers.shift() ?? '',
      notify: (message) => console.error(message),
    };
    await backend.addAccount(prompter);
  }
  const db = openIndexDb(join(input.dataDir, 'index.db'));
  migrate(db);
  const started = Date.now();
  const sync = await syncChats(db, backend);
  rebuildConversations(db);
  const [account] = await backend.listAccounts();
  const chats = listConversations(db).map((c) => {
    const shown = getConversation(db, c.id, { includeBodies: true });
    return {
      kind: c.kind,
      title: c.title,
      messages: (shown?.messages ?? []).map((m) => ({
        text: m.bodyText ?? null,
        fromSelf: m.fromSelf,
        edited: m.editedAt !== null && m.editedAt !== undefined,
        sender: m.senderName,
      })),
    };
  });
  db.close();
  console.log(
    `RESULT ${JSON.stringify({
      ms: Date.now() - started,
      added: sync.added,
      errors: sync.accounts.map((a) => a.error).filter((e) => e !== null),
      chatErrors: sync.accounts.reduce((n, a) => n + a.chatErrors, 0),
      fetched: sync.accounts.reduce((n, a) => n + a.chatsFetched, 0),
      account: account?.identity ?? null,
      direct: account ? chatConversationId('xmpp', account.id, 'bob@localhost') : null,
      chats,
    })}`,
  );
  ok = true;
} catch (err) {
  // GJS's `stack` carries no message line: print both.
  console.error(
    'xmpp integration FAILED:',
    err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : err,
  );
}
process.exit(ok ? 0 : 1);
