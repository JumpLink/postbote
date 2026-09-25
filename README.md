# Postbote

Your GNOME mail, contacts and calendar — on the command line, and as an
[MCP](https://modelcontextprotocol.io) server so an AI assistant can search your
mailbox for you.

Postbote reads the accounts you already configured in **GNOME Settings → Online
Accounts**. There is nothing to log into and no password to store: credentials
come from GNOME Online Accounts at runtime and are never written to disk, never
logged, and never returned by any command.

It runs on **GJS** (GNOME's JavaScript runtime) via
[gjsify](https://github.com/gjsify/gjsify) — the same stack a GNOME desktop app
is built on, which is where this is headed.

> **Status: early.** The CLI and the MCP server work; the desktop app does not
> exist yet.

## What it does

- **Mail (IMAP)** — search across folders by sender, recipient, subject, date
  range and full text; read a message; list its parts; save an attachment.
- **Contacts** and **calendar** — read the address books and calendars that
  Evolution Data Server keeps in sync for your online accounts.
- **Local index** — an optional SQLite full-text index so repeated searches are
  instant and work offline. Indexing ~1200 messages takes about half a minute;
  searching them afterwards takes under a second.

- **Telegram** (optional, off by default) — your direct chats, groups and
  channels in the same conversation view as mail, through Telegram's official
  API ([mtcute](https://github.com/mtcute/mtcute)). See [Telegram](#telegram).
- **WhatsApp** (optional, off by default, **unofficial — risks your account**) —
  your chats as a linked device through [Baileys](https://github.com/WhiskeySockets/Baileys).
  See [WhatsApp](#whatsapp).
- **XMPP / Jabber** (optional, off by default) — direct chats with your roster
  and the rooms you joined, read from the server's message archive (MAM) through
  [xmpp.js](https://github.com/xmppjs/xmpp.js). See [XMPP](#xmpp).
- **Matrix** (optional, off by default) — the rooms you have joined, end-to-end
  encrypted ones included, through
  [matrix-js-sdk](https://github.com/matrix-org/matrix-js-sdk) and its Rust
  crypto compiled to WebAssembly. See [Matrix](#matrix).

Everything is **read-only**. Messages are fetched with IMAP `BODY.PEEK`, so
opening a mail through Postbote never marks it as read. Telegram is read the
same way: nothing is sent, edited, deleted or marked read. WhatsApp too: no
message, no read receipt, no online presence (see [WhatsApp](#whatsapp) for the
one acknowledgement every linked device sends). XMPP likewise — Postbote never
sends a presence, so contacts do not see it online and your offline messages
stay queued for your real clients. Matrix too: no presence, no read
receipt, no typing notice, no message, and no invitation is accepted.

## Requirements

- GNOME Online Accounts + Evolution Data Server (Fedora:
  `gnome-online-accounts`, `evolution-data-server`), and `libgda-sqlite` for the
  index
- A running user session D-Bus — the GOA and EDS daemons are reached over it, so
  a bare SSH session without one will report the backend as unavailable
- An **Email (IMAP/SMTP)** account in GNOME Settings. Nextcloud/ownCloud accounts
  expose files, calendar and contacts but no mail.
- Implicit TLS (port 993). STARTTLS on port 143 is not implemented yet.

## Install and run

```bash
gjsify install
gjsify workspace postbote-cli build
gjsify run app/dist/postbote.gjs.mjs accounts
```

## Use it

```bash
postbote check                              # which backends are reachable
postbote accounts                           # which online accounts are available
postbote folders                            # mailboxes, with their roles

postbote search "energieberater" --since 2025-01-01
postbote search --from berater --all-folders --limit 20
postbote message <uid> --account <id>       # one message: body + attachment list
postbote parts <uid> --account <id>         # what is attached, and how big
postbote save <uid> --account <id>          # write the attachment to disk

postbote sync                               # build the local index
postbote index status                       # what it holds, and how fresh
postbote index search "wärmepumpe"          # offline, no server contact

postbote conversations list --people-only   # threads with a person in them, newest first
postbote conversations show <id>            # its messages; bodies only with --bodies
postbote conversations classify <address> automated   # correct one sender (auto = undo)

postbote backends list                      # message backends, and which are enabled

postbote contacts --query maier
postbote calendar --from 2026-09-01 --to 2026-09-30
```

Every command prints JSON — the same shapes the MCP tools return.

`search` returns headers only, never bodies; reading one message is a separate,
explicit call, and getting an attachment's bytes a third. That is not a policy
you can flip with a flag — the search path contains no code that can fetch a
body.

`--since` and `--before` filter the message **Date** header, not its arrival
time. After a mailbox migration every message's arrival timestamp is the
migration date, which makes an arrival filter useless; `--received-since` is
there when you genuinely mean arrival.

Search folds diacritics, so `marz` finds `März`. (`ß` is a letter rather than a
diacritic, so `grusse` does not find `Grüße`.)

`sync` also groups mail into **conversations** by `Message-ID`, `In-Reply-To` and
`References`, and classifies each one: *conversational* (a known contact, or a
thread you replied in) or *automated* (`List-Id`, `List-Unsubscribe`,
`Auto-Submitted`, `Precedence`, no-reply senders). A stranger nobody replied to
is held back until you reply or classify the sender. This is the groundwork for
chat backends ([ADR 0001](docs/adr/0001-multi-protocol-messenger.md)): each
backend is enabled explicitly in the config, and one with a terms notice only
after `postbote backends enable <name> --accept-terms`.

## Telegram

Telegram requires every third-party client to use API credentials of its own
user. Postbote ships none, so the first step is yours:

1. Create an app for yourself at <https://my.telegram.org> → *API development
   tools*. You get an `api_id` (a number) and an `api_hash` (32 hex characters).
2. Enable the backend (this shows Telegram's terms once) and log in. The login
   asks for the `api_id` and `api_hash` first (the hash without echo), then the
   phone number, the login code and the 2FA password if one is set:

   ```bash
   postbote backends enable telegram --accept-terms
   postbote accounts add telegram
   postbote accounts list --backend telegram
   postbote sync                      # mail and Telegram into one index
   postbote conversations list --people-only
   ```

   The `api_id`/`api_hash` are kept in the account's session file, not in the
   config (which is plain text in every backup; a config that carries them is
   refused). To keep them in a password manager instead, set
   `POSTBOTE_TELEGRAM_API_ID` and `POSTBOTE_TELEGRAM_API_HASH`; the environment
   wins over the stored pair and the login does not ask.

The first sync takes the newest 200 messages of every chat; later syncs walk
forward from there, at most 5 000 messages per run (the rest follows on the
next). A contact whose phone number is in your address book becomes the same
person as their mail address. Channels and bots are classified *automated*.

A message deleted on Telegram stays in the index until a full scan:
`postbote sync --full-scan` re-reads each chat's newest window and removes every
stored message in it that Telegram no longer has, and every chat that left your
list. (Telegram reports deletions only as live updates, which a sync without a
daemon does not receive.)

The login leaves a **session file** at
`$XDG_DATA_HOME/postbote/secrets/telegram/telegram-<user id>.db` (mode `0600`
in a `0700` directory; override the base with `POSTBOTE_SECRETS_DIR`). Whoever
holds it can read your Telegram account (it also holds your `api_id`/`api_hash`):
back it up like a password, never share it. A login killed halfway leaves a
`login-*.pending.db` there; the next `accounts add` or account listing removes it
once it is 15 minutes old. Telegram lists it under *Settings → Devices* as `postbote`, where you can
end it; deleting the file ends it on this machine.

## WhatsApp

> **Read this first.** WhatsApp has no API for reading your own chats. Postbote
> uses [Baileys](https://github.com/WhiskeySockets/Baileys), an **unofficial**
> reimplementation of the WhatsApp Web protocol. Using it **violates WhatsApp's
> Terms of Service**, and WhatsApp bans accounts it sees using unofficial
> clients — temporarily or for good. The ban hits your **phone number**. Enable
> this only if you accept that risk for that number.

Postbote joins your WhatsApp as a **linked device**, like WhatsApp Web:

```bash
postbote backends enable whatsapp --accept-terms   # shows the notice above once
postbote accounts add whatsapp                     # QR code, or a pairing code
postbote sync                                      # right away — see below
postbote conversations list --people-only
```

`accounts add whatsapp` asks for a phone number. Leave it empty and a QR code
appears in the terminal: on the phone, *WhatsApp → Settings → Linked devices →
Link a device*, and scan it (a new code appears every ~20 s). Or type the number
(international, `+49…`) and enter the 8-character pairing code it prints under
*Link a device → Link with phone number instead*. The device shows up in that
list as a browser session (Baileys' default, *Chrome (Mac OS)*); unlink it there
to end it.

**WhatsApp keeps no archive.** A message is gone from WhatsApp's servers once a
device has received it, so what postbote stores is the **only copy** it has —
its part of the index is irreplaceable, not a cache. Consequences:

- **Run `postbote sync` right after linking.** The phone hands the recent
  history (roughly the last months) to a new device once. `sync` connects,
  receives that history and everything queued while no device of postbote was
  connected, writes it, and disconnects once WhatsApp has nothing more to
  hand over (it gives up waiting after ten minutes and says so). Set
  `backends.whatsapp.settings.fullHistory: true` in the config **before**
  linking to ask for the full history instead — larger, slower.
- **Sync at least every two weeks.** WhatsApp unlinks a device that has not
  connected for about 14 days; after that, `sync` reports the logout and you link
  again (the conversations stay, under the same account id). A receiving daemon
  that stays connected is planned; until then, `sync` from a timer.
- **Back up the index** (`$XDG_DATA_HOME/postbote/index.db`) like the config:
  with WhatsApp enabled it holds messages that exist nowhere else.

Deletions and edits are applied as they arrive: a message the sender deleted
for everyone, or you deleted or cleared on your phone, is removed from the index;
an edited one gets the new text. Contacts are linked by phone number to your
address book, like Telegram's.

What postbote sends: nothing you could see. It connects with
`markOnlineOnConnect: false`, so it announces itself *unavailable* (never online)
and your phone keeps its notifications; it never sends a read receipt (the
blue ticks stay yours). It does acknowledge each delivered message — the grey
double tick every linked device sends, and the signal for WhatsApp to forget the
message.

The link leaves a **session file** at
`$XDG_DATA_HOME/postbote/secrets/whatsapp/whatsapp-<LID>.db` (mode `0600`): the
device's Signal keys. Whoever holds it can read your incoming WhatsApp messages —
back it up like a password, never share it. The account id is your LID,
WhatsApp's privacy id, never your phone number.

## XMPP

Postbote reads XMPP history only from the server's **message archive** (MAM,
XEP-0313), which Prosody (`mod_mam`, `mod_muc_mam`) and ejabberd offer. A server
without one is refused with an explanation: the alternative, receiving offline
messages, would take them away from your other clients.

```bash
postbote backends enable xmpp
postbote accounts add xmpp        # JID, password (no echo), server address
postbote sync
```

The server address may stay empty: Postbote then looks up direct TLS
(`_xmpps-client._tcp` SRV, XEP-0368), then WebSocket (`host-meta`, XEP-0156),
then STARTTLS. The certificate is checked against your XMPP domain. On the
gjsify release Postbote currently runs on (0.49.0), TLS sockets do not work
yet ([gjsify#1837](https://github.com/gjsify/gjsify/pull/1837)), so on GJS only
the **WebSocket** endpoint is usable — give `wss://…` if discovery finds none.
A server with its own CA: set `backends.xmpp.settings.tlsCaFile` to the PEM file.

The login uses SCRAM-SHA-1 and sends a password in the clear (PLAIN) only inside
TLS. The password is kept in
`$XDG_DATA_HOME/postbote/secrets/xmpp/xmpp-<hash>.db` (`0600`), never in the
config — a config that carries one is refused.

Chats are your roster contacts and the bookmarked rooms you join automatically.
Corrections (XEP-0308) replace the stored text, retractions (XEP-0424/0425)
remove the message. OMEMO-encrypted messages are indexed without their text:
Postbote cannot decrypt them yet.

## Matrix

Matrix is an open protocol, so there are no terms beyond your homeserver's own.
Log in with your homeserver, user and password:

```bash
postbote backends enable matrix
postbote accounts add matrix       # homeserver URL or server name, user, password
postbote sync
```

The login creates a **new device** named `postbote` (it appears in your
session list in Element and every other client) and uploads its encryption
keys. Only password login is supported: a homeserver that offers single
sign-on alone — matrix.org, since its move to the Matrix Authentication
Service — is refused with that reason for now.

Encrypted rooms are decrypted where this device holds the room key. That is
every message sent **after** the login: senders encrypt for the new device from
then on, and its keys arrive with each sync. Messages sent **before** it show as
`[encrypted message: this device has no key for it]`: reading them needs your
server-side key backup or a verified session sharing its keys, and neither is
built yet.

The first sync takes the newest 200 messages of every joined room, later syncs
walk forward. Edits and redactions arrive as events of their own and are applied
on the next sync — a message redacted on the server is removed from the index
without a full scan. Rooms you are only invited to are left alone.

The login leaves an **account file** at
`$XDG_DATA_HOME/postbote/secrets/matrix/matrix-<hash>.db` (mode `0600`). It holds
the access token and the device's crypto store (its identity keys and every room
key it received): back it up like a password. Losing it means a new login, a new
device, and no key for anything sent before it. To end the session, sign the
`postbote` device out in another client and delete the file.

## As an MCP server

`postbote mcp` speaks MCP over stdio. Registered in an MCP client it exposes
`mail_search`, `mail_get_message`, `mail_list_folders`, `mail_list_parts`,
`mail_save_attachment`, `mail_search_local`, `mail_sync_status`,
`conversations_list`, `conversations_get`, `contacts_search`,
`calendar_list_events` and `accounts_list`.

The server is read-only by default and **fails closed**: a tool is registered
only if it declares itself read-only, so a future tool that forgets the
annotation is silently withheld rather than silently exposed.

See [`.mcp.json`](.mcp.json) for a working registration.

## Your data stays yours

The local index contains message headers **and** plain-text bodies. It lives at
`$XDG_DATA_HOME/postbote/index.db` (mode `0600`), never inside this repository,
and only `postbote sync` ever writes to it — a search never does. Attachments
are saved to your download directory. Both locations are overridable via
`POSTBOTE_DATA_DIR`, `POSTBOTE_DB_PATH` and `POSTBOTE_ATTACHMENTS_DIR`.

Your decisions — enabled backends, accepted terms, per-sender classification —
live in `$XDG_CONFIG_HOME/postbote/config.json` (mode `0600`, override with
`POSTBOTE_CONFIG`). Unlike the index they cannot be rebuilt from a server, so
back that file up.

Chat sessions (Telegram, WhatsApp, Matrix — including Matrix's crypto store) and
chat passwords (XMPP) are **secrets**, kept apart from the index under
`$XDG_DATA_HOME/postbote/secrets/` — no command or MCP tool ever returns one.
The index can be rebuilt from the servers **unless WhatsApp is enabled**:
WhatsApp keeps no archive, so its messages in the index are the only copy
(`postbote backends list` shows this as `storeTier: state`).

Nothing is sent anywhere. Postbote talks to your mail server — and to Telegram,
WhatsApp, your XMPP server or your Matrix homeserver if you enabled them — and
to nothing else.

## Development

See [AGENTS.md](AGENTS.md).

## License

[AGPL-3.0-or-later](LICENSE) © Pascal Garber.

Free to use, modify and share. The AGPL adds one condition to the GPL: anyone who
runs this program **as a network service** must offer that service's users the
source of their version. Running it locally for yourself adds no obligation.
