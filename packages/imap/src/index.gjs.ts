/**
 * GJS entry for @postbote/imap. Keep the exported surface identical to index.node.ts.
 */

export { searchMail, getMessage, listFolders, listParts, fetchPart } from './messages.gjs.ts';
export { ImapBackend } from './backend.gjs.ts';
export { MAIL_MANIFEST } from './manifest.ts';
