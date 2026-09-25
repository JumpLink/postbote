/**
 * libsignal, loaded on demand.
 *
 * `@signalapp/libsignal-client` is Rust behind N-API: loading it maps a native library into the
 * process. postbote's CLI bundle carries every backend, so a static import would load the addon
 * on every start — and fail every start on a platform without a prebuild, Signal enabled or not.
 * So nothing in this package imports it at module level: the backend loads it the first time it
 * is used, and hands it to the code that needs it (`SignalLib`). A test passes the module in.
 */

import type * as Core from '@signalapp/libsignal-client';
import type * as Zk from '@signalapp/libsignal-client/dist/zkgroup/index.js';

export interface SignalLib {
  core: typeof Core;
  zk: typeof Zk;
}

let loading: Promise<SignalLib> | null = null;

/** Load libsignal once. Rejects with a readable error where no prebuild runs. */
export function loadSignalLib(): Promise<SignalLib> {
  loading ??= (async () => {
    try {
      const [core, zk] = await Promise.all([
        import('@signalapp/libsignal-client'),
        import('@signalapp/libsignal-client/dist/zkgroup/index.js'),
      ]);
      return { core, zk };
    } catch (err) {
      loading = null;
      throw new Error(
        `Signal needs libsignal's native addon, which did not load on this platform (${err instanceof Error ? err.message : String(err)})`,
      );
    }
  })();
  return loading;
}
