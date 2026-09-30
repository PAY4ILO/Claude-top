/**
 * Маленький HTTP-слой без зависимостей: маршруты, JSON, куки, статика, заголовки безопасности.
 * Формат ошибок API: { code, message, fields? } — его понимает assets/js/api.js.
 */
import fs from 'node:fs';
import path from 'node:path';

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.fields = extra.fields || null;
    this.retryAfter = extra.retryAfter || 0;
  }
}

export const fail = {
  validation: (fields, message = 'Проверьте поля формы.') => new HttpError(422, 'VALIDATION', message, { fields }),
  badRequest: (message = 'Неверный запрос.') => new HttpError(400, 'VALIDATION', message),
  credentials: (message = 'Неверный логин или пароль.', fields) => new HttpError(401, 'INVALID_CREDENTIALS', message, { fields }),
  unauthorized: () => new HttpError(401, 'UNAUTHORIZED', 'Сессия истекла. Войдите снова.'),
  forbidden: (message = 'Недостаточно прав.') => new HttpError(403, 'FORBIDDEN', message),
  notFound: (message = 'Не найдено.') => new HttpError(404, 'NOT_FOUND', message),
  conflict: (message = 'Действие уже выполнено или недоступно.', code = 'CONFLICT', fields) => new HttpError(409, code, message, { fields }),
  tooLarge: (message = 'Файл слишком большой.') => new HttpError(413, 'TOO_LARGE', message),
  rateLimited: (seconds, message) => new HttpError(429, 'RATE_LIMITED', message || `Слишком много попыток. Попробуйте через ${seconds} с.`, { retryAfter: seconds }),
};

/** Ответ уже отправлен обработчиком сам (скачивание файла). */
export const HANDLED = Symbol('handled');

/* ---------------------------------------------------------------- маршруты */

export class Router {
  constructor() {
    this.routes = [];
  }

  /** path: '/api/applications/:id' ; opts.raw — не читать тело (загрузка файлов) */
  add(method, pattern, handler, opts = {}) {
    const keys = [];
    const re = new RegExp(
      '^' +
        pattern.replace(/\//g, '\\/').replace(/:(\w+)/g, (_, k) => {
          keys.push(k);
          return '([^\\/]+)';
        }) +
        '$'
    );
    this.routes.push({ method, re, keys, handler, raw: !!opts.raw });
  }

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method && !(method === 'HEAD' && r.method === 'GET')) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

/* ---------------------------------------------------------------- запрос */

export async function readJson(req, limitBytes) {
  const type = String(req.headers['content-type'] || '');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limitBytes) throw fail.tooLarge('Слишком большой запрос.');
    chunks.push(chunk);
  }
  if (!size) return {};
  if (!type.startsWith('application/json')) throw fail.badRequest('Ожидался JSON.');
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : {};
  } catch {
    throw fail.badRequest('Неверный JSON.');
  }
}

export function parseCookies(header) {
  const out = {};
  String(header || '')
    .split(';')
    .forEach((part) => {
      const i = part.indexOf('=');
      if (i < 0) return;
      const k = part.slice(0, i).trim();
      if (!k) return;
      try {
        out[k] = decodeURIComponent(part.slice(i + 1).trim());
      } catch {
        out[k] = part.slice(i + 1).trim();
      }
    });
  return out;
}

export function cookie(name, value, { maxAge, secure, httpOnly = true, sameSite = 'Lax', path: p = '/' } = {}) {
  let s = `${name}=${encodeURIComponent(value)}; Path=${p}; SameSite=${sameSite}`;
  if (httpOnly) s += '; HttpOnly';
  if (secure) s += '; Secure';
  if (maxAge !== undefined) s += `; Max-Age=${Math.floor(maxAge)}`;
  return s;
}

export function clientIp(req, trustProxy) {
  if (trustProxy) {
    const real = req.headers['x-real-ip'];
    if (real) return String(real).trim();
  }
  return (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
}

/* ---------------------------------------------------------------- ответы */

// То же, что в мета-теге страниц, плюс то, что работает только заголовком (frame-ancestors).
const CSP =
  "default-src 'self'; img-src 'self' data: blob:; style-src 'self'; font-src 'self'; script-src 'self'; " +
  "connect-src 'self'; base-uri 'self'; form-action 'self'; object-src 'none'; frame-ancestors 'none'";

export function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', CSP);
}

export function sendJson(res, status, data, headers = {}) {
  const body = data === undefined || data === null ? '' : JSON.stringify(data);
  res.writeHead(status, Object.assign({ 'Cache-Control': 'no-store' }, body ? { 'Content-Type': 'application/json; charset=utf-8' } : {}, headers));
  res.end(body);
}

export function sendError(res, err) {
  if (err instanceof HttpError) {
    const headers = err.retryAfter ? { 'Retry-After': String(err.retryAfter) } : {};
    sendJson(res, err.status, { code: err.code, message: err.message, fields: err.fields || undefined }, headers);
    return;
  }
  sendJson(res, 500, { code: 'SERVER', message: 'Ошибка на сервере. Попробуйте позже.' });
}

/* ---------------------------------------------------------------- статика */

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

// Наружу отдаются только страницы и assets/ — никаких server/, data/, .git и т. п.
const PAGES = new Set(['/index.html', '/lk.html', '/robots.txt']);

export function serveStatic(req, res, root) {
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return false;
  }
  if (pathname === '/') pathname = '/index.html';
  if (!PAGES.has(pathname) && !pathname.startsWith('/assets/')) return false;
  const file = path.join(root, pathname);
  if (!file.startsWith(path.join(root, path.sep)) || pathname.includes('\0')) return false;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  const etag = `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
  const headers = {
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    // Имена файлов без хешей — браузер каждый раз сверяет ETag (быстро, 304 без тела).
    'Cache-Control': pathname.startsWith('/assets/fonts/') ? 'public, max-age=2592000' : 'no-cache',
    ETag: etag,
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return true;
  }
  headers['Content-Length'] = stat.size;
  res.writeHead(200, headers);
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(file).pipe(res);
  return true;
}
