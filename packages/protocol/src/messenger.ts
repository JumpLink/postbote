/**
 * The network-neutral side of the plugin API (ADR 0001, sections 1–5).
 *
 * Everything here describes a backend WITHOUT naming a network: what it can do (capabilities),
 * how its history survives (sync model), who takes part (participants with typed addresses) and
 * how a message wants to be shown (presentation kind). CLI, MCP and a later GUI read these
 * fields and hide what a backend cannot do, instead of branching on `backend === 'signal'`.
 *
 * Pure: no `gi://`, no `node:*`. The runtime port a backend implements is in `backend.ts`.
 */

/**
 * Version of the plugin API a backend was written against.
 *
 * Bumped on a breaking change to the port or the manifest. The registry refuses a backend whose
 * manifest names another version — loading it anyway would fail somewhere far from the cause.
 */
export const PLUGIN_API_VERSION = 1;

/** How a backend's history survives. The sync engine branches on this, never on the network. */
export type SyncModel =
  /** The server keeps the archive (IMAP, Telegram, Matrix, XMPP with MAM): the index is rebuildable. */
  | 'server-archive'
  /** Messages are gone from the server once delivered (Signal, WhatsApp): the local store is the only copy. */
  | 'delivery-only';

export const SYNC_MODELS: readonly SyncModel[] = ['server-archive', 'delivery-only'];

/**
 * The backup tier the message store takes under a sync model, in werkstatt's state-manifest
 * vocabulary: a server-archive index can be rebuilt (`derived`), a delivery-only store cannot
 * (`state`). Crypto stores of native backends are `secret` and are declared separately.
 */
export function storeTierFor(model: SyncModel): 'derived' | 'state' {
  return model === 'server-archive' ? 'derived' : 'state';
}

/** What a backend can do. Every field is a promise the frontends rely on to show or hide a feature. */
export interface BackendCapabilities {
  edits: boolean;
  reactions: boolean;
  threads: boolean;
  readReceipts: boolean;
  groups: boolean;
  e2ee: boolean;
  /** Messages carry a subject line (mail). */
  subject: boolean;
  /** Messages live in server-side folders (mail). */
  folders: boolean;
  attachments: boolean;
}

export const CAPABILITY_NAMES: ReadonlyArray<keyof BackendCapabilities> = [
  'edits',
  'reactions',
  'threads',
  'readReceipts',
  'groups',
  'e2ee',
  'subject',
  'folders',
  'attachments',
];

/** The kinds of address a participant can be reached at. */
export type AddressKind = 'email' | 'phone' | 'telegram' | 'matrix' | 'jid';

export const ADDRESS_KINDS: readonly AddressKind[] = ['email', 'phone', 'telegram', 'matrix', 'jid'];

/** One typed address. `value` is always in the canonical form `normalizeAddress` produces. */
export interface ParticipantAddress {
  kind: AddressKind;
  value: string;
}

/**
 * Bring an address into the one form it is compared and stored in, or return null when the
 * value is not an address of that kind at all.
 *
 * Deliberately conservative: it folds what the network itself treats as equal (case of a mail
 * domain, spacing in a phone number, the `@` of a Telegram handle, the resource of a JID) and
 * nothing more. Two addresses that normalize differently are two addresses.
 */
export function normalizeAddress(kind: AddressKind, raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  switch (kind) {
    case 'email': {
      const bare = value.replace(/^mailto:/i, '').replace(/^<|>$/g, '');
      const at = bare.lastIndexOf('@');
      if (at <= 0 || at === bare.length - 1 || /\s/.test(bare)) return null;
      // The local part is case-sensitive by RFC and case-insensitive in practice; every mail
      // provider a person uses folds it, and treating `Anna@` and `anna@` as two people is the
      // worse error for a per-person view.
      return bare.toLowerCase();
    }
    case 'phone': {
      const digits = value.replace(/^tel:/i, '').replace(/[\s\-./()]/g, '');
      const international = digits.startsWith('00') ? `+${digits.slice(2)}` : digits;
      return /^\+?\d{3,}$/.test(international) ? international : null;
    }
    case 'telegram': {
      const handle = value.replace(/^@/, '');
      // Telegram usernames: 5–32 of [A-Za-z0-9_], case-insensitive. A numeric user id is also
      // accepted, since a contact without a username is only reachable by id.
      if (/^\d+$/.test(handle)) return handle;
      return /^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(handle) ? handle.toLowerCase() : null;
    }
    case 'matrix': {
      // @localpart:server — the server name is case-insensitive (it is a host), the localpart
      // is lowercase by spec for every user id issued since v1.
      const m = /^@([^:\s]+):(\S+)$/.exec(value);
      return m ? `@${m[1].toLowerCase()}:${m[2].toLowerCase()}` : null;
    }
    case 'jid': {
      // A participant is a bare JID; the resource names one of their devices, not them.
      const bare = value.replace(/^xmpp:/i, '').split('/')[0];
      const at = bare.indexOf('@');
      if (at <= 0 || at === bare.length - 1 || /\s/.test(bare)) return null;
      return bare.toLowerCase();
    }
  }
}

