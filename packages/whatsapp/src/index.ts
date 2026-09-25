/**
 * Barrel of the WhatsApp backend. Re-exports only — no implementation.
 *
 * Nothing in `packages/*` imports this package; only the app's registry does.
 */

export * from './manifest.ts';
export * from './api.ts';
export * from './jid.ts';
export * from './map.ts';
export * from './auth-state.ts';
export * from './receiver.ts';
export * from './journal.ts';
export * from './accounts.ts';
export * from './qr.ts';
export * from './client.ts';
export * from './login.ts';
export * from './backend.ts';
