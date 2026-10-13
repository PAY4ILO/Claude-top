/**
 * Свои фоны карточек игроков: LWL_DATA_DIR/backgrounds/<sha256>.<webp|jpg|png>, публично по /api/backgrounds/<имя>.
 *
 * Сжимает картинку браузер (кабинет уменьшает до BG_MAX_SIDE и сохраняет в WebP), сервер только проверяет:
 * первые байты — WebP/JPEG/PNG, не больше BG_MAX_BYTES, стороны не больше BG_MAX_SIDE, WebP не анимированный.
 * Ставят другой фон — старый файл сразу удаляется, если на него больше никто не ссылается; остальное подчищает sweep().
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sniffImage } from './files.js';

export const BG_MAX_BYTES = 400 * 1024;
export const BG_MAX_SIDE = 1600;
const EXT = { 'image/webp': 'webp', 'image/jpeg': 'jpg', 'image/png': 'png' };
const MIME = Object.fromEntries(Object.entries(EXT).map(([mime, ext]) => [ext, mime]));
const NAME = /^([0-9a-f]{64})\.(webp|jpg|png)$/;

export const isBackgroundName = (v) => typeof v === 'string' && NAME.test(v);
export const backgroundMime = (name) => MIME[NAME.exec(name)?.[2]] || null;

/** Проверить картинку фона → { ext } или текст ошибки. */
export function checkBackground(b) {
  const img = sniffImage(b);
  if (!img || !EXT[img.mime]) return { error: 'Нужна картинка JPEG, PNG или WebP.' };
  if (!img.width || !img.height) return { error: 'Картинка повреждена.' };
  if (img.width > BG_MAX_SIDE || img.height > BG_MAX_SIDE) return { error: `Картинка больше ${BG_MAX_SIDE} точек по стороне — обновите страницу, кабинет уменьшит её сам.` };
  // VP8X: бит 1 флагов — анимация. Двигающийся фон не нужен: он тяжёлый и мешает читать карточку.
  if (img.mime === 'image/webp' && b.toString('latin1', 12, 16) === 'VP8X' && b[20] & 0x02) return { error: 'Анимированные картинки нельзя.' };
  return { ext: EXT[img.mime] };
}

export function createBackgrounds({ db, dir }) {
  const fileOf = (name) => path.join(dir, name);

  /** Сохранить проверенную картинку под её sha256 → имя файла. */
  async function store(data, ext) {
    const name = `${createHash('sha256').update(data).digest('hex')}.${ext}`;
    const file = fileOf(name);
    if (!fs.existsSync(file)) {
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.promises.writeFile(tmp, data);
      await fs.promises.rename(tmp, file);
    }
    return name;
  }

  const usedBy = db.prepare('SELECT COUNT(*) AS n FROM player_cards WHERE bg_file = ?');

  /** Удалить файл, если на него больше никто не ссылается (вызывать после UPDATE). */
  function release(name) {
    if (!isBackgroundName(name) || usedBy.get(name).n > 0) return;
    try {
      fs.unlinkSync(fileOf(name));
    } catch {
      /* уже удалён */
    }
  }

  return {
    fileOf,
    store,
    release,
    /** Удаляет файлы, на которые никто не ссылается, и брошенные .tmp (раз в час). */
    sweep() {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      const used = new Set(db.prepare('SELECT bg_file FROM player_cards WHERE bg_file IS NOT NULL').all().map((r) => r.bg_file));
      const old = Date.now() - 3600 * 1000;
      for (const name of names) {
        if (used.has(name)) continue;
        try {
          const file = fileOf(name);
          if (fs.statSync(file).mtimeMs < old) fs.unlinkSync(file);
        } catch {
          /* файл уже удалён */
        }
      }
    },
  };
}
