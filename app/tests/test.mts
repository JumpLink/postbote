// Test entry: aggregates every *.test.ts suite (each a default-exported async fn) and runs them
// under @gjsify/unit, on GJS and Node both (`gjsify test`). Keep this list in sync when adding a
// test file.
import { run } from '@gjsify/unit';

import runtime from './unit/runtime.test.ts';
import backends from './unit/backends.test.ts';

import imapParse from './unit/protocol/imap-parse.test.ts';
import mimeParse from './unit/protocol/mime-parse.test.ts';
import bodySection from './unit/protocol/body-section.test.ts';
import mutf7 from './unit/protocol/mutf7.test.ts';
import rfc2231 from './unit/protocol/rfc2231.test.ts';
import listParse from './unit/protocol/list-parse.test.ts';
import searchPlan from './unit/protocol/search-plan.test.ts';
import bodyStructure from './unit/protocol/bodystructure.test.ts';
import safeFilename from './unit/protocol/safe-filename.test.ts';
import transferDecode from './unit/protocol/transfer-decode.test.ts';
import mailHeaders from './unit/protocol/mail-headers.test.ts';

import storePaths from './unit/store/paths.test.ts';
import storeDownload from './unit/store/download.test.ts';
import storeFts from './unit/store/fts.test.ts';
import storeSync from './unit/store/sync.test.ts';

import date from './unit/core/date.test.ts';
import limits from './unit/core/limits.test.ts';

import mcpGate from './unit/mcp/gate.test.ts';
import mcpTools from './unit/mcp/tools.test.ts';

run({
  runtime,
  backends,
  imapParse,
  mimeParse,
  bodySection,
  mutf7,
  rfc2231,
  listParse,
  searchPlan,
  bodyStructure,
  safeFilename,
  transferDecode,
  mailHeaders,
  storePaths,
  storeDownload,
  storeFts,
  storeSync,
  date,
  limits,
  mcpGate,
  mcpTools,
});
