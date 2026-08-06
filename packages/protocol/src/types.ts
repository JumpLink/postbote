import type { MailSearchCriteria } from './search-plan.ts';

/**
 * Plain-JS data shapes returned by the GNOME (GOA/EDS) binding.
 *
 * The binding NEVER returns GObject instances — every function maps the native
 * GI objects into these runtime-agnostic DTOs so the CLI actions and MCP tools
 * stay testable on Node (against the stub) and free of GI lifetime concerns.
 * Credentials (OAuth tokens, passwords) are never part of any DTO.
 */

/** Result of a connectivity / availability probe (same shape every CLI client uses). */
export interface GnomeCheckResult {
  name: string;
  ok: boolean;
  message: string;
}

/** Which data domains a GOA account exposes (interface present AND not disabled). */
export interface GnomeAccountCapabilities {
  mail: boolean;
  calendar: boolean;
  contacts: boolean;
  files: boolean;
}

/** A configured GNOME Online Account. No tokens/passwords — only host metadata. */
export interface GnomeAccount {
  /** GOA account id — the join key to EDS sources (ESourceGoa.account_id). */
  id: string;
  /** Provider type, e.g. "owncloud" (Nextcloud), "google", "ms_graph", "imap_smtp". */
  provider: string;
  /** Human-readable provider label. */
  providerName: string;
  /** Login/identity (often the e-mail address). */
  identity: string;
  /** Display name shown in GNOME Settings. */
  presentation: string;
  capabilities: GnomeAccountCapabilities;
  /** Available credential mechanisms (drives the future mail backend choice). */
  auth: { oauth2: boolean; password: boolean };
}

/** A contact projected from an EDS address book (vCard). */
export interface ContactDTO {
  uid: string;
  name: string;
  org: string | null;
  emails: string[];
  phones: string[];
}

/** A calendar event projected from an EDS calendar (iCalendar). */
export interface CalendarEventDTO {
  uid: string;
  summary: string | null;
  /** ISO-8601 with offset. */
  start: string;
  /** ISO-8601 with offset, or null. */
  end: string | null;
  allDay: boolean;
  location: string | null;
  /** Organizer e-mail (mailto: stripped), or null. */
  organizer: string | null;
  /** Attendee e-mails (mailto: stripped). */
  attendees: string[];
  recurring: boolean;
  /** Source uid of the calendar the event came from (provenance). */
  calendarUid: string;
}

/**
 * A connectable IMAP endpoint, resolved from a GOA account.
 *
 * The password is a THUNK, not a value: it is fetched from GOA at connect time and never
 * cached, logged, or carried in a DTO. Keeping it behind a call also keeps `Goa.Object` inside
 * @postbote/gnome — the IMAP layer consumes this interface and never imports the GOA typelib.
 */
export interface MailTarget {
  /** GOA account id — provenance, and the key callers pass back in. */
  accountId: string;
  host: string;
  port: number;
  user: string;
  /** TLS from the first byte (993). STARTTLS on 143 is not supported. */
  implicitTls: boolean;
  getPassword(): string;
}

/** A mail address as parsed from an IMAP ENVELOPE. */
export interface MailAddress {
  /** Display name (RFC 2047 decoded), or null. */
  name: string | null;
  /** "mailbox@host". */
  email: string;
}

/** Header/metadata summary of one message (no body — the privacy default). */
export interface MailSummaryDTO {
  /** IMAP UID (stable within folder + uidvalidity). */
  uid: string;
  /** Mailbox/folder the message lives in (e.g. "INBOX"). */
  folder: string;
  /** GOA account id the message came from (provenance + getMessage key). */
  accountId: string;
  subject: string | null;
  from: MailAddress[];
  to: MailAddress[];
  /** Message Date header as ISO-8601, or null. */
  date: string | null;
  /** \Seen flag. */
  seen: boolean;
  /** \Flagged flag. */
  flagged: boolean;
  /** RFC822 size in bytes, or null. */
  size: number | null;
}

/** Attachment metadata only — never the attachment bytes. */
export interface MailAttachmentDTO {
  filename: string | null;
  mimeType: string;
  /** Approximate decoded size in bytes. */
  size: number;
}

