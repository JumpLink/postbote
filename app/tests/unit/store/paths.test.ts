import { describe, expect, it } from '@gjsify/unit';

import { attachmentsDir, dataDir, indexDbPath, xdgDataHome } from '@postbote/store';

// Every function here takes its environment as a parameter, so the promise these tests check —
// nothing is EVER written inside the repository — is checkable without touching the real one.
export default async () => {
  await describe('xdgDataHome', async () => {
    await it('honours an absolute XDG_DATA_HOME', async () => {
      expect(xdgDataHome({ XDG_DATA_HOME: '/custom/data' })).toBe('/custom/data');
    });

    await it('ignores a RELATIVE XDG_DATA_HOME, per the spec', async () => {
      // A relative value must be treated as unset. Honouring it would resolve against the
      // current directory — which, run from a checkout, is the repository.
      expect(xdgDataHome({ XDG_DATA_HOME: 'relative/path' }).startsWith('/')).toBe(true);
      expect(xdgDataHome({ XDG_DATA_HOME: '' }).endsWith('/.local/share')).toBe(true);
    });

    await it('defaults to ~/.local/share', async () => {
      expect(xdgDataHome({}).endsWith('/.local/share')).toBe(true);
    });
  });

  await describe('dataDir', async () => {
    await it('is always absolute and outside any checkout', async () => {
      expect(dataDir({}).startsWith('/')).toBe(true);
      expect(dataDir({}).endsWith('/postbote')).toBe(true);
    });

    await it('follows XDG_DATA_HOME', async () => {
      expect(dataDir({ XDG_DATA_HOME: '/custom/data' })).toBe('/custom/data/postbote');
    });

    await it('can be overridden wholesale', async () => {
      expect(dataDir({ POSTBOTE_DATA_DIR: '/srv/postbote' })).toBe('/srv/postbote');
    });
  });

  await describe('indexDbPath', async () => {
    await it('defaults inside the data directory', async () => {
      expect(indexDbPath({ XDG_DATA_HOME: '/custom/data' })).toBe('/custom/data/postbote/index.db');
    });

    await it('FORCES a .db suffix onto an override', async () => {
      // Not cosmetic. gjsify's node:sqlite is a libgda wrapper, and libgda appends `.db` to
      // whatever it is given — so `index.sqlite` lands on disk as `index.sqlite.db`, and the
      // next open makes `index.sqlite.db.db`.
      expect(indexDbPath({ POSTBOTE_DB_PATH: '/tmp/mine.sqlite' })).toBe('/tmp/mine.sqlite.db');
      expect(indexDbPath({ POSTBOTE_DB_PATH: '/tmp/mine' })).toBe('/tmp/mine.db');
      expect(indexDbPath({ POSTBOTE_DB_PATH: '/tmp/mine.db' })).toBe('/tmp/mine.db');
    });
  });

  await describe('attachmentsDir', async () => {
    await it('prefers the download directory when one is set', async () => {
      expect(attachmentsDir({ XDG_DOWNLOAD_DIR: '/home/u/Downloads' })).toBe('/home/u/Downloads');
    });

    await it('falls back inside the data directory', async () => {
      expect(attachmentsDir({ XDG_DATA_HOME: '/custom/data' })).toBe('/custom/data/postbote/attachments');
    });

    await it('lets an explicit override win over the download directory', async () => {
      expect(
        attachmentsDir({ XDG_DOWNLOAD_DIR: '/home/u/Downloads', POSTBOTE_ATTACHMENTS_DIR: '/mnt/mail' }),
      ).toBe('/mnt/mail');
    });

    await it('ignores a relative XDG_DOWNLOAD_DIR', async () => {
      expect(attachmentsDir({ XDG_DOWNLOAD_DIR: 'Downloads', XDG_DATA_HOME: '/d' })).toBe(
        '/d/postbote/attachments',
      );
    });
  });
};
