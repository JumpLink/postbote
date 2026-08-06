import { describe, expect, it } from '@gjsify/unit';

import { applyReadOnlyGate } from '../../../src/frontends/mcp/runtime.ts';
import { createRecorder } from './recorder.ts';

// The gate is the one piece of this server that is load-bearing for safety, and its whole value
// is in the DIRECTION of the comparison. The obvious spelling — drop only when
// `readOnlyHint === false` — passes a "keeps read-only tools" test just as happily while failing
// open on every unannotated tool. So the case that actually matters is `omitted`.
export default async () => {
  await describe('applyReadOnlyGate (writes disallowed)', async () => {
    await it('registers a tool that proves it is read-only', async () => {
      const rec = createRecorder();
      applyReadOnlyGate(rec.server, false);
      rec.server.registerTool('read', { annotations: { readOnlyHint: true } } as never, (() => {}) as never);
      expect(rec.names()).toEqualArray(['read']);
    });

    await it('DROPS a tool with no annotation — fails closed', async () => {
      const rec = createRecorder();
      applyReadOnlyGate(rec.server, false);
      rec.server.registerTool('unannotated', {} as never, (() => {}) as never);
      rec.server.registerTool('empty-annotations', { annotations: {} } as never, (() => {}) as never);
      expect(rec.names()).toEqualArray([]);
    });

    await it('drops a tool that declares itself mutating', async () => {
      const rec = createRecorder();
      applyReadOnlyGate(rec.server, false);
      rec.server.registerTool(
        'write',
        { annotations: { readOnlyHint: false } } as never,
        (() => {}) as never,
      );
      expect(rec.names()).toEqualArray([]);
    });

    await it('keeps the read-only ones out of a mixed batch', async () => {
      const rec = createRecorder();
      applyReadOnlyGate(rec.server, false);
      rec.server.registerTool('a', { annotations: { readOnlyHint: true } } as never, (() => {}) as never);
      rec.server.registerTool('b', { annotations: { readOnlyHint: false } } as never, (() => {}) as never);
      rec.server.registerTool('c', {} as never, (() => {}) as never);
      rec.server.registerTool('d', { annotations: { readOnlyHint: true } } as never, (() => {}) as never);
      expect(rec.names()).toEqualArray(['a', 'd']);
    });

    await it('passes the config and handler through unchanged', async () => {
      const rec = createRecorder();
      applyReadOnlyGate(rec.server, false);
      rec.server.registerTool(
        'read',
        { title: 'Read', description: 'desc', annotations: { readOnlyHint: true } } as never,
        (() => {}) as never,
      );
      expect(rec.find('read')?.title).toBe('Read');
      expect(rec.find('read')?.description).toBe('desc');
    });
  });

  await describe('applyReadOnlyGate (writes allowed)', async () => {
    await it('leaves registration alone entirely', async () => {
      const rec = createRecorder();
      applyReadOnlyGate(rec.server, true);
      rec.server.registerTool(
        'write',
        { annotations: { readOnlyHint: false } } as never,
        (() => {}) as never,
      );
      rec.server.registerTool('unannotated', {} as never, (() => {}) as never);
      expect(rec.names()).toEqualArray(['write', 'unannotated']);
    });
  });
};
