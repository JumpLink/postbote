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
  instant and work offline. *(planned — see below for what ships today)*

Everything is **read-only**. Messages are fetched with IMAP `BODY.PEEK`, so
opening a mail through Postbote never marks it as read.

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
postbote check                             # which backends are reachable
postbote accounts                          # which online accounts are available
postbote search "energieberater" --since 2025-01-01 --limit 20
postbote message <uid> --account <id>      # one message: body + attachment list
postbote contacts --query maier
postbote calendar --from 2026-09-01 --to 2026-09-30
```

Every command prints JSON — the same shapes the MCP tools return.

`search` returns headers only, never bodies; reading one message is a separate,
explicit call. Not a policy that can be flipped with a flag: the search path has
no code that can fetch a body.

*Not built yet:* `folders`, `parts`, `save` and `sync`, and the structured
`--from` / `--to` / `--subject` search filters. Today `search` takes free text
plus `--since`, `--unseen`, `--folder`, `--account` and `--limit`, and looks in
one folder (`INBOX` by default).

## As an MCP server

`postbote mcp` speaks MCP over stdio. Registered in an MCP client it currently
exposes `mail_search`, `mail_get_message`, `contacts_search`,
`calendar_list_events` and `accounts_list`; `mail_list_folders`,
`mail_list_parts`, `mail_save_attachment` and `mail_sync_status` follow with the
features above.

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

Nothing is sent anywhere. Postbote talks to your mail server and to nothing else.

## Development

See [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)
