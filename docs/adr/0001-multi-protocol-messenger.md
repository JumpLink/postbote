# ADR 0001 — postbote becomes a multi-protocol messenger; mail is one backend

- **Status:** Accepted (2026-09-25)
- **Scope:** `@postbote/protocol` (ports, DTOs, plugin API), `@postbote/store`, new backend
  packages, `app` (CLI, MCP, a later daemon and GUI)

## Context

postbote reads mail, contacts and calendars through GNOME Online Accounts, as a CLI and an MCP
server. The next need is chat: Signal, Telegram, WhatsApp, later Matrix and XMPP. Two shapes
were on the table:

- **A separate multi-chat app.** It would have to rebuild or import what postbote already
  owns: the contact store (EDS), a sync engine behind a port, the SQLite index, the read-only MCP
  gate. And it adds another MCP server to every agent session, which is paid on every call.
- **postbote grows.** The name already fits (a Bote carries any message). The value a unified
  client adds is the per-person view — everything to and from one person, across networks —
  and that view needs the contacts postbote already has.

Bridges (mautrix and friends, a Matrix homeserver in the middle) were considered and rejected
for now: each network is handled directly in the app. A stranger installing postbote must not
need to run a homeserver.

## Decision

### 1. Mail is a backend like any other — but it is not dressed up as chat

At the port level, mail stands beside Signal and Matrix: same participant model, same
conversation model, same search. In presentation it keeps what makes it mail (subject, folders,
HTML body, attachments as documents). Delta Chat's approach — every message a bubble — works for
messages Delta Chat itself sends and fails for invoices, newsletters and long threads.

The store therefore classifies every mail **conversational** (from a known contact, or a thread
the user replied in) or **automated** (`List-Id`, `List-Unsubscribe`, `Auto-Submitted`,
`Precedence`, no-reply senders), correctable per sender. Conversational mail joins the
conversation list; automated mail stays in a mailbox view. The classification lives in the core
so the CLI and MCP get it too (`--people-only`), not only a future GUI.

### 2. Two sync models, declared by each backend

| Model | Backends | Consequence |
|---|---|---|
| **Server archive** | IMAP, Telegram, Matrix, XMPP with MAM (XEP-0313) | The local index is rebuildable — `derived` in the state manifest |
| **Delivery only** | Signal, WhatsApp | Messages are gone from the server once delivered: a receiving daemon is required, and the local store is the only copy — `state` |

The sync engine branches on the declared model, never on the network name. Crypto stores kept by
native backends (presage, matrix-sdk) are `secret`, separate from the message store.

### 3. Capabilities, not a lowest common denominator

Each backend declares what it can do — edits, reactions, threads, read receipts, groups, E2EE,
subject, folders — and a **presentation kind** per message (`bubble` | `document`). CLI, MCP and
GUI hide what a backend cannot do, instead of branching on the network.

### 4. Identity: one participant, many typed addresses

Phone number, Telegram user, Matrix ID, JID and mail address are addresses of one person. A
participant carries several typed addresses and links to the EDS contact.

### 5. `@postbote/protocol` is the versioned plugin API

Backends implement the port declared in `protocol` and ship a manifest: name, plugin-API version,
capabilities, sync model, whether it is native, and a terms notice. Only backends enabled
explicitly in the config are loaded; the first enable shows the terms notice (the same gate idea
as troedler). Plugins are never fetched from the network at runtime.

Built-in backends go through the same interface, so the plugin API is used from day one:

| Backend | Where it ships | Why there |
|---|---|---|
| mail (IMAP; the existing code) | in the repo | the reference backend the port is proven against |
| Telegram, Matrix, XMPP | in the repo | open or officially permitted third-party clients |
| Signal | own package | native addon, per-platform prebuilds; the rest works without it |
| WhatsApp | **own repository** | unofficial protocol, against WhatsApp's terms, real ban risk; a takedown hits only the plugin |

### 6. Language per backend: the best implementation wins

TypeScript where a mature TypeScript library exists; Rust through a napi-rs (or Neon) addon
where the reference implementation is Rust and carries the cryptography. gjsify already runs
N-API addons on GJS. Vala only for a library that should also serve other GNOME apps through
GObject Introspection.

| Network | Choice | Verified in `refs/` |
|---|---|---|
| Telegram | **mtcute** (TypeScript, MIT) | runtime packages for Node, Bun, Deno, web; crypto in a `wasm` package, no native addon |
| Matrix | **matrix-rust-sdk** behind our own napi-rs crate — spike first | no Node binding in the tree (only uniffi FFI); `matrix-sdk-sqlite` store; Fractal builds on it |
| Signal | **presage** behind our own napi-rs crate, or **`@signalapp/libsignal-client`** (Neon/N-API) with a TypeScript service layer modelled on Signal-Desktop's `ts/textsecure/` — spike decides | presage: AGPL, no binding, SQLite(+SQLCipher) store; Flare reaches it through its own `flare-backend` wrapper |
| XMPP | **xmpp.js** (ISC) | no OMEMO anywhere in the tree; Dino ships its OWN OMEMO (`plugins/omemo/`, Vala+C) — the model for ours |
| WhatsApp | **Baileys** (MIT) | depends on `libsignal` and `whatsapp-rust-bridge`: not pure TypeScript |

Every candidate's license is compatible with postbote's AGPL-3.0-or-later (AGPL, MIT, ISC,
MPL-2.0, LGPL-2.1).

### 7. Order

Port and store schema with both sync models, proven by mail → Telegram → Matrix → daemon +
Signal → XMPP → WhatsApp. Matrix comes early: official, server-archive, and its E2EE path is the
first real test of a native addon in postbote.

## GUI direction (later, recorded so the data model carries it now)

One app, `Adw.NavigationSplitView`: a sidebar with **Conversations** and **Mailbox**.

- A person's conversation interleaves chat bubbles and collapsed mail cards (subject,
  attachments, preview; expand to the full reader). Reply inline, by default on the channel of
  the last message; mail replies expand to a full composer.
- The mailbox is a classic list + reader for automated mail.

| Area | Model |
|---|---|
| Chat list and timeline | Flare, Paper Plane (the latter inactive since 2024-06) |
| Mail cards inside a conversation | Convey (a GTK4/libadwaita hard fork of Geary, Vala, uses GOA) |
| Mailbox, composer, privacy defaults | Hylki (Rust, relm4/libadwaita, IMAP/SMTP, own OAuth + keyring — postbote keeps GOA) |

## Consequences

- `store` gains conversation, participant and message tables, a mail thread builder
  (`References`/`In-Reply-To`) and the conversational/automated classification.
  `store` still never imports a backend.
- The existing IMAP code moves behind the new port before any new network lands.
- A daemon (systemd user unit) arrives with the first delivery-only backend.
- MCP tools stay read-only until a send path has its own decision record. Chat rows are other
  people's words: the privacy rules for MCP output apply to them unchanged.
- Native backends add prebuild packages per platform (gjsify's ADR 0017 mechanism).

## References

The code behind every claim above is in [`refs/`](../../refs/), catalogued in
[AGENTS.md → References](../../AGENTS.md#references).
