# AGENTS.md — postbote

Operating guide for AI agents in the **postbote** repo. Follows the
[agents.md](https://agents.md/) convention; the human overview is [README.md](README.md).
This repo is a submodule of **werkstatt**, whose [AGENTS.md](../../AGENTS.md) carries the
broader workspace rules — this file is the postbote-specific layer and wins where they differ.

> **The directory is `projects/mail`, the repo is `postbote`. That is deliberate — do not
> "fix" it.** Git keys submodules by *path*, not by repo name, and werkstatt already carries
> three such pairs (`projects/das-frittier-werk`, `projects/jumplink`, `projects/riba`).

## What this is

Mail (IMAP), contacts (CardDAV) and calendar (CalDAV) through **GNOME Online Accounts**, as a
CLI and an MCP server. A TypeScript monorepo that **runs on GJS via gjsify** (not Node),
following the buchhaltung/leitstand pattern: pure-TS `packages/*` + one `app` workspace that
carries the gjsify toolchain and picks a frontend at the yargs entrypoint.

The code came out of `buchhaltung/packages/gnome`; the git history there is the deeper record.

**v1 is read-only.** IMAP is spoken with `BODY.PEEK` only, so `\Seen` is never set. There is no
SMTP, no flag write, no move, no delete.

## Package layout — and the one rule that holds it together

| Package | Contains | May import |
|---|---|---|
| `@postbote/protocol` | **Pure.** RFC grammar (IMAP lexer, ENVELOPE, FETCH, LIST, BODYSTRUCTURE, MIME, RFC 2047/2231, modified UTF-7), DTOs, errors, the plugin API: `MessageBackend` port + manifest, `BackendContext`, the `MailBackend` mailbox driver and the `ChatBackend` chat driver | nothing |
| `@postbote/gnome` | GOA + EDS: accounts, contacts, calendar, IMAP credentials | `protocol`, `gi://` |
| `@postbote/imap` | Gio TLS transport, IMAP client, folders, search, fetch, attachments | `protocol`, `gnome`, `gi://` |
| `@postbote/store` | SQLite index, sync engines (mailbox + chat), conversations (threading, classification), secret store, XDG paths, file writes | `protocol`, `node:*` |
| `@postbote/telegram` | Telegram `chat` backend on mtcute (web build: WebSocket, WebCrypto, WASM), its session storage on `SecretStore`, the login | `protocol`, `store`, `@mtcute/*`, `node:*` — no `gi://` |
| `@postbote/whatsapp` | WhatsApp `delivery` backend on Baileys (unofficial protocol: WebSocket, WASM, libsignal), its auth state on `SecretStore`, the QR / pairing-code link | `protocol`, `store`, `baileys`, `node:*` — no `gi://` |
| `@postbote/xmpp` | XMPP `chat` backend on xmpp.js (composed by hand: domain-checked direct TLS, WebSocket, SCRAM), history from MAM only, the account file on `SecretStore`, the login. NEVER sends presence, markers or messages | `protocol`, `store`, `@xmpp/*`, `node:*` — no `gi://` |
| `@postbote/matrix` | Matrix `chat` backend on matrix-js-sdk + the Rust crypto as WASM (`@matrix-org/matrix-sdk-crypto-wasm`), its crypto store as an in-memory IndexedDB snapshotted into `SecretStore`, the password login | `protocol`, `store`, `matrix-js-sdk`, `@matrix-org/*`, `fake-indexeddb`, `node:*` — no `gi://` |
| `postbote-cli` (`app/`) | yargs CLI + MCP server, config file, backend registry | all of the above |

**`store` must never import a backend** (`imap`, `telegram`, `xmpp`, `matrix`, …). The sync engines are driven
through the driver ports declared in `protocol` (`MailBackend`, `ChatBackend`) and injected by
`app`. That keeps `store` free of `gi://` and of any network library even transitively, which
is the only reason the sync algorithms — the most intricate part of this project — can be
unit-tested on Node against a fake backend and `:memory:`. If you find yourself wanting to
import a backend from `store`, add a method to the port instead.

**`@postbote/whatsapp` is imported by nothing but the app's registry** (`builtin.ts`) — no
other package, no shared helper pulled out of it into `store` or `protocol`. WhatsApp is an
unofficial protocol against WhatsApp's terms (ADR 0001 §5): if a takedown or ban wave makes it
necessary, the package must move to its own repository in one step. Anything it needs from the
rest goes through the ports; duplicate a ten-line helper rather than share it.

**File naming carries meaning:** a file containing a `gi://` import is named `*.gjs.ts`.
Everything else is pure and must stay runnable on Node. Packages that need both ship a
`package.json` `exports` map (`browser` → `index.gjs.ts`, `node`/`default` → a stub that throws
`GnomeUnavailableError`), so `gi://` never enters a Node bundle.

## Run / build / test

- Deps: **`gjsify install`** — NEVER `npm install`, it prunes gjsify deps. Node 24 to bootstrap
  (gjsify's install-backend prebuilds target 24; Fedora's 22 segfaults).
- All four `@gjsify/*` packages are pinned to the **same exact version**. gjsify ships as one
  release train and a CLI ↔ libs skew produces silently broken bundles. Bump them together.
- `typescript` is pinned `^6.0.3`, **not** 7: `gjsify tsc` does not use this dependency, it
  runs a bundle with TypeScript 6.0.3 baked in. A local 7 would give a different diagnostic set
  than CI — green locally, red in CI.
- Use gjsify's own workspace feature, not npm's: `gjsify foreach -A <script>` (the `-A`
  includes `private: true` workspaces — without it your packages are silently skipped),
  `gjsify workspace <name> <script>` for one (note: **no `run` keyword**).

```bash
gjsify foreach -A check                        # type-check everything
gjsify workspace postbote-cli build            # → app/dist/postbote.gjs.mjs
gjsify workspace postbote-cli test             # @gjsify/unit, on gjs AND node
gjsify run app/dist/postbote.gjs.mjs <command>
gjsify workspace postbote-cli test:whatsapp-network  # real WhatsApp, no account: up to the QR code
```

Tests run on **both** runtimes. That dual run is the entire point of the pure/`*.gjs.ts` split —
if a change makes the Node run impossible, the change is in the wrong file.

A long-running FOREGROUND GJS process is killed by the werkstatt sandbox (Exit 144) — launch
the MCP server via `run_in_background` when driving it.

## Privacy — this repo is PUBLIC

- The local index holds mail headers **and plain-text bodies**. It lives at
  `$XDG_DATA_HOME/postbote/index.db` (mode `0600`), **never** inside the repo. Same for
  attachments. `.gitignore` is the second line of defence; not writing there is the first.
- Test fixtures are **synthetic only**. Never commit a real message, address, or mailbox name.
- Credentials come from GOA per connection: never logged, never stored, never in a DTO.
- Chat sessions (Telegram's auth key and the api_id/api_hash it was created with; WhatsApp's
  Signal keys and device credentials; Matrix's access token and the device's crypto store — Olm
  account and every room key it received) and XMPP passwords are the secrets postbote stores:
  one file per account under `$XDG_DATA_HOME/postbote/secrets/<backend>/`
  (created 0600 in 0700), through `SecretStore` — never in the index, never logged, never in a
  DTO or MCP output. Its backup tier is `secret`; the index stays `derived`.
- **Delivery-only messages are `state`, not cache.** WhatsApp keeps no server archive: a
  message is gone from its servers once a device acknowledged it, so what `receiveDeliveries`
  writes is the only copy. With a `delivery-only` backend enabled the index is irreplaceable —
  never "fix" a problem by deleting and rebuilding it, and never ask the session for the next
  batch before the previous one is written. The WhatsApp auth state (Signal keys) is `secret`.
  A linked device that does not connect for ~14 days is logged out by WhatsApp.
  Baileys acknowledges a message BEFORE emitting it, so the receiver journals every event
  (fsync'ed, `secrets/whatsapp/<account>.journal`, 0600) before returning to Baileys, and replays
  a left-over journal first — never bypass it.
- **No secret in the config file** — it is `state`, plain text in every backup. `backends.<name>.
  settings` is for non-secret settings only; Telegram refuses an api_id/api_hash there.
- Server-side deletions: the mailbox engine sees them every flag pass; the chat engine on
  `sync --full-scan` (Telegram reports deletions only as live updates) and on every sync for a
  network that reports them in its history (XMPP retractions, Matrix redactions:
  `ChatHistoryPage.retracted`); the delivery engine as events (revoke, delete-for-me,
  clear/delete chat), applied in the batch they arrive in. Keep that pass working —
  a deleted message that stays MCP-readable is a privacy defect, not a staleness one.
- Only `postbote sync` writes to the index. A search never does — one mental model, and no
  surprise disk growth from a read. User decisions (enabled backends, accepted terms,
  per-sender classification) go to `$XDG_CONFIG_HOME/postbote/config.json`, never the index,
  and overrides apply at read time.
- **Backends load only through the registry** (`app/src/core/backends/`), and only when the
  config enables them; a backend with a terms notice needs `--accept-terms` first. Built-in
  mail goes through it too — do not construct a backend anywhere else.

## Conventions

- **Parsing is pure.** Socket code does I/O and nothing else; every byte of grammar lives in
  `protocol` with unit tests. When you add an IMAP capability, the parser and its test come
  first, in `protocol` — not inline in the client.
- **No TypeScript parameter properties** (`constructor(private x: T)`). Node's
  `--experimental-strip-types` rejects them, which silently breaks the Node test run.
- **SQLite runs on libgda, not sqlite3** — gjsify's `node:sqlite` is a `Gda` wrapper, and it
  leaks through in five ways that WILL bite you. Read
  [`packages/store/AGENTS.md`](packages/store/AGENTS.md) before writing any SQL.
- **MCP tools are read-only or they do not register.** `app/src/frontends/mcp/runtime.ts`
  registers a tool only when `annotations.readOnlyHint === true`; a tool that omits the
  annotation is dropped. Do not loosen this to a name list.
  Two canaries prove it still bites (`tools/gate-canary.ts`, `POSTBOTE_MCP_GATE_CANARY=1`,
  asserted by `test:mcp`): one declares `readOnlyHint: false`, one carries NO annotations.
  The unannotated one is load-bearing — with only the first, the gate was rewritten to the
  fail-open spelling and the whole integration suite stayed GREEN. Never "simplify" them to one.
- Conventional commits (`feat(imap): …`, `fix(store): …`), imperative, subject ≤ 50 chars.
  Run `gjsify foreach -A check` and the tests before committing. No `--no-verify`.
- This repo is a **submodule of werkstatt**: commit here on `main`, push, *then* bump the
  pointer in the parent. NEVER stage across that boundary in one commit.

## References

`refs/` holds 15 **read-only**, shallow reference repos (~330 MB with `.git`) for the
multi-protocol work decided in [ADR 0001](docs/adr/0001-multi-protocol-messenger.md). Never edit
under `refs/`; initialize only what the task needs
(`git submodule update --init --depth 1 refs/<name>`). CI does not check them out.
Read the code before claiming how a network or library behaves.

| Area | Repos | Read it for |
|---|---|---|
| Signal | `flare`, `presage`, `libsignal`, `signal-desktop` | GTK4 client (Flare via `flare-backend` → presage); Rust client lib; Neon/N-API `@signalapp/libsignal-client`; TS service layer in `ts/textsecure/` |
| Matrix | `fractal`, `matrix-rust-sdk`, `matrix-spec` | GTK4 client; SDK (uniffi FFI only, no Node binding); the spec |
| Telegram | `paper-plane`, `mtcute` | GTK4 client on TDLib (inactive since 2024-06); pure-TS MTProto |
| WhatsApp | `whatsmeow`, `baileys` | Go reference; TS library (needs `libsignal` + `whatsapp-rust-bridge`) |
| XMPP | `dino`, `xmpp.js` | GTK4 client with its own OMEMO (`plugins/omemo/`); TS client, no OMEMO |
| Mail UI | `convey`, `hylki` | GTK4 Geary fork (conversation cards, GOA); Rust/libadwaita mailbox + composer |

## Fix gjsify gaps at the core

gjsify is a first-party dependency, not vendored third-party code. If a capability is missing
or broken there, fix it in the `gjsify/gjsify` submodule with a test and let postbote pick it
up via a version bump — do not paper over it here.

A shim that is unavoidable meanwhile carries **one of two markers, and they mean opposite
things at bump time**:

- `// fixed upstream in gjsify: …` — the fix has LANDED. Delete the shim at the next bump.
- `// gjsify gap (unfixed, <PR>): …` — no upstream fix exists yet. The shim is **load-bearing**;
  leave it however redundant it looks.

**Neither marker is a substitute for measuring.** `download.ts` carried three of the second kind
against gjsify#1035; the fix arrived as #1039 instead, so the marker named a PR that was still
open while the behaviour it described had already changed. A bump re-measures the behaviour and
believes the result, not the note — that is a four-line probe, and it is how those three shims
came out in 0.32.0.

`app/src/frontends/mcp/runtime.ts` is an **extraction candidate** for a future `@gjsify/mcp`:
keep it free of postbote imports so it can move verbatim.
