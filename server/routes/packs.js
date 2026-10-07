/**
 * Сборки для лаунчеров (Prism, CurseForge, Modrinth).
 * Админ создаёт карточку, потом загружает файл: PUT /api/admin/packs/:id/file сырым телом
 * (заголовок X-File-Name) — файл пишется потоком на диск, память не забивается даже на гигабайтах.
 * Игроки скачивают GET /api/packs/:id/download (поддерживается докачка через Range).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { tx } from '../db.js';
import { contentDisposition, parseRange, sendFile } from '../lib/files.js';
import { fail } from '../lib/http.js';
import { newId, randomToken } from '../lib/security.js';
import { LAUNCHERS, LIMITS } from '../lib/validate.js';

const str = (v) => (typeof v === 'string' ? v : '');
const EXTENSIONS = { '.zip': 'application/zip', '.mrpack': 'application/x-modrinth-modpack+zip' };

export default function register(router, s) {
  const { db, need, config } = s;
  const dir = path.join(config.dataDir, 'packs');
  const fileOf = (id) => path.join(dir, id.replace(/[^A-Za-z0-9_-]/g, ''));
  const byId = db.prepare('SELECT * FROM packs WHERE id = ?');

  const view = (p) => ({
    id: p.id,
    title: p.title,
    description: p.description,
    launcher: p.launcher,
    version: p.version,
    fileName: p.file_name,
    fileSize: p.file_size,
    sha256: p.file_sha256,
    published: !!p.published,
    sort: p.sort,
    downloads: p.downloads,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
    downloadUrl: p.file_name ? `/api/packs/${encodeURIComponent(p.id)}/download` : null,
  });
  s.packView = view;

  function readFields(body, current) {
    const f = {};
    const out = {};
    if (body.title !== undefined || !current) {
      out.title = str(body.title).trim();
      if (!out.title) f.title = 'Введите название.';
      else if (out.title.length > LIMITS.packTitle.max) f.title = `Максимум ${LIMITS.packTitle.max} символов.`;
    }
    if (body.launcher !== undefined || !current) {
      out.launcher = body.launcher;
      if (!LAUNCHERS.includes(out.launcher)) f.launcher = 'Выберите лаунчер.';
    }
    if (body.description !== undefined) {
      out.description = str(body.description).trim();
      if (out.description.length > LIMITS.packDescription.max) f.description = `Максимум ${LIMITS.packDescription.max} символов.`;
    }
    if (body.version !== undefined) {
      out.version = str(body.version).trim();
      if (out.version.length > LIMITS.packVersion.max) f.version = `Максимум ${LIMITS.packVersion.max} символов.`;
    }
    if (body.sort !== undefined) {
      out.sort = Number(body.sort);
      if (!Number.isInteger(out.sort) || Math.abs(out.sort) > 10000) f.sort = 'Целое число.';
    }
    if (body.published !== undefined) {
      out.published = body.published ? 1 : 0;
      if (out.published && !(current && current.file_name)) f.published = 'Сначала загрузите файл сборки.';
    }
    if (Object.keys(f).length) throw fail.validation(f);
    return out;
  }

  router.add('GET', '/api/admin/packs', (ctx) => {
    need.perm(ctx, 'server');
    return { items: db.prepare('SELECT * FROM packs ORDER BY sort, created_at').all().map(view) };
  });

  router.add('POST', '/api/admin/packs', (ctx) => {
    need.perm(ctx, 'server');
    const v = readFields(Object.assign({}, ctx.body, { published: undefined }), null);
    const now = Date.now();
    const id = newId('p');
    db.prepare('INSERT INTO packs (id, title, description, launcher, version, sort, published, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)').run(
      id,
      v.title,
      v.description || '',
      v.launcher,
      v.version || '',
      v.sort || 0,
      now,
      now
    );
    return { pack: view(byId.get(id)) };
  });

  router.add('PATCH', '/api/admin/packs/:id', (ctx) => {
    need.perm(ctx, 'server');
    const current = byId.get(ctx.params.id);
    if (!current) throw fail.notFound('Сборка не найдена.');
    const v = readFields(ctx.body, current);
    const keys = Object.keys(v);
    if (keys.length) {
      db.prepare(`UPDATE packs SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...keys.map((k) => v[k]), Date.now(), current.id);
    }
    return { pack: view(byId.get(current.id)) };
  });

  router.add('DELETE', '/api/admin/packs/:id', (ctx) => {
    need.perm(ctx, 'server');
    const p = byId.get(ctx.params.id);
    if (!p) throw fail.notFound('Сборка не найдена.');
    db.prepare('DELETE FROM packs WHERE id = ?').run(p.id);
    fs.rm(fileOf(p.id), { force: true }, () => {});
    return null;
  });

  router.add(
    'PUT',
    '/api/admin/packs/:id/file',
    async (ctx) => {
      need.perm(ctx, 'server');
      const p = byId.get(ctx.params.id);
      if (!p) throw fail.notFound('Сборка не найдена.');
      let name;
      try {
        name = path.basename(decodeURIComponent(String(ctx.req.headers['x-file-name'] || '')));
      } catch {
        name = '';
      }
      const ext = path.extname(name).toLowerCase();
      if (!name || name.length > 200 || !EXTENSIONS[ext]) throw fail.validation({ file: 'Нужен файл .zip (Prism, CurseForge) или .mrpack (Modrinth).' });
      const length = Number(ctx.req.headers['content-length']);
      if (!length) throw fail.validation({ file: 'Файл пустой.' });
      if (length > config.maxUploadBytes) throw fail.tooLarge(`Файл больше ${Math.round(config.maxUploadBytes / 1024 / 1024)} МБ.`);

      const tmp = path.join(dir, `.upload-${p.id}-${randomToken(6)}`);
      const hash = crypto.createHash('sha256');
      let size = 0;
      let head = Buffer.alloc(0);
      const counter = new Transform({
        transform(chunk, _enc, cb) {
          size += chunk.length;
          if (size > config.maxUploadBytes) return cb(fail.tooLarge());
          if (head.length < 4) head = Buffer.concat([head, chunk.subarray(0, 4 - head.length)]);
          hash.update(chunk);
          cb(null, chunk);
        },
      });
      try {
        await pipeline(ctx.req, counter, fs.createWriteStream(tmp));
        if (size !== length) throw fail.badRequest('Файл загрузился не полностью. Попробуйте ещё раз.');
        // И .zip, и .mrpack — это zip-архивы: начинаются с «PK\x03\x04».
        if (!head.equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))) throw fail.validation({ file: 'Это не архив сборки (не zip). Проверьте, что выбран правильный файл.' });
        fs.renameSync(tmp, fileOf(p.id));
      } catch (err) {
        fs.rm(tmp, { force: true }, () => {});
        throw err;
      }
      tx(db, () => {
        db.prepare('UPDATE packs SET file_name = ?, file_size = ?, file_sha256 = ?, updated_at = ? WHERE id = ?').run(name, size, hash.digest('hex'), Date.now(), p.id);
      });
      return { pack: view(byId.get(p.id)) };
    },
    { raw: true }
  );

  router.add('GET', '/api/packs/:id/download', (ctx) => {
    const user = need.player(ctx);
    const p = byId.get(ctx.params.id);
    if (!p || !p.file_name || (!p.published && user.role !== 'admin')) throw fail.notFound('Сборка не найдена.');
    const file = fileOf(p.id);
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      throw fail.notFound('Файл сборки пропал с сервера. Сообщите администрации.');
    }
    const range = parseRange(ctx.req.headers.range, stat.size);
    // Скачивание считаем один раз — по запросу с начала файла (докачка не в счёт).
    if (range && range.start === 0) db.prepare('UPDATE packs SET downloads = downloads + 1 WHERE id = ?').run(p.id);
    return sendFile(
      ctx,
      file,
      stat.size,
      {
        'Content-Type': EXTENSIONS[path.extname(p.file_name).toLowerCase()] || 'application/octet-stream',
        'Content-Disposition': contentDisposition('attachment', p.file_name),
        'Cache-Control': 'private, no-store',
      },
      range
    );
  });
}
