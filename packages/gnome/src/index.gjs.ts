/**
 * GJS entry for @postbote/gnome.
 *
 * Native implementation over `gi://Goa`, `gi://EDataServer`, `gi://EBook`, `gi://ECal`, …
 * returning the plain DTOs from @postbote/protocol.
 *
 * Selected via package.json `exports` (browser → here). Keep the exported surface identical to
 * index.node.ts — the Node stub is what makes the pure tests runnable off GJS, and a surface
 * that drifts turns a missing export into a runtime failure only one of the two runtimes sees.
 */

export { check, listAccounts } from './goa.gjs.ts';
export { searchContacts } from './contacts.gjs.ts';
export { listEvents } from './calendar.gjs.ts';
export { listMailTargets } from './credentials.gjs.ts';