/** A single fetched message: summary + cc + plain-text body + attachment list. */
export interface MailMessageDTO extends MailSummaryDTO {
  cc: MailAddress[];
  messageId: string | null;
  /** Plain-text body (text/plain preferred, else stripped HTML); may be null. */
  bodyText: string | null;
  /** True if the body was truncated to the caller's cap. */
  bodyTruncated: boolean;
  attachments: MailAttachmentDTO[];
}

export interface SearchMailOptions extends MailSearchCriteria {
  /** Restrict to one GOA mail account id; omit to search all mail accounts. */
  accountId?: string;
  /**
   * Mailbox to search. Accepts a wire name, a display name, a role (`sent`) or a path leaf.
   * Ignored when `allFolders` is set. Defaults to INBOX.
   */
  folder?: string;
  /** Search every searchable mailbox instead of one (excludes All Mail, Trash and Junk). */
  allFolders?: boolean;
  /** Cap the number of returned summaries. */
  limit?: number;
}

/** One mailbox as reported to a caller, with the account it belongs to. */
export interface FolderDTO {
  accountId: string;
  /** Wire name (modified UTF-7) — pass this back as `folder` for an exact match. */
  path: string;
  /** Decoded display name. */
  name: string;
  delimiter: string | null;
  selectable: boolean;
  role: string | null;
  /** Where the role came from: `special-use`, `heuristic`, `name`, or null. */
  roleSource: string | null;
  /** Message count, when it was cheap to obtain. */
  messages: number | null;
}

/** One fetchable part of a message, as reported by `mail_list_parts`. */
export interface MailPartDTO {
  /** IMAP section — pass this to save the part. */
  section: string;
  mimeType: string;
  filename: string | null;
  disposition: string | null;
  /** Encoded size in octets, i.e. what a transfer actually costs. */
  size: number;
  /** True if this is what a user would call an attachment. */
  attachment: boolean;
}

export interface ListPartsOptions {
  accountId: string;
  uid: string;
  folder?: string;
}

export interface FetchPartOptions {
  accountId: string;
  uid: string;
  folder?: string;
  /** IMAP section, from `listParts`. Omit to take the first attachment. */
  section?: string;
  /** Refuse anything larger, before any bytes move. */
  maxBytes: number;
}

/** Part metadata a caller gets BEFORE the bytes, so it can name the file from real data. */
export interface FetchPartInfo {
  section: string;
  mimeType: string;
  filename: string | null;
  /** Encoded octets, as declared by BODYSTRUCTURE. */
  size: number;
  /** Content-Transfer-Encoding, uppercased — what the bytes must be decoded from. */
  encoding: string;
}

/** Result of writing one attachment to disk. */
export interface SaveAttachmentResult {
  path: string;
  filename: string;
  bytes: number;
  mimeType: string;
  section: string;
}

export interface GetMessageOptions {
  /** GOA mail account id (required — identifies the IMAP server). */
  accountId: string;
  /** Mailbox the UID belongs to (default "INBOX"). */
  folder?: string;
  /** IMAP UID of the message to fetch. */
  uid: string;
  /** Max body characters to return (the rest is dropped, bodyTruncated=true). */
  maxBodyChars?: number;
}

export interface SearchContactsOptions {
  /** Free-text query (any field contains). Empty → all contacts (subject to limit). */
  query?: string;
  /** Cap the number of returned contacts. */
  limit?: number;
  /** Restrict to address books linked to this GOA account id. */
  accountId?: string;
}

export interface ListEventsOptions {
  /** Window start, ISO-8601 (or YYYY-MM-DD). */
  from: string;
  /** Window end, ISO-8601 (or YYYY-MM-DD). */
  to: string;
  /** Restrict to a single calendar source uid. */
  calendarUid?: string;
  /** Restrict to calendars linked to this GOA account id. */
  accountId?: string;
  /** Expand recurring events into instances within the window (default true). */
  expandRecurring?: boolean;
  /** Cap the number of returned events. */
  limit?: number;
}
