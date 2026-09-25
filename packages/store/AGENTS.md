# AGENTS.md — @postbote/store

Local state: XDG paths, attachment writing, the SQLite full-text index and the sync engine.
The repo-wide rules are in [../../AGENTS.md](../../AGENTS.md); this file is the store-specific
layer and wins where they differ.

## The one rule that shapes this package

**`store` must never import a backend** (`imap`, `telegram`). The sync engines are driven
through the `MailBackend` and `ChatBackend` ports
declared in `@postbote/protocol` and injected by `app`. That keeps this package free of `gi://`
even transitively, which is the only reason `sync.ts` — the most intricate code in the project —
can be unit-tested on Node against a fake backend and `:memory:`. If you want to reach into
`imap` from here, add a method to the port instead.

`node:*` is fine. `gi://` is not, at any depth.

## SQLite here is libgda, not sqlite3

gjsify's `node:sqlite` is a **libgda 6.0 wrapper**. The API is `DatabaseSync`, so it looks like
Node's, but five behaviours leak through and every one of them will bite you.

| # | Behaviour | What it forces |
|---|---|---|
| a | `all()` / `get()` **swallow exceptions** and return `[]` | A broken query returns EMPTY, not an error — indistinguishable from "nothing matched". **Never** put raw user input in `MATCH`; build it with `toFts5Match()`. `probeFts5()` runs at open time so a missing FTS5 module fails LOUDLY instead of making the whole index look empty. |
| b | `exec()` splits multi-statement strings itself and does not understand `BEGIN … END` | **No triggers.** A trigger body would be cut into broken fragments. One statement per array entry in `schema.ts`, and no SQL comments inside those strings — the splitter is not a SQL parser. |
| c | Parameters are **interpolated as escaped SQL literals**, not bound | Positional `?` only. The named path substitutes `:name` across the whole statement without excluding string literals. Do not store BLOBs. |
| d | An FTS `SELECT` parses as `UNKNOWN`, so the wrapper tries `execute_non_select`, throws, and retries as a select | **Every FTS query runs twice.** Keep them narrow — `rowid` + `rank`, with a `LIMIT` — and hydrate the rows in a second, ordinary `SELECT`. |
| e | libgda caches every executed statement per connection, and each holds a GWeakRef on the SQLite provider, which the whole PROCESS shares (GLib caps it at 65 535). A `run()` costs ~4 (it also selects `changes()` and `last_insert_rowid()`), so after ~16 000 of them in one process every SELECT returns `[]` on any connection, a fresh one included (see (a)). Measured: three connections of 10 000 `run()` each, each closed before the next, broke on the third, so closing connections did not keep a process under the limit. Gap unfixed in 0.49.0; the core fix is gjsify#1838 | **Count executions.** Bulk writes go through `insertMany` (multi-row, 120 bound values a statement; parse cost grows with the square of the parameter count) and set-based `uid IN (…)` chunks. Never one `run()` per message. The 6 000-message resync test in `sync.test.ts` fails on per-row writes. |

Two more, smaller:

- **The database filename must end in `.db`.** libgda appends the suffix itself, so
  `index.sqlite` lands on disk as `index.sqlite.db`. `indexDbPath()` enforces it; `openIndexDb()`
  checks again.
- **`remove_diacritics 2` folds diacritics, not `ß`.** `Grüße` indexes as `gruße`, so `grusse`
  finds nothing. Pinned by a test so it is not mistaken for a bug.

Because of (b) the FTS table is maintained by application code, in the same transaction as the
`messages` write. That is better than a trigger anyway: an `AFTER UPDATE` trigger would fire on
every `\Seen` change and rewrite the whole FTS row, body included.

## Conversations are derived

`conversations`, `conversation_messages`, `participants` and their link tables are rewritten
from `messages` by `rebuildConversations` after every sync, in one transaction. Threading
is a union over the whole mailbox and a message's class depends on its thread (did the user
reply?), so a full rebuild is the simple correct form; ids are hashes of stable inputs, so they
survive it. Per-sender overrides are NOT stored here — they come from the config and apply at
read time, and `peopleOnlyClause` (SQL) must keep agreeing with `conversationVerdict` (JS);
a test pins both directions.

## Chats are written once, and linked on every rebuild

`syncChats` (the `chat` driver's engine) writes chat messages into `conversation_messages`
directly, incrementally, with a per-chat cursor in `chat_cursors`. They are NOT rewritten by the
rebuild: a chat history is far larger than a mailbox's thread set and rewriting it every sync
would spend the execution budget of (e) for nothing. What the rebuild does redo, set-based in a
handful of statements, is the link into the participant directory (`chat_peer_links`, sender
ids, memberships, `known-contact`), because the address book can change without a new message.
A conversation is a chat because it has a cursor row — never because of its backend's name.

Chat bodies live on their `conversation_messages` row (`body`); mail bodies stay once in the
FTS table.

## Where data lives — the actual privacy guarantee

Nothing is ever written inside the repository. The index holds mail headers **and plain-text
bodies**, and this repo is public, so a stray index file would be a permanent leak.

- `$XDG_DATA_HOME/postbote/index.db`, mode `0600`, re-applied on every open.
- Attachments to `$XDG_DOWNLOAD_DIR`, else `$XDG_DATA_HOME/postbote/attachments`, dir mode `0700`.
- Backend secrets (chat sessions) in `SecretStore` files under `$XDG_DATA_HOME/postbote/secrets/`,
  0600 in 0700, TEXT only (bytes as base64 — BLOBs do not survive (c)), writes batched.
- Overridable only through `POSTBOTE_DATA_DIR` / `POSTBOTE_DB_PATH` / `POSTBOTE_ATTACHMENTS_DIR` /
  `POSTBOTE_SECRETS_DIR`.

`.gitignore` is the second line of defence. Not writing there is the first, and it lives in
`paths.ts` — whose tests take the environment as a parameter precisely so this is checkable.

**Only `postbote sync` writes to the index.** A search never does. One mental model, and no
surprise disk growth from a read.

## Attachment writing

`safeFileName()` (in `protocol`) has already reduced a hostile MIME name to one path segment.
`download.ts` is defence in depth on top: join, resolve, and verify the result is still inside
the target directory. Never overwrite — an existing name gains ` (2)`. Write to `.part` and
rename only on success, so a failed transfer leaves NO file; a half-written PDF that opens and
shows the first three pages is worse than none.

Three `// fixed upstream in gjsify:` shims live in `FileSink`, all fixed and tested in the
gjsify submodule but not yet in a published release. Remove each once the version bumps:
`writeSync` kept no write cursor, `'wx'` did not fail on an existing file, and `openSync`
ignores its mode argument (which made attachments world-readable).
