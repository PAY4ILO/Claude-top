/** Регистрация, вход, выход, «Забыли пароль?» (через ссылку от администратора). */
import { tx } from '../db.js';
import { fail } from '../lib/http.js';
import { burnPasswordTime, hashPassword, newId, sha256, verifyPassword } from '../lib/security.js';
import { clean, validate } from '../lib/validate.js';

const str = (v) => (typeof v === 'string' ? v : '');
const LOCK_AFTER = 5;
const LOCK_MS = 60 * 1000;

export default function register(router, s) {
  const { db, need, views } = s;

  const byNick = db.prepare('SELECT * FROM users WHERE nickname = ?');
  const byEmail = db.prepare('SELECT * FROM users WHERE email = ?');

  router.add('POST', '/api/auth/register', async (ctx) => {
    need.rate(ctx, 'register', 10, 3600_000, 'Слишком много регистраций с вашего адреса. Попробуйте через час.');
    const nickname = str(ctx.body.nickname).trim();
    const email = str(ctx.body.email).trim().toLowerCase();
    const password = str(ctx.body.password);
    const f = clean({ nickname: validate.nickname(nickname), email: validate.email(email), password: validate.password(password) });
    if (Object.keys(f).length) throw fail.validation(f);
    const taken = () => {
      if (byNick.get(nickname)) throw fail.conflict('Этот никнейм уже занят.', 'NICK_TAKEN', { nickname: 'Этот никнейм уже занят.' });
      if (byEmail.get(email)) throw fail.conflict('Аккаунт с этой почтой уже есть.', 'EMAIL_TAKEN', { email: 'Аккаунт с этой почтой уже есть.' });
    };
    taken();
    const hash = await hashPassword(password);
    const now = Date.now();
    const id = newId('u');
    // Новичок — «Пользователь»; «Игрок» выдаётся, когда одобрят заявку. Владельцы из LWL_ADMINS — сразу админы.
    const role = s.isOwner({ email, nickname }) ? 'admin' : 'user';
    tx(db, () => {
      taken();
      db.prepare('INSERT INTO users (id, nickname, email, password_hash, role, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, nickname, email, hash, role, now, now);
    });
    s.startSession(ctx, id, !!ctx.body.remember);
    return { user: views.user(s.getUser(id)) };
  });

  router.add('POST', '/api/auth/login', async (ctx) => {
    need.rate(ctx, 'login', 30, 600_000);
    const login = str(ctx.body.login).trim();
    const password = str(ctx.body.password);
    const f = clean({ login: login ? '' : 'Введите никнейм или почту.', password: password ? '' : 'Введите пароль.' });
    if (Object.keys(f).length) throw fail.validation(f);

    const key = 'login:' + login.toLowerCase();
    const now = Date.now();
    const rec = db.prepare('SELECT * FROM login_failures WHERE key = ?').get(key);
    if (rec && rec.locked_until > now) {
      const wait = Math.ceil((rec.locked_until - now) / 1000);
      throw fail.rateLimited(wait, `Слишком много попыток. Попробуйте через ${wait} с.`);
    }
    const user = login.includes('@') ? byEmail.get(login.toLowerCase()) : byNick.get(login);
    const ok = user ? await verifyPassword(password, user.password_hash) : (await burnPasswordTime(password), false);
    if (!ok) {
      const count = (rec && rec.locked_until <= now && rec.locked_until ? 0 : rec ? rec.count : 0) + 1;
      const locked = count >= LOCK_AFTER;
      db.prepare('INSERT INTO login_failures (key, count, locked_until, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET count = excluded.count, locked_until = excluded.locked_until, updated_at = excluded.updated_at').run(
        key,
        locked ? 0 : count,
        locked ? now + LOCK_MS : 0,
        now
      );
      throw fail.credentials();
    }
    db.prepare('DELETE FROM login_failures WHERE key = ?').run(key);
    s.startSession(ctx, user.id, !!ctx.body.remember);
    return { user: views.user(s.getUser(user.id)) };
  });

  router.add('POST', '/api/auth/logout', (ctx) => {
    s.endSession(ctx);
    return null;
  });

  router.add('GET', '/api/auth/me', (ctx) => ({ user: views.user(need.user(ctx)) }));

  // Писем сайт не отправляет: запрос видят админы в разделе «Пользователи» и присылают ссылку.
  // Ответ одинаковый для любой почты, чтобы по нему нельзя было проверять, кто зарегистрирован.
  router.add('POST', '/api/auth/password-reset', (ctx) => {
    need.rate(ctx, 'reset-request', 5, 3600_000);
    const email = str(ctx.body.email).trim().toLowerCase();
    const err = validate.email(email);
    if (err) throw fail.validation({ email: err });
    const user = byEmail.get(email);
    if (user) db.prepare('INSERT INTO reset_requests (user_id, created_at) VALUES (?, ?) ON CONFLICT(user_id) DO UPDATE SET created_at = excluded.created_at').run(user.id, Date.now());
    return null;
  });

  const resetByHash = db.prepare('SELECT * FROM password_resets WHERE token_hash = ? AND expires_at > ?');

  router.add('GET', '/api/auth/password-reset/:token', (ctx) => {
    need.rate(ctx, 'reset-check', 30, 600_000);
    const row = resetByHash.get(sha256(ctx.params.token), Date.now());
    const user = row && s.getUser(row.user_id);
    if (!user) throw fail.notFound('Ссылка недействительна или устарела. Попросите администратора прислать новую.');
    return { nickname: user.nickname };
  });

  router.add('POST', '/api/auth/password-reset/:token', async (ctx) => {
    need.rate(ctx, 'reset-use', 10, 600_000);
    const password = str(ctx.body.password);
    const err = validate.password(password);
    if (err) throw fail.validation({ password: err });
    const hash = await hashPassword(password);
    const tokenHash = sha256(ctx.params.token);
    const userId = tx(db, () => {
      const row = resetByHash.get(tokenHash, Date.now());
      if (!row) throw fail.notFound('Ссылка недействительна или устарела. Попросите администратора прислать новую.');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hash, row.user_id);
      // Старые входы (в том числе того, кто, возможно, узнал пароль) больше не действуют.
      db.prepare('DELETE FROM sessions WHERE user_id = ?').run(row.user_id);
      db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(row.user_id);
      db.prepare('DELETE FROM reset_requests WHERE user_id = ?').run(row.user_id);
      db.prepare('DELETE FROM login_failures WHERE key IN (?, ?)').run('login:' + s.getUser(row.user_id).nickname.toLowerCase(), 'login:' + s.getUser(row.user_id).email.toLowerCase());
      return row.user_id;
    });
    s.startSession(ctx, userId, false);
    return { user: views.user(s.getUser(userId)) };
  });
}
