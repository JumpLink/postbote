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

Everything is **read-only**. Messages are fetched with IMAP `BODY.PEEK`, so
opening a mail through Postbote never marks it as read. Telegram is read the
same way: nothing is sent, edited, deleted or marked read.

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

Chat sessions (Telegram) are **secrets**, kept apart from the index under
`$XDG_DATA_HOME/postbote/secrets/` — the index can be rebuilt from the servers,
a session cannot, and no command or MCP tool ever returns it.

Nothing is sent anywhere. Postbote talks to your mail server — and to Telegram
if you enabled it — and to nothing else.

## Development

See [AGENTS.md](AGENTS.md).

## License

[AGPL-3.0-or-later](LICENSE) © Pascal Garber.

Free to use, modify and share. The AGPL adds one condition to the GPL: anyone who
runs this program **as a network service** must offer that service's users the
source of their version. Running it locally for yourself adds no obligation.
