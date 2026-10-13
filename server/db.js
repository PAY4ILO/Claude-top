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

  /* 2: права админов, автодобавление в вайтлист по RCON, ссылка на Telegram */
  `
  -- JSON-список прав админа (server/lib/permissions.js); NULL — права по умолчанию
  ALTER TABLE users ADD COLUMN admin_perms TEXT;

  -- Автодобавление в вайтлист при одобрении: 'ok' | 'error' | NULL (RCON не настроен или не пробовали)
  ALTER TABLE applications ADD COLUMN whitelist_status TEXT;
  ALTER TABLE applications ADD COLUMN whitelist_note TEXT NOT NULL DEFAULT '';
  ALTER TABLE applications ADD COLUMN whitelist_at INTEGER;

  UPDATE settings SET value = 'https://t.me/LWL_MINECRAFT' WHERE key = 'telegramUrl' AND value = '';
  `,

  /* 3: личный код входа на Minecraft-сервер (мод LWL) — вместо адреса сервера */
  `
  -- Код в открытом виде не хранится: только sha256 нормализованного кода (12 символов, без дефисов)
  -- и последние 4 символа — чтобы показать игроку «••••-••••-ABCD».
  CREATE TABLE connect_codes (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    code_hash TEXT NOT NULL,
    last4 TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  `,

  /* 4: фото и файлы в чате поддержки */
  `
  -- Вложение сообщения. Сам файл — в LWL_DATA_DIR/attachments/<id> (имя на диске — id, не имя от пользователя).
  -- kind = 'image' только для PNG/JPEG/GIF/WebP, узнанных по первым байтам; остальное — 'file'
  -- (отдаётся как application/octet-stream «скачать»). width/height — у картинок, если удалось узнать.
  CREATE TABLE attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    size INTEGER NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('image', 'file')),
    mime TEXT NOT NULL,
    width INTEGER,
    height INTEGER,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX attachments_message ON attachments(message_id);
  `,

  /* 5: карточки игроков — статистика с Minecraft-сервера (мод lwl-stats) */
  `
  -- Что прислал игровой сервер. Ключ — ник в нижнем регистре; с аккаунтом сайта связь по нику (без FK:
  -- в игре можно быть без аккаунта, а аккаунт — без игры). Координат, инвентаря, IP и способа входа здесь нет.
  -- online/presence_at — из /api/game/presence; «в сети» считается так: online = 1 и presence_at не старше 150 с.
  -- skin_url — ссылка textures.minecraft.net, skin_hash — sha256 скачанного PNG (LWL_DATA_DIR/skins/<hash>.png).
  CREATE TABLE player_stats (
    nick_key TEXT PRIMARY KEY,
    nickname TEXT NOT NULL,
    uuid TEXT,
    first_seen INTEGER NOT NULL,
    last_seen INTEGER NOT NULL,
    online INTEGER NOT NULL DEFAULT 0,
    presence_at INTEGER,
    playtime_sec INTEGER NOT NULL DEFAULT 0,
    deaths INTEGER NOT NULL DEFAULT 0,
    mob_kills INTEGER NOT NULL DEFAULT 0,
    player_kills INTEGER NOT NULL DEFAULT 0,
    blocks_mined INTEGER NOT NULL DEFAULT 0,
    advancements INTEGER NOT NULL DEFAULT 0,
    distance_m INTEGER NOT NULL DEFAULT 0,
    skin_url TEXT,
    skin_hash TEXT,
    skin_slim INTEGER NOT NULL DEFAULT 0,
    extra TEXT,
    stats_at INTEGER
  );
  CREATE INDEX player_stats_online ON player_stats(online);

  -- Что игрок сам настроил в кабинете: «о себе», скрыть карточку, скрыть отдельные поля (JSON-массив ключей).
  CREATE TABLE player_cards (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    bio TEXT NOT NULL DEFAULT '',
    hidden INTEGER NOT NULL DEFAULT 0,
    hide_fields TEXT NOT NULL DEFAULT '[]',
    updated_at INTEGER NOT NULL
  );
  `,

  /* 6: карточки видны всем (гостям — без статистики); поза, фон, соцсети, свой скин из кабинета */
  `
  -- pose/background — ключи из CARD_POSES/CARD_BACKGROUNDS (lib/validate.js), socials — JSON {сеть: ник}.
  -- skin_hash — PNG, загруженный в кабинете (LWL_DATA_DIR/skins/<hash>.png), skin_at — когда;
  -- skin_sync — отправлен ли на Minecraft-сервер через RCON: 'ok' | 'error' | 'off' (RCON не настроен), текст — в skin_sync_note.
  ALTER TABLE player_cards ADD COLUMN pose TEXT NOT NULL DEFAULT 'stand';
  ALTER TABLE player_cards ADD COLUMN background TEXT NOT NULL DEFAULT 'meadow';
  ALTER TABLE player_cards ADD COLUMN socials TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE player_cards ADD COLUMN skin_hash TEXT;
  ALTER TABLE player_cards ADD COLUMN skin_slim INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE player_cards ADD COLUMN skin_at INTEGER;
  ALTER TABLE player_cards ADD COLUMN skin_sync TEXT;
  ALTER TABLE player_cards ADD COLUMN skin_sync_note TEXT;
  -- Когда игровой сервер прислал другой скин: показывается тот, что новее — из игры или из кабинета.
  ALTER TABLE player_stats ADD COLUMN skin_changed_at INTEGER;
  `,

  /* 7: свой скин можно взять по нику лицензии — тогда на сервер уходит `skin of <ник> set <ник лицензии>` (без MineSkin) */
  `
  -- skin_nick — ник лицензии (как у Mojang), если скин взят по нику; NULL — загружен файлом.
  ALTER TABLE player_cards ADD COLUMN skin_nick TEXT;
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
