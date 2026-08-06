/**
 * Shared CLI output and argv helpers for read-only commands.
 */

export function printJson(obj: unknown): void {
  console.log(JSON.stringify(obj, null, 2));
}

export function runAndExit<T>(fn: () => Promise<T>, options: { print?: (value: T) => void } = {}): void {
  const print = options.print ?? printJson;
  fn()
    .then(print)
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : err);
      process.exit(1);
    });
}

/**
 * Read an option from yargs argv. Tries each key in order (yargs may expose kebab-case as
 * camelCase or vice versa).
 */
export function pickArgv<T>(argv: Record<string, unknown>, ...keys: string[]): T | undefined {
  for (const key of keys) {
    const v = argv[key];
    if (v !== undefined && v !== null) return v as T;
  }
  return undefined;
}
