/**
 * Приложение: база, общие сервисы (сессии, права, представления данных) и маршруты.
 * Точка входа для запуска — server/index.js; тесты создают приложение через createApp().
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { openDb } from './db.js';
import { HANDLED, HttpError, Router, clientIp, cookie, fail, parseCookies, readJson, securityHeaders, sendError, sendJson, serveStatic } from './lib/http.js';
import { RateLimiter, randomToken, sha256, useFastHashing } from './lib/security.js';
import registerAuth from './routes/auth.js';
import registerMe from './routes/me.js';
import registerApplications from './routes/applications.js';
import registerChats from './routes/chats.js';
import registerAdmin from './routes/admin.js';
import registerPacks from './routes/packs.js';

const SESSION_COOKIE = 'lwl_session';
const DAY = 24 * 3600 * 1000;
const ONLINE_MS = 70 * 1000;

export const ROLE_LABELS = { user: 'Пользователь', player: 'Игрок', admin: 'Админ' };

export function createApp(config) {
  fs.mkdirSync(path.join(config.dataDir, 'packs'), { recursive: true });
  useFastHashing(config.fastHash);
  const db = openDb(path.join(config.dataDir, 'lwl.db'));
  const limiter = new RateLimiter();

  /* ------------------------------------------------------------ владельцы */

  const isOwner = (u) => !!u && (config.admins.includes(String(u.email).toLowerCase()) || config.admins.includes(String(u.nickname).toLowerCase()));
  // Владельцы из LWL_ADMINS всегда админы — даже если их понизили прямо в базе.
  if (config.admins.length) {
    const marks = config.admins.map(() => '?').join(',');
    db.prepare(`UPDATE users SET role = 'admin' WHERE role != 'admin' AND (lower(email) IN (${marks}) OR lower(nickname) IN (${marks}))`).run(...config.admins, ...config.admins);
  }

  /* ------------------------------------------------------------ представления */

  const avatarUrl = (u) => (u && u.avatar_at ? `/api/avatars/${encodeURIComponent(u.id)}?v=${u.avatar_at}` : null);

  const views = {
    user: (u) =>
      u && {
        id: u.id,
        nickname: u.nickname,
        email: u.email,
        role: u.role,
        avatar: avatarUrl(u),
        createdAt: u.created_at,
        lastSeenAt: u.last_seen_at,
        owner: isOwner(u),
      },
    brief: (u) =>
      u
        ? {
            id: u.id,
            nickname: u.nickname,
            role: u.role,
            avatar: avatarUrl(u),
            online: Date.now() - (u.last_seen_at || 0) < ONLINE_MS,
            lastSeenAt: u.last_seen_at || null,
          }
        : null,
  };

  const userById = db.prepare('SELECT * FROM users WHERE id = ?');
  const getUser = (id) => (id ? userById.get(id) : null);

  /* ------------------------------------------------------------ сессии */

  const sessionByHash = db.prepare('SELECT * FROM sessions WHERE token_hash = ?');

  function startSession(ctx, userId, remember) {
    const token = randomToken();
    const now = Date.now();
    const ttl = remember ? 30 * DAY : DAY;
    db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at, remember) VALUES (?, ?, ?, ?, ?)').run(sha256(token), userId, now, now + ttl, remember ? 1 : 0);
    // Без «Запомнить меня» — сессионная кука: пропадает при закрытии браузера.
    ctx.res.setHeader('Set-Cookie', cookie(SESSION_COOKIE, token, { secure: secureCookies(ctx), maxAge: remember ? ttl / 1000 : undefined }));
    db.prepare('UPDATE users SET last_seen_at = ? WHERE id = ?').run(now, userId);
    return token;
  }

  function endSession(ctx) {
    if (ctx.sessionHash) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(ctx.sessionHash);
    ctx.res.setHeader('Set-Cookie', cookie(SESSION_COOKIE, '', { secure: secureCookies(ctx), maxAge: 0 }));
  }

  function secureCookies(ctx) {
    return config.secureCookies || ctx.req.headers['x-forwarded-proto'] === 'https';
  }

  function authenticate(ctx) {
    const token = ctx.cookies[SESSION_COOKIE];
    if (!token) return;
    const hash = sha256(token);
    const s = sessionByHash.get(hash);
    if (!s) return;
    const now = Date.now();
    if (s.expires_at < now) {
      db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
      return;
    }
    const user = getUser(s.user_id);
    if (!user) return;
    // Скользящий срок: активная сессия продлевается.
    const ttl = s.remember ? 30 * DAY : DAY;
    if (s.expires_at - now < ttl / 2) db.prepare('UPDATE sessions SET expires_at = ? WHERE token_hash = ?').run(now + ttl, hash);
    ctx.user = user;
    ctx.sessionHash = hash;
  }

  const cleanupTimer = setInterval(() => {
    const now = Date.now();
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    db.prepare('DELETE FROM password_resets WHERE expires_at < ?').run(now);
    db.prepare('DELETE FROM login_failures WHERE updated_at < ?').run(now - DAY);
  }, 3600 * 1000);
  cleanupTimer.unref();

  /* ------------------------------------------------------------ права */

  const need = {
    user(ctx) {
      if (!ctx.user) throw fail.unauthorized();
      return ctx.user;
    },
    admin(ctx) {
      const u = need.user(ctx);
      if (u.role !== 'admin') throw fail.forbidden();
      return u;
    },
    /** Игрок сервера (или админ): вкладка «Сервер», сборки. */
    player(ctx) {
      const u = need.user(ctx);
      if (u.role !== 'player' && u.role !== 'admin') throw fail.forbidden('Раздел откроется, когда вашу заявку одобрят.');
      return u;
    },
    rate(ctx, name, max, windowMs, message) {
      const wait = limiter.hit(`${name}:${ctx.ip}`, max, windowMs);
      if (wait) throw fail.rateLimited(wait, message);
    },
  };

  /* ------------------------------------------------------------ настройки */

  const SETTINGS_DEFAULTS = {
    serverAddress: '',
    serverVersion: '',
    serverNote: '',
    telegramUrl: '',
    discordUrl: '',
  };
  const settings = {
    all() {
      const out = Object.assign({}, SETTINGS_DEFAULTS);
      for (const row of db.prepare('SELECT key, value FROM settings').all()) if (row.key in out) out[row.key] = row.value;
      return out;
    },
    set(values) {
      const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      for (const [k, v] of Object.entries(values)) if (k in SETTINGS_DEFAULTS) up.run(k, String(v));
    },
    keys: Object.keys(SETTINGS_DEFAULTS),
  };

  const s = { db, config, limiter, views, getUser, startSession, endSession, need, settings, isOwner, ROLE_LABELS };

  /* ------------------------------------------------------------ маршруты */

  const router = new Router();
  registerAuth(router, s);
  registerMe(router, s);
  registerApplications(router, s);
  registerChats(router, s);
  registerAdmin(router, s);
  registerPacks(router, s);

  async function handleApi(req, res, url) {
    const m = router.match(req.method, url.pathname);
    if (!m) throw fail.notFound('Нет такого метода API.');
    if (m.methodNotAllowed) throw new HttpError(405, 'VALIDATION', 'Метод не поддерживается.');
    const ctx = { req, res, url, params: m.params, query: url.searchParams, ip: clientIp(req, config.trustProxy), cookies: parseCookies(req.headers.cookie), user: null, sessionHash: null, body: {} };

    // Защита от CSRF: чужой сайт не может добавить свой заголовок без CORS, а CORS мы не разрешаем.
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      if (req.headers['x-requested-with'] !== 'lwl') throw fail.forbidden('Запрос отклонён.');
      const origin = req.headers.origin;
      if (origin && !sameOrigin(origin, req)) throw fail.forbidden('Запрос с чужого сайта отклонён.');
    }

    authenticate(ctx);
    if (!m.route.raw && req.method !== 'GET' && req.method !== 'HEAD') ctx.body = await readJson(req, 2 * 1024 * 1024);
    const result = await m.route.handler(ctx);
    if (result === HANDLED) return;
    if (result === undefined || result === null) sendJson(res, 204, null);
    else sendJson(res, 200, result);
  }

  function sameOrigin(origin, req) {
    try {
      const host = new URL(origin).host;
      if (host === req.headers.host) return true;
      return !!config.publicUrl && host === new URL(config.publicUrl).host;
    } catch {
      return false;
    }
  }

  async function handler(req, res) {
    securityHeaders(res);
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      try {
        await handleApi(req, res, url);
      } catch (err) {
        if (!(err instanceof HttpError)) console.error(`[${new Date().toISOString()}] ${req.method} ${url.pathname}:`, err);
        if (res.headersSent) res.destroy();
        else {
          sendError(res, err);
          // Тело большого запроса, который мы отклонили, дочитывать не нужно.
          if (!req.complete) req.resume();
        }
      }
      return;
    }
    if ((req.method === 'GET' || req.method === 'HEAD') && serveStatic(req, res, config.staticRoot)) return;
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end('<!doctype html><meta charset="utf-8"><title>Не найдено — LWL</title><p style="font-family:sans-serif">Страница не найдена. <a href="/">На главную</a></p>');
  }

  const server = http.createServer(handler);
  server.requestTimeout = 0; // большие сборки грузятся долго; таймауты держит nginx
  server.headersTimeout = 60_000;
  server.keepAliveTimeout = 65_000;

  return {
    server,
    db,
    close() {
      clearInterval(cleanupTimer);
      limiter.stop();
      return new Promise((resolve) => {
        server.close(() => {
          db.close();
          resolve();
        });
        server.closeAllConnections?.();
      });
    },
  };
}
