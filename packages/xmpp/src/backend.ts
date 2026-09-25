/**
 * The XMPP backend — a `chat` driver behind the same port as every other backend, loaded only
 * through the registry.
 */

import type {
  AccountPrompter,
  BackendAccount,
  BackendContext,
  ChatBackend,
  ChatSession,
} from '@postbote/protocol';
import { caFileSetting, listAccounts, readLogin, refuseConfigSecrets } from './accounts.ts';
import type { LoginPrompts } from './api.ts';
import { requireArchive } from './archive.ts';
import { type ClientFactory, createXmppClient } from './client.ts';
import { loginXmpp } from './login.ts';
import { XMPP_MANIFEST } from './manifest.ts';
import { XmppChatSession } from './session.ts';

/** The login questions, asked through whatever frontend is running. */
export function xmppPrompts(prompter: AccountPrompter): LoginPrompts {
  return {
    jid: () => prompter.ask('XMPP address (name@example.org)'),
    password: () => prompter.ask('Password', { secret: true }),
    service: () =>
      prompter.ask('Server address — empty to discover it (e.g. xmpps://xmpp.example.org:5223, wss://…)'),
    notify: (message) => prompter.notify(message),
  };
}

export class XmppBackend implements ChatBackend {
  readonly manifest = XMPP_MANIFEST;
  readonly kind = 'chat' as const;
  private readonly context: BackendContext;
  private readonly createClient: ClientFactory;

  constructor(context: BackendContext, createClient: ClientFactory = createXmppClient) {
    this.context = context;
    this.createClient = createClient;
  }

  async listAccounts(): Promise<BackendAccount[]> {
    return listAccounts(this.context.secretsDir);
  }

  addAccount(prompter: AccountPrompter): Promise<BackendAccount> {
    return loginXmpp(this.context, xmppPrompts(prompter), this.createClient);
  }

  async connect(accountId: string): Promise<ChatSession> {
    refuseConfigSecrets(this.context.settings);
    const login = readLogin(this.context.secretsDir, accountId);
    const api = await this.createClient({ login, caFile: caFileSetting(this.context.settings) });
    try {
      await requireArchive(api);
    } catch (err) {
      await api.close().catch(() => {});
      throw err;
    }
    return new XmppChatSession(api);
  }
}
