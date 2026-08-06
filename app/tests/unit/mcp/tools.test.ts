import { describe, expect, it } from '@gjsify/unit';

import {
  ATTACHMENT_BYTES,
  BODY_CHARS,
  CONTACT_LIMIT,
  EVENT_LIMIT,
  type LimitSpec,
  MAIL_LIMIT,
} from '../../../src/core/actions/index.ts';
import { registerAccountsTools } from '../../../src/frontends/mcp/tools/accounts.ts';
import { registerCalendarTools } from '../../../src/frontends/mcp/tools/calendar.ts';
import { registerContactsTools } from '../../../src/frontends/mcp/tools/contacts.ts';
import { registerIndexTools } from '../../../src/frontends/mcp/tools/index-sync.ts';
import { registerMailTools } from '../../../src/frontends/mcp/tools/mail.ts';
import { createRecorder, type Recorder } from './recorder.ts';

function registerAll(): Recorder {
  const rec = createRecorder();
  registerMailTools(rec.server);
  registerIndexTools(rec.server);
  registerContactsTools(rec.server);
  registerCalendarTools(rec.server);
  registerAccountsTools(rec.server);
  return rec;
}

/**
 * Every numeric field whose schema bound must agree with the action's cap. This is the drift
 * `limits.ts` exists to prevent: the schema and the clamp are written in different files, and a
 * schema stricter than the action rejects a request the action would happily have served.
 */
const BOUNDED: Array<{ tool: string; field: string; spec: LimitSpec }> = [
  { tool: 'mail_search', field: 'limit', spec: MAIL_LIMIT },
  { tool: 'mail_get_message', field: 'max_body_chars', spec: BODY_CHARS },
  { tool: 'contacts_search', field: 'limit', spec: CONTACT_LIMIT },
  { tool: 'calendar_list_events', field: 'limit', spec: EVENT_LIMIT },
  { tool: 'mail_save_attachment', field: 'max_bytes', spec: ATTACHMENT_BYTES },
  { tool: 'mail_search_local', field: 'limit', spec: MAIL_LIMIT },
];

export default async () => {
  await describe('MCP tool catalogue', async () => {
    const rec = registerAll();

    await it('registers exactly the agreed tool names', async () => {
      // Pinned deliberately: these names are the contract with MCP clients, so a rename is a
      // breaking change that has to edit this line rather than slip through.
      expect([...rec.names()].sort()).toEqualArray([
        'accounts_list',
        'calendar_list_events',
        'contacts_search',
        'mail_get_message',
        'mail_list_folders',
        'mail_list_parts',
        'mail_save_attachment',
        'mail_search',
        'mail_search_local',
        'mail_sync_status',
      ]);
    });

    for (const tool of rec.tools) {
      // Not a style check: applyReadOnlyGate DROPS anything that fails this, so a tool added
      // without the annotation would vanish from tools/list with no other symptom.
      await it(`${tool.name} declares itself read-only`, async () => {
        expect(tool.annotations?.readOnlyHint).toBe(true);
      });

      await it(`${tool.name} carries a title and a real description`, async () => {
        expect((tool.title ?? '').length).toBeGreaterThan(0);
        // The description is all a model reads before choosing a tool; a stub is a bug.
        expect((tool.description ?? '').length).toBeGreaterThan(40);
      });
    }
  });

  await describe('MCP input schema bounds', async () => {
    const rec = registerAll();

    for (const { tool, field, spec } of BOUNDED) {
      await it(`${tool}.${field} accepts exactly what the action caps allow`, async () => {
        const schema = rec.find(tool)?.inputSchema?.[field];
        expect(schema).toBeDefined();
        if (!schema) return;
        expect(schema.safeParse(spec.max).success).toBe(true);
        expect(schema.safeParse(spec.default).success).toBe(true);
        expect(schema.safeParse(spec.max + 1).success).toBe(false);
        // Omitted is always allowed — that is what makes the action's default reachable.
        expect(schema.safeParse(undefined).success).toBe(true);
      });

      await it(`${tool}.${field} rejects the values capLimit has to clamp`, async () => {
        const schema = rec.find(tool)?.inputSchema?.[field];
        if (!schema) return;
        for (const bad of [0, -1, 2.5]) expect(schema.safeParse(bad).success).toBe(false);
      });
    }

    await it('mail_get_message requires account_id and uid', async () => {
      // They identify the server and the message; without them the fetch cannot be scoped at
      // all, so they are required rather than defaulted to something surprising.
      const schema = registerAll().find('mail_get_message')?.inputSchema;
      expect(schema?.account_id.safeParse(undefined).success).toBe(false);
      expect(schema?.uid.safeParse(undefined).success).toBe(false);
      expect(schema?.folder.safeParse(undefined).success).toBe(true);
    });
  });
};
