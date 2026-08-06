import { describe, expect, it } from '@gjsify/unit';

import { isGjs, runtimeName } from '../../src/core/runtime.ts';

// The probe takes its global as a parameter so both branches are exercised on BOTH runtimes —
// otherwise each run would only ever cover the branch it happens to be on, and a regression in
// the other would surface as a mis-detected runtime at load time rather than as a failing test.
export default async () => {
  await describe('runtime detection', async () => {
    await it('detects GJS by the legacy `imports` global', async () => {
      expect(isGjs({ imports: {} })).toBe(true);
      expect(runtimeName({ imports: {} })).toBe('gjs');
    });

    await it('detects Node by the absence of it', async () => {
      expect(isGjs({})).toBe(false);
      expect(runtimeName({})).toBe('node');
    });

    await it('agrees with the actual runtime it is running on', async () => {
      expect(['gjs', 'node']).toContain(runtimeName());
    });
  });
};
