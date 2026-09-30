/**
 * Админка: пользователи, роли и права админов, ссылки для сброса пароля, настройки сервера.
 * Плюс публичные настройки сайта. Кто что может — server/lib/permissions.js.
 */
import { tx } from '../db.js';
import { fail } from '../lib/http.js';
import { PERMISSIONS, PERMISSION_KEYS } from '../lib/permissions.js';
import { rconConfigured, whitelistList } from '../lib/rcon.js';
import { randomToken, sha256 } from '../lib/security.js';
import { LIMITS, ROLES } from '../lib/validate.js';

const str = (v) => (typeof v === 'string' ? v : '');
const RESET_TTL = 24 * 3600 * 1000;

export default function register(router, s) {
  const { db, need, views, config } = s;

  function userRow(u) {
    const app = db.prepare('SELECT status, license FROM applications WHERE user_id = ? ORDER BY created_at DESC LIMIT 1').get(u.id);
    const reset = db.prepare('SELECT created_at FROM reset_requests WHERE user_id = ?').get(u.id);
    return Object.assign(views.brief(u), {
      email: u.email,
      createdAt: u.created_at,
      permissions: s.permsOf(u),
      applicationStatus: app ? app.status : null,
      license: app ? app.license : null,
      resetRequestedAt: reset ? reset.created_at : null,
    });
  }

  // Список людей нужен и тем, кто работает с ролями, и тем, кто назначает админов.
  const needPeople = (ctx) => {
    const admin = need.admin(ctx);
    if (!s.can(admin, 'users') && !s.can(admin, 'admins')) need.perm(ctx, 'users');
    return admin;
  };

  router.add('GET', '/api/admin/users', (ctx) => {
    needPeople(ctx);
    const role = ctx.query.get('role') || 'all';
    const q = (ctx.query.get('q') || '').trim().toLowerCase();
    const counts = { user: 0, player: 0, admin: 0, reset: 0 };
    for (const r of db.prepare('SELECT role, COUNT(*) AS n FROM users GROUP BY role').all()) counts[r.role] = r.n;
    counts.reset = db.prepare('SELECT COUNT(*) AS n FROM reset_requests').get().n;
    const where = [];
    const args = [];
    if (ROLES.includes(role)) {
      where.push('u.role = ?');
      args.push(role);
    } else if (role === 'reset') {
      where.push('r.user_id IS NOT NULL');
    }
    if (q) {
      where.push("(lower(u.nickname) LIKE ? ESCAPE '\\' OR lower(u.email) LIKE ? ESCAPE '\\')");
      const like = '%' + q.replace(/[\\%_]/g, (c) => '\\' + c) + '%';
      args.push(like, like);
    }
    const rows = db
      .prepare(`SELECT u.* FROM users u LEFT JOIN reset_requests r ON r.user_id = u.id ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY r.created_at IS NULL, u.created_at DESC LIMIT 500`)
      .all(...args);
    return { items: rows.map(userRow), counts };
  });

  router.add('GET', '/api/admin/users/:id', (ctx) => {
    needPeople(ctx);
    const u = s.getUser(ctx.params.id);
    if (!u) throw fail.notFound('Пользователь не найден.');
    const apps = db.prepare('SELECT * FROM applications WHERE user_id = ? ORDER BY created_at DESC').all(u.id);
    return { user: userRow(u), applications: apps.map(s.applicationView), permissionCatalog: PERMISSIONS };
  });

  /**
   * Трогать чужой аккаунт (роль, удаление, ссылка на сброс пароля) можно не всегда:
   * создателя — никому, кроме него самого; другого админа — только с правом «Админы»
   * (иначе админ с меньшими правами мог бы через сброс пароля войти в аккаунт админа с большими).
   */
  function guardTarget(admin, u, action) {
    if (s.isOwner(u) && u.id !== admin.id) throw fail.forbidden(`Это создатель сайта — ${action} нельзя.`);
    if (u.role === 'admin' && u.id !== admin.id && !s.can(admin, 'admins')) throw fail.forbidden(`${u.nickname} — админ: ${action} может только тот, у кого есть право «Админы».`);
  }

  router.add('PATCH', '/api/admin/users/:id', (ctx) => {
    const admin = need.admin(ctx);
    const role = ctx.body.role;
    if (!ROLES.includes(role)) throw fail.validation({ role: 'Выберите роль.' });
    tx(db, () => {
      const u = s.getUser(ctx.params.id);
      if (!u) throw fail.notFound('Пользователь не найден.');
      if (u.role === role) return;
      if (s.isOwner(u)) throw fail.forbidden('Это создатель сайта (LWL_ADMINS) — он всегда админ.');
      // Выдать или снять админа — право «Админы», остальные роли — право «Люди».
      need.perm(ctx, u.role === 'admin' || role === 'admin' ? 'admins' : 'users');
      guardTarget(admin, u, 'менять роль');
      if (u.id === admin.id && role !== 'admin') {
        const admins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin'").get().n;
        if (admins <= 1) throw fail.conflict('Вы единственный админ — сначала назначьте другого.');
      }
      // Новый админ получает права по умолчанию; снятый — теряет настройки.
      db.prepare('UPDATE users SET role = ?, admin_perms = NULL WHERE id = ?').run(role, u.id);
    });
    return { user: userRow(s.getUser(ctx.params.id)) };
  });

  // Права админа настраивает только создатель.
  router.add('PUT', '/api/admin/users/:id/permissions', (ctx) => {
    need.creator(ctx);
    const list = ctx.body.permissions;
    if (!Array.isArray(list) || list.some((k) => !PERMISSION_KEYS.includes(k))) throw fail.validation({ permissions: 'Неизвестное право.' });
    const u = s.getUser(ctx.params.id);
    if (!u) throw fail.notFound('Пользователь не найден.');
    if (u.role !== 'admin') throw fail.conflict('Права настраиваются только у админов.');
    if (s.isOwner(u)) throw fail.conflict('У создателя всегда все права.');
    const perms = PERMISSION_KEYS.filter((k) => list.includes(k));
    db.prepare('UPDATE users SET admin_perms = ? WHERE id = ?').run(JSON.stringify(perms), u.id);
    return { user: userRow(s.getUser(u.id)) };
  });

  router.add('DELETE', '/api/admin/users/:id', (ctx) => {
    const admin = need.perm(ctx, 'users', 'delete');
    const u = s.getUser(ctx.params.id);
    if (!u) throw fail.notFound('Пользователь не найден.');
    if (u.id === admin.id) throw fail.conflict('Свой аккаунт удаляйте в профиле.');
    guardTarget(admin, u, 'удалить аккаунт');
    db.prepare('DELETE FROM users WHERE id = ?').run(u.id);
    return null;
  });

  // Одноразовая ссылка на сутки. Письма сайт не шлёт — админ отправляет ссылку сам (Telegram, Discord).
  router.add('POST', '/api/admin/users/:id/reset-link', (ctx) => {
    const admin = need.perm(ctx, 'users');
    const u = s.getUser(ctx.params.id);
    if (!u) throw fail.notFound('Пользователь не найден.');
    guardTarget(admin, u, 'выдавать ссылку для сброса пароля');
    const token = randomToken();
    const now = Date.now();
    tx(db, () => {
      db.prepare('DELETE FROM password_resets WHERE user_id = ?').run(u.id);
      db.prepare('INSERT INTO password_resets (token_hash, user_id, created_at, expires_at, created_by) VALUES (?, ?, ?, ?, ?)').run(sha256(token), u.id, now, now + RESET_TTL, admin.id);
      db.prepare('DELETE FROM reset_requests WHERE user_id = ?').run(u.id);
    });
    const base = config.publicUrl || originOf(ctx.req);
    return { url: `${base}/lk.html#/reset/${token}`, expiresAt: now + RESET_TTL };
  });

  /* ------------------------------------------------------------ настройки */

  router.add('GET', '/api/admin/settings', (ctx) => {
    need.perm(ctx, 'server');
    return { settings: s.settings.all(), rcon: rconStatus() };
  });

  router.add('PUT', '/api/admin/settings', (ctx) => {
    need.perm(ctx, 'server');
    const values = {};
    const f = {};
    for (const key of s.settings.keys) {
      if (ctx.body[key] === undefined) continue;
      const v = str(ctx.body[key]).trim();
      if (v.length > LIMITS.setting.max) f[key] = `Максимум ${LIMITS.setting.max} символов.`;
      else if ((key === 'telegramUrl' || key === 'discordUrl') && v && !/^https:\/\/\S+$/.test(v)) f[key] = 'Ссылка должна начинаться с https://';
      values[key] = v;
    }
    if (Object.keys(f).length) throw fail.validation(f);
    s.settings.set(values);
    return { settings: s.settings.all() };
  });

  /* ------------------------------------------------------------ связь с Minecraft-сервером (RCON) */

  // Пароль RCON — только в lwl.env на машине; в браузер уходит лишь адрес и включено ли.
  function rconStatus() {
    return rconConfigured(config.rcon) ? { enabled: true, address: `${config.rcon.host}:${config.rcon.port}` } : { enabled: false };
  }

  router.add('POST', '/api/admin/rcon/test', async (ctx) => {
    need.perm(ctx, 'server');
    need.rate(ctx, 'rcon-test', 20, 60_000);
    if (!rconConfigured(config.rcon)) throw fail.conflict('Связь с сервером не настроена: добавьте LWL_RCON_PASSWORD в /etc/lwl/lwl.env.');
    try {
      return { ok: true, reply: await whitelistList(config.rcon) };
    } catch (err) {
      return { ok: false, reply: err.message };
    }
  });

  // Для главной страницы: ссылки на соцсети. Адрес сервера сюда не входит — его видят только игроки.
  router.add('GET', '/api/settings', () => {
    const all = s.settings.all();
    return { telegramUrl: all.telegramUrl, discordUrl: all.discordUrl };
  });
}

function originOf(req) {
  const proto = req.headers['x-forwarded-proto'] === 'https' ? 'https' : 'http';
  return `${proto}://${req.headers.host}`;
}
