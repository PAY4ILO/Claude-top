/**
 * База данных — один файл SQLite (lwl.db в LWL_DATA_DIR).
 * Бэкап — копия файла (см. deploy/backup.sh, делается через .backup, чтобы не поймать запись на середине).
 *
 * Схема меняется только добавлением новой миграции в конец MIGRATIONS:
 * старые миграции не редактировать — они уже применены на рабочей базе.
 */
import { DatabaseSync } from 'node:sqlite';

const MIGRATIONS = [
  /* 1: всё, что было в демо-режиме, + роли, сборки и настройки */
  `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    nickname TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'player', 'admin')),
    avatar_at INTEGER, -- когда загружен аватар (NULL — нет); часть ссылки, чтобы браузер не держал старый
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

  CREATE TABLE avatars (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    mime TEXT NOT NULL,
    data BLOB NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    remember INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX sessions_user ON sessions(user_id);

  CREATE TABLE login_failures (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    locked_until INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
  );

  -- «Забыли пароль?»: пользователь оставляет запрос, админ выдаёт одноразовую ссылку
  CREATE TABLE reset_requests (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE password_resets (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_by TEXT
  );

  CREATE TABLE applications (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    nickname TEXT NOT NULL,
    age INTEGER NOT NULL,
    license TEXT NOT NULL CHECK (license IN ('premium', 'cracked')),
    about TEXT NOT NULL,
    source TEXT NOT NULL,
    contact TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'withdrawn')),
    comment TEXT NOT NULL DEFAULT '',
    reviewer_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX applications_user ON applications(user_id, created_at);
  CREATE INDEX applications_status ON applications(status);

  CREATE TABLE application_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    status TEXT NOT NULL,
    at INTEGER NOT NULL,
    by TEXT
  );
  CREATE INDEX application_history_app ON application_history(application_id, id);

  CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    player_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
    player_messages INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  -- author_id NULL: системное сообщение (system = 1) или автор удалил аккаунт
  CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
    system INTEGER NOT NULL DEFAULT 0,
    client_id TEXT,
    text TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX messages_conv ON messages(conversation_id, created_at);
  CREATE UNIQUE INDEX messages_client ON messages(conversation_id, author_id, client_id) WHERE client_id IS NOT NULL;

  CREATE TABLE conversation_reads (
    conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    read_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, user_id)
  );

  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  -- Сборки для лаунчеров; сам файл лежит в LWL_DATA_DIR/packs/<id>
  CREATE TABLE packs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    launcher TEXT NOT NULL CHECK (launcher IN ('prism', 'curseforge', 'modrinth', 'other')),
    version TEXT NOT NULL DEFAULT '',
    file_name TEXT,
    file_size INTEGER,
    file_sha256 TEXT,
    published INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    downloads INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
];

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  migrate(db);
  return db;
}

function migrate(db) {
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  const row = db.prepare("SELECT value FROM meta WHERE key = 'schema'").get();
  let version = row ? Number(row.value) : 0;
  if (version > MIGRATIONS.length) {
    throw new Error(`База новее кода (схема ${version}, код знает ${MIGRATIONS.length}). Обновите сайт.`);
  }
  for (; version < MIGRATIONS.length; version++) {
    tx(db, () => {
      db.exec(MIGRATIONS[version]);
      db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema', ?)").run(String(version + 1));
    });
  }
}

/**
 * Транзакция. Запросы к SQLite синхронные, поэтому внутри fn нельзя делать await:
 * всё асинхронное (хеш пароля, чтение файла) — до вызова tx.
 */
export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
