// Test entry: aggregates every *.test.ts suite (each a default-exported async fn) and runs them
// under @gjsify/unit, on GJS and Node both (`gjsify test`). Keep this list in sync when adding a
// test file.
import { run } from '@gjsify/unit';

import runtime from './unit/runtime.test.ts';
import backends from './unit/backends.test.ts';

import imapParse from './unit/protocol/imap-parse.test.ts';
import mimeParse from './unit/protocol/mime-parse.test.ts';
import bodySection from './unit/protocol/body-section.test.ts';

run({
  runtime,
  backends,
  imapParse,
  mimeParse,
  bodySection,
});
