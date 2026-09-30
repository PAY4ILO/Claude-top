/** Профиль: ник, аватар, пароль, удаление; «в сети»; счётчики для меню; вкладка «Сервер» игрока. */
import { tx } from '../db.js';
import { HANDLED, fail } from '../lib/http.js';
import { hashPassword, verifyPassword } from '../lib/security.js';
import { LIMITS, validate } from '../lib/validate.js';

const str = (v) => (typeof v === 'string' ? v : '');

// Сигнатуры файлов: верим содержимому, а не тому, что прислал браузер.
const IMAGE_MAGIC = [
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))],
  ['image/webp', (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP'],
];

export default function register(router, s) {
  const { db, need, views } = s;

  router.add('PATCH', '/api/me', (ctx) => {
    const user = need.user(ctx);
    const { nickname, avatar } = ctx.body;
    const now = Date.now();
    let image = null;
    if (nickname !== undefined) {
      const nick = str(nickname).trim();
      const err = validate.nickname(nick);
      if (err) throw fail.validation({ nickname: err });
      if (nick !== user.nickname) {
        // Ник игрока уже в вайтлисте сервера — сам он его не меняет, иначе перестанет пускать в игру.
        if (user.role === 'player') throw fail.validation({ nickname: 'Ник привязан к серверу. Чтобы сменить его, напишите в поддержку.' });
        const other = db.prepare('SELECT id FROM users WHERE nickname = ?').get(nick);
        if (other && other.id !== user.id) throw fail.conflict('Этот никнейм уже занят.', 'NICK_TAKEN', { nickname: 'Этот никнейм уже занят.' });
      }
    }
    if (avatar !== undefined && avatar !== null) {
      const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(str(avatar));
      if (!m) throw fail.validation({ avatar: 'Поддерживаются JPG, PNG и WebP.' });
      const data = Buffer.from(m[2], 'base64');
      if (data.length > LIMITS.avatarBytes) throw fail.validation({ avatar: 'Картинка слишком большая.' });
      const real = IMAGE_MAGIC.find(([, test]) => data.length > 12 && test(data));
      if (!real) throw fail.validation({ avatar: 'Это не похоже на картинку.' });
      image = { mime: real[0], data };
    }
    tx(db, () => {
      if (nickname !== undefined) db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(str(nickname).trim(), user.id);
      if (avatar === null) {
        db.prepare('DELETE FROM avatars WHERE user_id = ?').run(user.id);
        db.prepare('UPDATE users SET avatar_at = NULL WHERE id = ?').run(user.id);
      } else if (image) {
        db.prepare('INSERT INTO avatars (user_id, mime, data, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET mime = excluded.mime, data = excluded.data, updated_at = excluded.updated_at').run(user.id, image.mime, image.data, now);
        db.prepare('UPDATE users SET avatar_at = ? WHERE id = ?').run(now, user.id);
      }
    });
    return { user: views.user(s.getUser(user.id)) };
  });

  // Ссылка на аватар содержит время загрузки (?v=…), поэтому кешировать можно навсегда.
  router.add('GET', '/api/avatars/:id', (ctx) => {
    const row = db.prepare('SELECT mime, data FROM avatars WHERE user_id = ?').get(ctx.params.id);
    if (!row) throw fail.notFound();
    ctx.res.writeHead(200, { 'Content-Type': row.mime, 'Content-Length': row.data.length, 'Cache-Control': 'public, max-age=31536000, immutable' });
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : Buffer.from(row.data));
    return HANDLED;
  });

  router.add('POST', '/api/me/password', async (ctx) => {
    const user = need.user(ctx);
    need.rate(ctx, 'password', 10, 600_000);
    const current = str(ctx.body.currentPassword);
    const next = str(ctx.body.newPassword);
    const f = {};
    if (!current) f.currentPassword = 'Введите текущий пароль.';
    const err = validate.password(next);
    if (err) f.newPassword = err;
    if (Object.keys(f).length) throw fail.validation(f);
    if (!(await verifyPassword(current, user.password_hash))) throw fail.credentials('Текущий пароль неверный.', { currentPassword: 'Неверный пароль.' });
    if (current === next) throw fail.validation({ newPassword: 'Новый пароль совпадает со старым.' });
    const hash = await hashPassword(next);
    tx(db, () => {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, user.id);
      // Остальные устройства выходят из аккаунта.
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash != ?').run(user.id, ctx.sessionHash);
    });
    return null;
  });

  router.add('DELETE', '/api/me', async (ctx) => {
    const user = need.user(ctx);
    need.rate(ctx, 'delete-account', 10, 600_000);
    const password = str(ctx.body.password);
    if (!password) throw fail.validation({ password: 'Введите пароль.' });
    if (!(await verifyPassword(password, user.password_hash))) throw fail.credentials('Неверный пароль.', { password: 'Неверный пароль.' });
    // Заявки, переписка, сессии и аватар удаляются каскадом (ON DELETE CASCADE).
    db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    s.endSession(ctx);
    return null;
  });

  router.add('POST', '/api/me/presence', (ctx) => {
    if (ctx.user) db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(Date.now(), ctx.user.id);
    return null;
  });

  router.add('GET', '/api/me/summary', (ctx) => {
    const user = need.user(ctx);
    if (user.role === 'admin') {
      return {
        role: user.role,
        pendingApplications: db.prepare("SELECT COUNT(*) AS n FROM applications WHERE status = 'pending'").get().n,
        unreadConversations: s.chat.unreadConversationsFor(user),
        resetRequests: db.prepare('SELECT COUNT(*) AS n FROM reset_requests').get().n,
      };
    }
    const app = db.prepare('SELECT status FROM applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(user.id);
    // role — чтобы открытая страница сама заметила, что роль сменили (одобрили заявку, выдали админа).
    return { role: user.role, unreadMessages: s.chat.unreadMessagesFor(user), applicationStatus: app ? app.status : null };
  });

  // Вкладка «Сервер»: адрес, как заходить, сборки. Только для игроков (и админов).
  router.add('GET', '/api/me/server', (ctx) => {
    const user = need.player(ctx);
    const all = s.settings.all();
    const app = db.prepare("SELECT * FROM applications WHERE user_id = ? AND status = 'approved' ORDER BY updated_at DESC LIMIT 1").get(user.id);
    const packs = db.prepare('SELECT * FROM packs WHERE published = 1 AND file_name IS NOT NULL ORDER BY sort, created_at').all();
    return {
      server: { address: all.serverAddress, version: all.serverVersion, note: all.serverNote, telegramUrl: all.telegramUrl, discordUrl: all.discordUrl },
      me: { nickname: user.nickname, role: user.role, license: app ? app.license : null, approvedAt: app ? app.updated_at : null },
      packs: packs.map(s.packView),
    };
  });
}