/** A person (or a group identity) taking part in a conversation. */
export interface Participant {
  /** Stable id within the local store. */
  id: string;
  displayName: string | null;
  /** Every known address of this person, across networks. */
  addresses: ParticipantAddress[];
  /** The EDS contact this participant is linked to, if any. */
  contactUid: string | null;
}

/** How a message wants to be shown: a chat bubble, or a document card (mail, invoice, newsletter). */
export type PresentationKind = 'bubble' | 'document';

/**
 * Whether a conversation is between people or sent by a machine (ADR 0001 §1).
 * Conversational mail joins the conversation list; automated mail stays in the mailbox view.
 */
export type Classification = 'conversational' | 'automated';

/** Why a message was classified the way it was — surfaced so a wrong call is easy to correct. */
export type ClassificationReason =
  /** The user set this sender explicitly. */
  | 'override'
  /** The user wrote in this thread. */
  | 'replied'
  /** The sender is in the address book. */
  | 'known-contact'
  /** List-Id, List-Unsubscribe, Auto-Submitted or Precedence marked it as bulk or machine mail. */
  | 'automated-header'
  /** A no-reply, bounce or notification address. */
  | 'no-reply-sender'
  /** Nobody known, no reply yet — held back until the user replies or adds the sender. */
  | 'unknown-sender'
  /** Written by the user. */
  | 'self';

/** A conversation — a mail thread, a chat, a group — as every frontend sees it. */
export interface Conversation {
  id: string;
  /** Backend name from the manifest, e.g. `mail`. */
  backend: string;
  accountId: string;
  kind: 'direct' | 'group';
  title: string | null;
  /** The other participants — the user is not listed. */
  participants: Participant[];
  classification: Classification;
  classificationReason: ClassificationReason;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
  messageCount: number;
  unreadCount: number;
  hasAttachments: boolean;
}

/**
 * Where a message lives in its backend, so a caller can fetch it in full through the
 * backend-specific tool (for mail: `mail_get_message` with account, folder and uid).
 */
export interface MessageRef {
  accountId: string;
  folder?: string;
  uid?: number;
}

/** One message inside a conversation. No body unless the caller asked for one. */
export interface ConversationMessage {
  id: string;
  conversationId: string;
  backend: string;
  presentation: PresentationKind;
  /** The sender's participant id, or null when it is the user. */
  senderId: string | null;
  senderName: string | null;
  senderAddress: ParticipantAddress | null;
  fromSelf: boolean;
  sentAt: string | null;
  subject: string | null;
  seen: boolean;
  hasAttachments: boolean;
  classification: Classification;
  classificationReason: ClassificationReason;
  ref: MessageRef;
  /** Plain-text body — present only when explicitly requested. */
  bodyText?: string | null;
  bodyTruncated?: boolean;
}

/** The terms a user must see before a backend is enabled for the first time. */
export interface TermsNotice {
  /** One paragraph, shown verbatim. States the risk plainly (e.g. an unofficial protocol). */
  summary: string;
  /** Where the network's own terms are. */
  url?: string;
}

/** What a backend declares about itself — readable without constructing it. */
export interface BackendManifest {
  /** Registry key and config key: lowercase, `[a-z][a-z0-9-]*`. */
  name: string;
  displayName: string;
  /** The PLUGIN_API_VERSION it was built against. */
  pluginApi: number;
  capabilities: BackendCapabilities;
  syncModel: SyncModel;
  /** True when it carries a native addon (per-platform prebuilds). */
  native: boolean;
  /** The address kinds its participants are identified by. */
  addressKinds: AddressKind[];
  /** Shown on first enable. Null when there is nothing beyond the provider's usual terms. */
  terms: TermsNotice | null;
}

/**
 * Check a manifest before the registry accepts it. Returns every problem, not the first —
 * a plugin author fixing one error at a time against a registry is a slow loop.
 */
export function validateManifest(manifest: BackendManifest): string[] {
  const problems: string[] = [];
  if (!/^[a-z][a-z0-9-]*$/.test(manifest.name ?? '')) {
    problems.push(`name must match [a-z][a-z0-9-]*, got ${JSON.stringify(manifest.name)}`);
  }
  if (!manifest.displayName?.trim()) problems.push('displayName is empty');
  if (manifest.pluginApi !== PLUGIN_API_VERSION) {
    problems.push(`built for plugin API ${manifest.pluginApi}, this postbote speaks ${PLUGIN_API_VERSION}`);
  }
  if (!SYNC_MODELS.includes(manifest.syncModel)) {
    problems.push(`unknown sync model ${JSON.stringify(manifest.syncModel)}`);
  }
  for (const name of CAPABILITY_NAMES) {
    if (typeof manifest.capabilities?.[name] !== 'boolean')
      problems.push(`capability ${name} is not declared`);
  }
  if (!Array.isArray(manifest.addressKinds) || manifest.addressKinds.length === 0) {
    problems.push('addressKinds is empty — participants would be unaddressable');
  } else {
    for (const kind of manifest.addressKinds) {
      if (!ADDRESS_KINDS.includes(kind)) problems.push(`unknown address kind ${JSON.stringify(kind)}`);
    }
  }
  if (manifest.terms !== null && !manifest.terms?.summary?.trim()) {
    problems.push('terms is set but has no summary — pass null when there is nothing to show');
  }
  return problems;
}
