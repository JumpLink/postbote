/**
 * Shared availability messages for the GNOME binding, so the Node stub and the
 * GJS implementation report the three states with identical wording:
 *   (a) Node            → GJS_REQUIRED_MESSAGE
 *   (b) GJS, no GOA/EDS → GOA_UNAVAILABLE_MESSAGE
 *   (c) GJS, 0 accounts → NO_ACCOUNTS_MESSAGE (ok: true)
 */

export const GNOME_CLIENT_NAME = 'GNOME';

export const GJS_REQUIRED_MESSAGE =
  'GNOME integration requires the GJS runtime (run the GJS build via `gjsify run` / `npm run start:gjs`, not plain node).';

export const GOA_UNAVAILABLE_MESSAGE =
  'GNOME Online Accounts / Evolution Data Server unavailable (Goa/EDS typelib or session D-Bus missing).';

export const NO_ACCOUNTS_MESSAGE = 'OK (0 accounts configured — add one in GNOME Settings → Online Accounts)';
