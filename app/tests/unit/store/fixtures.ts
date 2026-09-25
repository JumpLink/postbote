import type {
  BackendFlagState,
  BackendMessage,
  BackendSession,
  FolderInfo,
  MailBackend,
} from '@postbote/protocol';
import { MAIL_MANIFEST } from '@postbote/imap';
import { migrate, openIndexDb } from '@postbote/store';

/**
 * Shared fixtures for the store suites: a scriptable fake mail server behind the `MailBackend`
 * port, and an in-memory index. This pair is why the port exists — the sync engine and the
 * conversation builder run on Node with no network, no GOA and no mailbox.
 *
 * All fixture content is synthetic.
 */

export function folder(path: string, name = path, role: string | null = null): FolderInfo {
  return {
    path,
    name,
    delimiter: '/',
    attributes: [],
    selectable: true,
    role: role as never,
    roleSource: null,
  };
}

export function message(
  uid: number,
  subject: string,
  body = 'body text',
  extra: Partial<BackendMessage> = {},
): BackendMessage {
  return {
    uid,
    messageId: `<${uid}@example.org>`,
    subject,
    sender: 'Someone <someone@example.org>',
    recipients: 'me@example.com',
    date: `2026-0${((uid % 9) + 1).toString()}-01T10:00:00.000Z`,
    internalDate: `2026-0${((uid % 9) + 1).toString()}-01T10:00:05.000Z`,
    size: 1000 + uid,
    seen: false,
    flagged: false,
    hasAttachment: false,
    attachments: [],
    bodyText: body,
    from: [{ name: 'Someone', email: 'someone@example.org' }],
    to: [{ name: null, email: 'me@example.com' }],
    cc: [],
    inReplyTo: null,
    references: [],
    automation: { listId: null, listUnsubscribe: null, autoSubmitted: null, precedence: null },
    ...extra,
  };
}

/** A scriptable in-memory IMAP server. */
export class FakeBackend implements MailBackend {
  readonly manifest = MAIL_MANIFEST;
  readonly kind = 'mailbox' as const;
  folders: FolderInfo[] = [folder('INBOX', 'INBOX', 'inbox')];
  messages = new Map<string, BackendMessage[]>();
  uidValidity = 1;
  uidNext = 1;
  /** Counts round trips so the no-op path can be proven to skip work. */
  opened = 0;
  flagScans = 0;
  closed = 0;

  put(path: string, msgs: BackendMessage[]): void {
    this.messages.set(path, msgs);
    this.uidNext = Math.max(this.uidNext, ...msgs.map((m) => m.uid + 1));
  }

  async listAccounts() {
    return [{ id: 'acct', identity: 'me@example.com', provider: 'imap_smtp' }];
  }

  connect = async (): Promise<BackendSession> => ({
    listFolders: async () => this.folders,
    openFolder: async (path: string) => {
      this.opened++;
      return {
        uidValidity: this.uidValidity,
        uidNext: this.uidNext,
        exists: (this.messages.get(path) ?? []).length,
      };
    },
    fetchNewer: async (path: string, afterUid: number, batchSize: number) =>
      (this.messages.get(path) ?? []).filter((m) => m.uid > afterUid).slice(0, batchSize),
    listFlags: async (path: string): Promise<BackendFlagState[]> => {
      this.flagScans++;
      return (this.messages.get(path) ?? []).map((m) => ({
        uid: m.uid,
        seen: m.seen,
        flagged: m.flagged,
      }));
    },
    close: async () => {
      this.closed++;
    },
  });
}

export function freshDb() {
  const db = openIndexDb(':memory:');
  migrate(db);
  return db;
}

export const AT = (iso: string) => () => new Date(iso);
