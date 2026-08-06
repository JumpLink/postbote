/**
 * Node entry for @postbote/gnome.
 *
 * GNOME Online Accounts and Evolution Data Server are GObject-Introspection libraries available
 * only under GJS, so on Node the whole surface is the "unavailable" stub. Selected via
 * package.json `exports` (node → here, browser → index.gjs.ts). Keep the exported surface
 * identical to the GJS entry.
 */

export { check, listAccounts, searchContacts, listEvents, listMailTargets } from './unavailable.ts';
