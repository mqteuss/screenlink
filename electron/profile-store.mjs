import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const CUSTOM_AVATAR = /^data:image\/(?:jpeg|png|webp);base64,[a-z0-9+/=]+$/i;

function normalizeName(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 28) || 'Você';
}

function normalizeAvatar(value) {
  const avatar = String(value || '');
  if (/^[a-z0-9-]{1,24}$/i.test(avatar)) return avatar;
  if (CUSTOM_AVATAR.test(avatar) && avatar.length <= 32_000) return avatar;
  return 'orbit';
}

function normalizeStatus(value) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 64) || 'Disponível';
}

export function createProfileStore(userDataDirectory) {
  mkdirSync(userDataDirectory, { recursive: true });
  const databasePath = path.join(userDataDirectory, 'screenlink.sqlite');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS local_profile (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      name TEXT NOT NULL,
      avatar TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'Disponível',
      updated_at INTEGER NOT NULL
    );
  `);

  const columns = database.prepare('PRAGMA table_info(local_profile)').all();
  if (!columns.some(column => column.name === 'status')) {
    database.exec("ALTER TABLE local_profile ADD COLUMN status TEXT NOT NULL DEFAULT 'Disponível'");
  }

  const read = database.prepare('SELECT name, avatar, status FROM local_profile WHERE id = 1');
  const write = database.prepare(`
    INSERT INTO local_profile (id, name, avatar, status, updated_at)
    VALUES (1, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      avatar = excluded.avatar,
      status = excluded.status,
      updated_at = excluded.updated_at
  `);

  return {
    databasePath,
    load() {
      const row = read.get();
      return row ? { name: normalizeName(row.name), avatar: normalizeAvatar(row.avatar), status: normalizeStatus(row.status) } : null;
    },
    save(profile) {
      write.run(normalizeName(profile?.name), normalizeAvatar(profile?.avatar), normalizeStatus(profile?.status), Date.now());
    },
    close() {
      database.close();
    }
  };
}

export function registerProfileIpc({ ipcMain, userDataDirectory, isTrustedSender = () => true }) {
  const store = createProfileStore(userDataDirectory);
  function assertTrusted(event) {
    if (!isTrustedSender(event)) throw new Error('Origem não autorizada para acessar o perfil local.');
  }
  ipcMain.handle('screenlink:profile:load', event => {
    assertTrusted(event);
    return store.load();
  });
  ipcMain.handle('screenlink:profile:save', (event, profile) => {
    assertTrusted(event);
    return store.save(profile);
  });
  return () => {
    ipcMain.removeHandler('screenlink:profile:load');
    ipcMain.removeHandler('screenlink:profile:save');
    store.close();
  };
}
