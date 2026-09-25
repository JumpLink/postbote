/**
 * The `BackendContext` a backend is constructed with: its settings from the config, the
 * environment, and its own private secrets directory. The one place those are decided, so no
 * backend picks a path or reads the config file by itself.
 */

import type { BackendContext } from '@postbote/protocol';
import { secretsDir } from '@postbote/store';
import { join } from 'node:path';
import type { PostboteConfig } from '../config.ts';

export function backendContext(
  name: string,
  config: PostboteConfig,
  env: NodeJS.ProcessEnv = process.env,
): BackendContext {
  return {
    settings: config.backends[name]?.settings ?? {},
    env,
    secretsDir: join(secretsDir(env), name),
  };
}
