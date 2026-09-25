/**
 * Conversational or automated — the split that decides whether a mail joins the conversation
 * list or stays in the mailbox view (ADR 0001 §1).
 *
 * Pure, so the rules are pinned by tests rather than by a database. The order of the checks IS
 * the policy, and each step names its reason, so a wrong call can be traced to the one rule that
 * made it and corrected per sender (`conversations classify`).
 */

import type { AutomationHeaders, Classification, ClassificationReason } from '@postbote/protocol';

export interface MailClassificationInput {
  /** The user wrote this message. */
  fromSelf: boolean;
  /** Normalized sender address, or null when the message had no usable From. */
  senderAddress: string | null;
  automation: AutomationHeaders;
  /** The sender is in the address book. */
  knownContact: boolean;
  /** The user wrote at least one message in this thread. */
  repliedInThread: boolean;
}

export interface ClassificationResult {
  classification: Classification;
  reason: ClassificationReason;
}

/** Precedence values that mean "not a person writing to you" (RFC 2076, RFC 3834 §5). */
const BULK_PRECEDENCE = new Set(['bulk', 'list', 'junk', 'auto_reply']);

/**
 * Local parts that nobody reads. Anchored on the whole local part (plus a `+tag`, `-suffix` or
 * `.suffix`), so `noreply@` and `no-reply+abc@` match while `noreplyanna@` does not.
 */
const NO_REPLY_LOCAL =
  /^(no-?reply|do-?not-?reply|mailer-daemon|postmaster|bounces?|notifications?)([+.\-_].*)?$/i;

/** True for a sender address nobody reads. */
export function isNoReplyAddress(address: string | null): boolean {
  if (!address) return false;
  const at = address.lastIndexOf('@');
  const local = at > 0 ? address.slice(0, at) : address;
  return NO_REPLY_LOCAL.test(local);
}

/** True when the headers mark the message as list, bulk or machine-generated mail. */
export function hasAutomationHeader(headers: AutomationHeaders): boolean {
  if (headers.listId || headers.listUnsubscribe) return true;
  // RFC 3834: `Auto-Submitted: no` is the explicit statement that a human sent it.
  if (headers.autoSubmitted && headers.autoSubmitted.trim().toLowerCase() !== 'no') return true;
  if (headers.precedence && BULK_PRECEDENCE.has(headers.precedence.trim().toLowerCase())) return true;
  return false;
}

/**
 * Classify one mail.
 *
 * A reply by the user outranks every automated marker: a mailing-list thread the user writes in
 * IS a conversation. Automated markers outrank a known contact: the shop in the address book
 * still sends its newsletter with `List-Unsubscribe`. And a stranger with no marker at all is
 * held back as `unknown-sender` until the user replies or adds them — the list of people stays
 * people, and one `classify` call corrects a sender for good.
 */
export function classifyMail(input: MailClassificationInput): ClassificationResult {
  if (input.fromSelf) return { classification: 'conversational', reason: 'self' };
  if (input.repliedInThread) return { classification: 'conversational', reason: 'replied' };
  if (hasAutomationHeader(input.automation))
    return { classification: 'automated', reason: 'automated-header' };
  if (isNoReplyAddress(input.senderAddress))
    return { classification: 'automated', reason: 'no-reply-sender' };
  if (input.knownContact) return { classification: 'conversational', reason: 'known-contact' };
  return { classification: 'automated', reason: 'unknown-sender' };
}

/** One message's stored verdict, as a conversation summary is derived from it. */
export interface MessageVerdict {
  fromSelf: boolean;
  senderAddress: string | null;
  classification: Classification;
  reason: ClassificationReason;
}

/** Explicit per-sender decisions, keyed by normalized address. */
export type SenderOverrides = Readonly<Record<string, Classification>>;

const CONVERSATIONAL_RANK: ClassificationReason[] = ['override', 'replied', 'known-contact', 'chat-member'];
const AUTOMATED_RANK: ClassificationReason[] = [
  'override',
  'automated-header',
  'no-reply-sender',
  'broadcast',
  'bot',
  'unknown-sender',
];

/**
 * The verdict for a whole conversation, with the user's per-sender overrides applied.
 *
 * Conversational when ANY message from someone else is — one real person in a thread makes it a
 * conversation. A thread with only the user's own messages (sent, no answer yet) is theirs, so
 * conversational too. The reason reported is the strongest one found, so `override` shows
 * through whenever an override decided the outcome.
 */
export function conversationVerdict(
  messages: readonly MessageVerdict[],
  overrides: SenderOverrides = {},
): ClassificationResult {
  const others = messages.filter((m) => !m.fromSelf);
  if (others.length === 0) return { classification: 'conversational', reason: 'self' };

  const effective = others.map((m) => {
    const forced = m.senderAddress ? overrides[m.senderAddress] : undefined;
    return forced
      ? { classification: forced, reason: 'override' as ClassificationReason }
      : { classification: m.classification, reason: m.reason };
  });

  const conversational = effective.filter((e) => e.classification === 'conversational');
  if (conversational.length > 0) {
    return { classification: 'conversational', reason: strongest(conversational, CONVERSATIONAL_RANK) };
  }
  return { classification: 'automated', reason: strongest(effective, AUTOMATED_RANK) };
}

function strongest(results: ClassificationResult[], rank: ClassificationReason[]): ClassificationReason {
  let best = results[0].reason;
  let bestIndex = rank.indexOf(best);
  for (const r of results) {
    const index = rank.indexOf(r.reason);
    if (index !== -1 && (bestIndex === -1 || index < bestIndex)) {
      best = r.reason;
      bestIndex = index;
    }
  }
  return best;
}
