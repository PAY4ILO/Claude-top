/**
 * Фото и файлы в чате поддержки. Каждый файл — отдельное сообщение (с подписью или без).
 *
 * Загрузка: PUT /api/conversations/:id/attachments сырым телом (как сборки) — файл пишется потоком
 * в LWL_DATA_DIR/attachments/<id>, память не забивается. Заголовки: X-File-Name и X-Caption (подпись,
 * необязательна) — URL-кодированные, X-Client-Id — повтор после обрыва возвращает то же сообщение, без дубля.
 * Права — как у текста (routes/chats.js: canAccess); сообщение игрока открывает закрытое обращение.
 *
 * Скачивание: GET /api/attachments/:id — только тем, кто видит обращение; с докачкой (Range).
 * Картинка — только PNG/JPEG/GIF/WebP, узнанные по первым байтам: такие показываются на странице (inline).
 * Всё остальное (SVG, HTML, «фото.png» с чем угодно внутри) — application/octet-stream и «скачать»:
 * браузер не откроет такой файл на нашем сайте и не выполнит из него скрипт.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tx } from '../db.js';
import { IMAGE_MIMES, SNIFF_BYTES, cleanFileName, contentDisposition, sendFile, sniffImage } from '../lib/files.js';
import { HANDLED, HttpError, fail } from '../lib/http.js';
import { newId, randomToken } from '../lib/security.js';
import { validate } from '../lib/validate.js';

const FILES_PER_MINUTE = 30; // на одного человека
// Не политика страниц сайта (там style-src 'self'), а своя — для самого файла, открытого в отдельной вкладке:
// скрипты не выполнятся ни при каких условиях (sandbox, default-src 'none'), а встроенный просмотрщик картинок
// браузера получит свои inline-стили (иначе Chrome показывает фото без фона и центрирования и ругается в консоль).
const FILE_CSP = "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox";
const DAY = 24 * 3600 * 1000;

export default function register(router, s) {
  const { db, need, config } = s;
  const dir = path.join(config.dataDir, 'attachments');
  const fileOf = (id) => path.join(dir, String(id).replace(/[^A-Za-z0-9_-]/g, ''));
  const byId = db.prepare('SELECT a.*, m.conversation_id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE a.id = ?');

  /** URL-кодированный заголовок → строка; null — если закодирован неправильно. */
  function header(ctx, name) {
    try {
      return decodeURIComponent(String(ctx.req.headers[name] || ''));
    } catch {
      return null;
    }
  }

  s.attachments = {
    /** id файлов обращения / всех обращений игрока — собрать ДО удаления строк (каскад сотрёт их из базы). */
    idsOfConversation: (conversationId) => db.prepare('SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id WHERE m.conversation_id = ?').all(conversationId).map((r) => r.id),
    idsOfPlayer: (userId) =>
      db
        .prepare('SELECT a.id FROM attachments a JOIN messages m ON m.id = a.message_id JOIN conversations c ON c.id = m.conversation_id WHERE c.player_id = ?')
        .all(userId)
        .map((r) => r.id),
    removeFiles(ids) {
      for (const id of ids) {
        try {
          fs.rmSync(fileOf(id), { force: true });
        } catch (err) {
          console.error(`[${new Date().toISOString()}] не удалось удалить вложение ${id}:`, err.message);
        }
      }
    },
    /**
     * Уборка: файлы без строки в базе (сайт упал между записью файла и базой, база восстановлена из бэкапа)
     * и недокачанные загрузки старше суток. Запускается при старте и раз в час.
     */
    sweep() {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      const known = new Set(db.prepare('SELECT id FROM attachments').all().map((r) => r.id));
      const now = Date.now();
      for (const name of names) {
        const file = path.join(dir, name);
        try {
          if (name.startsWith('.')) {
            if (now - fs.statSync(file).mtimeMs > DAY) fs.rmSync(file, { force: true });
          } else if (!known.has(name)) fs.rmSync(file, { force: true });
        } catch {
          /* файл уже убрали */
        }
      }
    },
  };
  s.attachments.sweep();

  router.add(
    'PUT',
    '/api/conversations/:id/attachments',
    async (ctx) => {
      const user = need.user(ctx);
      const c = s.chat.byId(ctx.params.id);
      if (!s.chat.canAccess(user, c)) throw fail.notFound('Обращение не найдено.');
      const clientId = String(ctx.req.headers['x-client-id'] || '').slice(0, 64) || null;
      // Повтор после обрыва, а файл уже дошёл: отдаём то же сообщение, тело не читаем.
      const dup = s.chat.findDuplicate(c.id, user.id, clientId);
      if (dup) {
        ctx.req.resume();
        return { message: s.chat.messageView(dup) };
      }
      const wait = s.limiter.hit(`attach:${user.id}`, FILES_PER_MINUTE, 60_000);
      if (wait) throw fail.rateLimited(wait, 'Слишком много файлов подряд. Подождите минуту.');

      const rawName = header(ctx, 'x-file-name');
      const caption = header(ctx, 'x-caption');
      if (rawName === null || caption === null) throw fail.badRequest('Имя файла или подпись переданы неправильно.');
      const text = caption.trim();
      const captionError = validate.caption(text);
      if (captionError) throw fail.validation({ text: captionError }, captionError);
      const name = cleanFileName(rawName);
      const limit = config.chatMaxFileBytes;
      const length = Number(ctx.req.headers['content-length']);
      if (!length) throw fail.validation({ file: 'Файл пустой.' }, 'Файл пустой.');
      if (length > limit) throw fail.tooLarge(`Файл больше ${Math.round(limit / 1024 / 1024)} МБ — такой не отправить.`);

      const tmp = path.join(dir, `.upload-${randomToken(9)}`);
      let size = 0;
      const head = [];
      let headSize = 0;
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          size += chunk.length;
          if (size > limit) return cb(fail.tooLarge());
          if (headSize < SNIFF_BYTES) {
            const part = chunk.subarray(0, SNIFF_BYTES - headSize);
            head.push(part);
            headSize += part.length;
          }
          cb(null, chunk);
        },
      });
      try {
        await pipeline(ctx.req, counter, fs.createWriteStream(tmp));
        if (size !== length) throw fail.badRequest('Файл загрузился не полностью. Попробуйте ещё раз.');
      } catch (err) {
        fs.rm(tmp, { force: true }, () => {});
        if (err instanceof HttpError) throw err;
        // Человек закрыл вкладку или пропала сеть — это не ошибка сервера.
        if (ctx.req.destroyed || !ctx.req.complete) throw fail.badRequest('Загрузка прервалась. Попробуйте ещё раз.');
        throw err;
      }

      const image = sniffImage(Buffer.concat(head));
      const id = newId('f');
      const attachment = image
        ? { id, name, size, kind: 'image', mime: image.mime, width: image.width, height: image.height }
        : { id, name, size, kind: 'file', mime: 'application/octet-stream', width: null, height: null };
      // Файл на место и строка в базу — без await между ними, чтобы уборка (sweep) не застала файл без строки.
      fs.renameSync(tmp, fileOf(id));
      let message;
      try {
        message = tx(db, () => {
          const cur = s.chat.byId(c.id); // обращение могли удалить, пока файл грузился
          if (!s.chat.canAccess(user, cur)) throw fail.notFound('Обращение не найдено.');
          return s.chat.findDuplicate(cur.id, user.id, clientId) || s.chat.addMessage(user, cur, { text, clientId, attachment });
        });
      } catch (err) {
        s.attachments.removeFiles([id]);
        throw err;
      }
      const view = s.chat.messageView(message);
      // Два одинаковых повтора пришли одновременно: второй файл не нужен.
      if (!view.attachments.some((a) => a.id === id)) s.attachments.removeFiles([id]);
      return { message: view };
    },
    { raw: true }
  );

  router.add('GET', '/api/attachments/:id', (ctx) => {
    const user = need.user(ctx);
    const a = byId.get(ctx.params.id);
    if (!a || !s.chat.canAccess(user, s.chat.byId(a.conversation_id))) throw fail.notFound('Файл не найден.');
    const file = fileOf(a.id);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw fail.notFound('Файл пропал с сервера.');
    }
    // Содержимое по этому id никогда не меняется, но право смотреть может пропасть (удалили обращение,
    // забрали права) — поэтому браузер каждый раз сверяется (no-cache), а сервер отвечает 304 без тела.
    const etag = `"${a.id}"`;
    const headers = {
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': FILE_CSP,
      'Cache-Control': 'private, no-cache',
      ETag: etag,
    };
    if (ctx.req.headers['if-none-match'] === etag) {
      ctx.res.writeHead(304, headers);
      ctx.res.end();
      return HANDLED;
    }
    const inline = a.kind === 'image' && IMAGE_MIMES.includes(a.mime);
    headers['Content-Type'] = inline ? a.mime : 'application/octet-stream';
    headers['Content-Disposition'] = contentDisposition(inline ? 'inline' : 'attachment', a.name);
    return sendFile(ctx, file, stat.size, headers);
  });
}
