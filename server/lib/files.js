/**
 * Файлы, которые присылают люди: картинка ли это (по первым байтам), безопасное имя файла,
 * заголовок Content-Disposition и отдача с докачкой (Range).
 * Используют сборки (routes/packs.js), вложения чата (routes/attachments.js) и аватары (routes/me.js).
 */
import fs from 'node:fs';
import path from 'node:path';
import { HANDLED } from './http.js';

/** Сколько первых байтов файла хватает, чтобы узнать тип и размер картинки (у JPEG размер бывает после EXIF). */
export const SNIFF_BYTES = 256 * 1024;

/** Какие картинки показываем прямо на странице. SVG сюда не входит: в нём может быть скрипт. */
export const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const NO_SIZE = { width: null, height: null };

/**
 * Картинка ли это — по содержимому, а не по имени и не по типу, который прислал браузер.
 * → { mime, width, height } (ширина и высота — null, если их не нашли в первых байтах) или null.
 * У JPEG с поворотом в EXIF (фото с телефона) ширина и высота — как фото покажет браузер.
 */
export function sniffImage(b) {
  try {
    if (b.length >= 24 && b.subarray(0, 8).equals(PNG_SIGNATURE)) return { mime: 'image/png', ...size(b.readUInt32BE(16), b.readUInt32BE(20)) };
    if (b.length >= 4 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ...jpegSize(b) };
    if (b.length >= 10 && /^GIF8[79]a$/.test(b.toString('latin1', 0, 6))) return { mime: 'image/gif', ...size(b.readUInt16LE(6), b.readUInt16LE(8)) };
    if (b.length >= 16 && b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { mime: 'image/webp', ...webpSize(b) };
  } catch {
    /* обрезанный заголовок — не картинка */
  }
  return null;
}

function size(width, height) {
  return width > 0 && height > 0 && width <= 100000 && height <= 100000 ? { width, height } : NO_SIZE;
}

function webpSize(b) {
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8X' && b.length >= 30) return size(b.readUIntLE(24, 3) + 1, b.readUIntLE(27, 3) + 1);
  if (chunk === 'VP8L' && b.length >= 25 && b[20] === 0x2f) {
    const bits = b.readUInt32LE(21);
    return size((bits & 0x3fff) + 1, ((bits >>> 14) & 0x3fff) + 1);
  }
  if (chunk === 'VP8 ' && b.length >= 30 && b[23] === 0x9d && b[24] === 0x01 && b[25] === 0x2a) return size(b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff);
  return NO_SIZE;
}

/** Размер JPEG — из маркера SOF; по пути читаем поворот из EXIF (5–8 — ширина и высота меняются местами). */
function jpegSize(b) {
  let orientation = 1;
  let i = 2;
  while (i + 4 <= b.length) {
    if (b[i] !== 0xff) return NO_SIZE;
    const marker = b[i + 1];
    if (marker === 0xff) {
      i++;
      continue;
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) return NO_SIZE; // конец или сами данные — размера не было
    const len = b.readUInt16BE(i + 2);
    if (len < 2) return NO_SIZE;
    if (marker === 0xe1 && orientation === 1) orientation = exifOrientation(b.subarray(i + 4, Math.min(b.length, i + 2 + len)));
    // SOF0…SOF15, кроме DHT (C4), JPG (C8) и DAC (CC): точность, высота, ширина
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 9 > b.length) return NO_SIZE;
      const height = b.readUInt16BE(i + 5);
      const width = b.readUInt16BE(i + 7);
      return orientation >= 5 ? size(height, width) : size(width, height);
    }
    i += 2 + len;
  }
  return NO_SIZE;
}

function exifOrientation(seg) {
  try {
    if (seg.length < 14 || seg.toString('latin1', 0, 6) !== 'Exif\0\0') return 1;
    const t = seg.subarray(6);
    const order = t.toString('latin1', 0, 2);
    if (order !== 'II' && order !== 'MM') return 1;
    const le = order === 'II';
    const u16 = (o) => (le ? t.readUInt16LE(o) : t.readUInt16BE(o));
    const u32 = (o) => (le ? t.readUInt32LE(o) : t.readUInt32BE(o));
    const ifd = u32(4);
    const count = u16(ifd);
    for (let k = 0; k < count; k++) {
      const e = ifd + 2 + k * 12;
      if (u16(e) === 0x0112) {
        const v = u16(e + 8);
        return v >= 1 && v <= 8 ? v : 1;
      }
    }
  } catch {
    /* EXIF обрезан или битый — считаем, что без поворота */
  }
  return 1;
}

/**
 * Имя файла от пользователя — только для показа и для «Сохранить как»: без папок, управляющих символов
 * и символов смены направления текста (ими маскируют «фото.jpg» под «…gpj.exe»), не длиннее 120 символов.
 */
export function cleanFileName(raw) {
  let name = String(raw == null ? '' : raw)
    .normalize('NFC')
    .replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .split(/[\\/]/)
    .pop()
    .trim()
    .replace(/^\.+/, '');
  const chars = [...name];
  if (chars.length > 120) {
    const ext = [...path.extname(name)].slice(0, 16).join('');
    name = chars.slice(0, 120 - ext.length).join('').trimEnd() + ext;
  }
  return name || 'файл';
}

/** Content-Disposition с именем файла: ASCII-запасное для старых браузеров + filename* в UTF-8. */
export function contentDisposition(type, name) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `${type}; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

/** Заголовок Range → { start, end, partial }; null — такой диапазон отдать нельзя (ответ 416). */
export function parseRange(header, total) {
  if (!header) return { start: 0, end: total - 1, partial: false };
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header));
  if (!m || (!m[1] && !m[2])) return null;
  let start;
  let end = total - 1;
  if (m[1]) {
    start = Number(m[1]);
    if (m[2]) end = Math.min(Number(m[2]), total - 1);
  } else {
    start = Math.max(total - Number(m[2]), 0);
  }
  if (start > end || start >= total) return null;
  return { start, end, partial: true };
}

/** Отдать файл с диска (с докачкой). headers — тип, имя, кэш; range — если уже разобран (parseRange). */
export function sendFile(ctx, file, total, headers, range = parseRange(ctx.req.headers.range, total)) {
  const { res } = ctx;
  if (!range) {
    res.writeHead(416, { 'Content-Range': `bytes */${total}` });
    res.end();
    return HANDLED;
  }
  const out = Object.assign({ 'Content-Length': Math.max(range.end - range.start + 1, 0), 'Accept-Ranges': 'bytes' }, headers);
  if (range.partial) out['Content-Range'] = `bytes ${range.start}-${range.end}/${total}`;
  res.writeHead(range.partial ? 206 : 200, out);
  if (ctx.req.method === 'HEAD' || total === 0) {
    res.end();
    return HANDLED;
  }
  const stream = fs.createReadStream(file, { start: range.start, end: range.end });
  stream.on('error', () => res.destroy());
  stream.pipe(res);
  return HANDLED;
}
