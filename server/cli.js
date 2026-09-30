#!/usr/bin/env node
/**
 * Команды для админа на сервере (запускать от пользователя lwl, с теми же переменными окружения):
 *   sudo -u lwl --preserve-env=LWL_DATA_DIR node server/cli.js users
 *   ... role <ник|почта> <user|player|admin>   — выдать роль
 *   ... reset-link <ник|почта>                   — ссылка для смены пароля (24 часа)
 *   ... backup <файл.db>                         — снимок базы (можно при работающем сайте)
 * На машине проще через обёртку: lwl-cli users (ставит deploy/install.sh).
 */
import path from 'node:path';
import { openDb } from './db.js';
import { loadConfig } from './config.js';
import { randomToken, sha256 } from './lib/security.js';

const config = loadConfig();
const db = openDb(path.join(config.dataDir, 'lwl.db'));
const [cmd, ...args] = process.argv.slice(2);

const find = (who) => db.prepare('SELECT * FROM users WHERE nickname = ? OR email = ?').get(who, String(who).toLowerCase());
const die = (msg) => {
  console.error(msg);
  process.exit(1);
};

switch (cmd) {
  case 'users': {
    const rows = db.prepare('SELECT nickname, email, role, created_at FROM users ORDER BY created_at').all();
    for (const u of rows) console.log(`${u.role.padEnd(7)} ${u.nickname.padEnd(17)} ${u.email}  (с ${new Date(u.created_at).toLocaleDateString('ru-RU')})`);
    console.log(`Всего: ${rows.length}`);
    break;
  }
  case 'role': {
    const [who, role] = args;
    if (!who || !['user', 'player', 'admin'].includes(role)) die('Использование: role <ник|почта> <user|player|admin>');
    const u = find(who) || die(`Нет пользователя ${who}`);
    db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, u.id);
    console.log(`${u.nickname}: роль ${role}`);
    break;
  }
  case 'reset-link': {
    const [who] = args;
    const u = (who && find(who)) || die('Использование: reset-link <ник|почта>');
    const token = randomToken();
    const now = Date.now();
    db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(u.id);
    db.prepare('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?)').run(sha256(token), u.id, now, now + 24 * 3600 * 1000, 'cli');
    console.log(`${config.publicUrl || 'https://ВАШ-ДОМЕН'}/lk.html#/reset/${token}`);
    console.log('Ссылка действует 24 часа и сработает один раз.');
    break;
  }
  case 'backup': {
    const [file] = args;
    if (!file) die('Использование: backup <файл.db>');
    // VACUUM INTO делает целостный снимок даже во время работы сайта.
    db.prepare('VACUUM INTO ?').run(path.resolve(file));
    console.log(`Снимок базы: ${path.resolve(file)}`);
    break;
  }
  default:
    console.log('Команды: users | role <ник|почта> <user|player|admin> | reset-link <ник|почта> | backup <файл.db>');
    process.exit(cmd ? 1 : 0);
}
db.close();
