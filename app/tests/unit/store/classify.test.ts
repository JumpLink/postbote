import { describe, expect, it } from '@gjsify/unit';

import type { AutomationHeaders } from '@postbote/protocol';
import {
  classifyMail,
  conversationVerdict,
  hasAutomationHeader,
  isNoReplyAddress,
  type MailClassificationInput,
  type MessageVerdict,
} from '@postbote/store';

// The classification policy, pinned rule by rule. Synthetic addresses only.

const NONE: AutomationHeaders = {
  listId: null,
  listUnsubscribe: null,
  autoSubmitted: null,
  precedence: null,
};

function input(overrides: Partial<MailClassificationInput> = {}): MailClassificationInput {
  return {
    fromSelf: false,
    senderAddress: 'anna@example.org',
    automation: NONE,
    knownContact: false,
    repliedInThread: false,
    ...overrides,
  };
}

function verdict(overrides: Partial<MessageVerdict> = {}): MessageVerdict {
  return {
    fromSelf: false,
    senderAddress: 'anna@example.org',
    classification: 'conversational',
    reason: 'known-contact',
    ...overrides,
  };
}

export default async () => {
  await describe('hasAutomationHeader', async () => {
    await it('fires on each list, bulk and auto-submitted marker', async () => {
      expect(hasAutomationHeader({ ...NONE, listId: '<list.example.org>' })).toBe(true);
      expect(hasAutomationHeader({ ...NONE, listUnsubscribe: '<mailto:u@example.org>' })).toBe(true);
      expect(hasAutomationHeader({ ...NONE, autoSubmitted: 'auto-generated' })).toBe(true);
      expect(hasAutomationHeader({ ...NONE, precedence: 'Bulk' })).toBe(true);
      expect(hasAutomationHeader({ ...NONE, precedence: 'junk' })).toBe(true);
    });

    await it('treats `Auto-Submitted: no` as the human statement it is (RFC 3834)', async () => {
      expect(hasAutomationHeader({ ...NONE, autoSubmitted: 'no' })).toBe(false);
      expect(hasAutomationHeader({ ...NONE, precedence: 'first-class' })).toBe(false);
      expect(hasAutomationHeader(NONE)).toBe(false);
    });
  });

  await describe('isNoReplyAddress', async () => {
    await it('matches the whole local part, with tags and suffixes', async () => {
      for (const a of [
        'noreply@x.org',
        'no-reply@x.org',
        'do-not-reply@x.org',
        'no-reply+abc@x.org',
        'bounce-123@x.org',
        'MAILER-DAEMON@x.org',
        'notifications@x.org',
      ]) {
        expect(isNoReplyAddress(a)).toBe(true);
      }
    });

    await it('does not match a person whose name merely starts that way', async () => {
      expect(isNoReplyAddress('noreplyanna@x.org')).toBe(false);
      expect(isNoReplyAddress('anna@noreply.example.org')).toBe(false);
      expect(isNoReplyAddress(null)).toBe(false);
    });
  });

  await describe('classifyMail — the order of the rules is the policy', async () => {
    await it('the user own message is conversational (self)', async () => {
      expect(classifyMail(input({ fromSelf: true, automation: { ...NONE, listId: 'x' } })).reason).toBe(
        'self',
      );
    });

    await it('a reply by the user outranks every automated marker', async () => {
      const r = classifyMail(
        input({ repliedInThread: true, automation: { ...NONE, listId: '<l.example.org>' } }),
      );
      expect(r.classification).toBe('conversational');
      expect(r.reason).toBe('replied');
    });

    await it('an automated marker outranks a known contact', async () => {
      const r = classifyMail(input({ knownContact: true, automation: { ...NONE, listUnsubscribe: '<x>' } }));
      expect(r.classification).toBe('automated');
      expect(r.reason).toBe('automated-header');
    });

    await it('a no-reply sender is automated even without headers', async () => {
      expect(classifyMail(input({ senderAddress: 'noreply@shop.example' })).reason).toBe('no-reply-sender');
    });

    await it('a known contact without markers is conversational', async () => {
      const r = classifyMail(input({ knownContact: true }));
      expect(r.classification).toBe('conversational');
      expect(r.reason).toBe('known-contact');
    });

    await it('a stranger without markers is held back as unknown-sender', async () => {
      const r = classifyMail(input());
      expect(r.classification).toBe('automated');
      expect(r.reason).toBe('unknown-sender');
    });
  });

  await describe('conversationVerdict', async () => {
    await it('is conversational when any message from someone else is', async () => {
      const r = conversationVerdict([
        verdict({ senderAddress: 'news@x.org', classification: 'automated', reason: 'automated-header' }),
        verdict(),
      ]);
      expect(r.classification).toBe('conversational');
      expect(r.reason).toBe('known-contact');
    });

    await it('is conversational when only the user wrote in it', async () => {
      const r = conversationVerdict([verdict({ fromSelf: true, reason: 'self' })]);
      expect(r.classification).toBe('conversational');
      expect(r.reason).toBe('self');
    });

    await it('reports the strongest automated reason', async () => {
      const r = conversationVerdict([
        verdict({ classification: 'automated', reason: 'unknown-sender' }),
        verdict({ senderAddress: 'n@x.org', classification: 'automated', reason: 'automated-header' }),
      ]);
      expect(r.classification).toBe('automated');
      expect(r.reason).toBe('automated-header');
    });

    await it('applies a per-sender override in both directions', async () => {
      const stranger = verdict({ classification: 'automated', reason: 'unknown-sender' });
      const up = conversationVerdict([stranger], { 'anna@example.org': 'conversational' });
      expect(up.classification).toBe('conversational');
      expect(up.reason).toBe('override');

      const down = conversationVerdict([verdict({ reason: 'replied' })], { 'anna@example.org': 'automated' });
      expect(down.classification).toBe('automated');
      expect(down.reason).toBe('override');
    });
  });
};
