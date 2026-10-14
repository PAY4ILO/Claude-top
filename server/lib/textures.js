/**
 * Свои картинки игроков для студии (предмет в руке, на голове, блок): LWL_DATA_DIR/textures/<sha256>.png,
 * публично по /api/textures/<sha256>.png. В looks.<вид>.textures хранится только sha256 (старые карточки — ещё
 * PNG 16×16 прямо в data:-адресе, они тоже работают).
 *
 * Картинку обрезает и кодирует в PNG браузер (своё разрешение, до TEX_MAX_SIDE), сервер только проверяет:
 * первые байты — PNG, стороны от 1 до TEX_MAX_SIDE, не больше TEX_MAX_BYTES.
 * Загружают до сохранения карточки, поэтому файл без ссылок живёт сутки — потом его убирает sweep().
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { sniffImage } from './files.js';

export const TEX_MAX_BYTES = 1024 * 1024;
export const TEX_MAX_SIDE = 512;
const HASH = /^[0-9a-f]{64}$/;

export const isTextureHash = (v) => typeof v === 'string' && HASH.test(v);

/** Проверить картинку → { width, height } или { error }. */
export function checkTexture(b) {
  const img = sniffImage(b);
  if (!img || img.mime !== 'image/png') return { error: 'Нужна картинка PNG.' };
  if (!img.width || !img.height) return { error: 'Картинка повреждена.' };
  if (img.width > TEX_MAX_SIDE || img.height > TEX_MAX_SIDE) return { error: `Картинка больше ${TEX_MAX_SIDE} точек по стороне — обновите страницу, кабинет уменьшит её сам.` };
  return { width: img.width, height: img.height };
}

/** sha256 своих картинок, на которые ссылается вид (не data:-адреса). */
export const lookTextures = (look) => (look && Array.isArray(look.textures) ? look.textures.filter(isTextureHash) : []);

export function createTextures({ db, dir }) {
  const fileOf = (hash) => path.join(dir, `${hash}.png`);

  /** Сохранить проверенную картинку под её sha256 → sha256. */
  async function store(data) {
    const hash = createHash('sha256').update(data).digest('hex');
    const file = fileOf(hash);
    if (!fs.existsSync(file)) {
      const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
      await fs.promises.writeFile(tmp, data);
      await fs.promises.rename(tmp, file);
    }
    return hash;
  }

  return {
    fileOf,
    store,
    exists: (hash) => isTextureHash(hash) && fs.existsSync(fileOf(hash)),
    /** Удаляет картинки, на которые не ссылается ни одна карточка, — старше суток (раз в час). */
    sweep() {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      const used = new Set();
      for (const r of db.prepare(`SELECT looks FROM player_cards WHERE looks LIKE '%"textures":%'`).all()) {
        try {
          for (const look of Object.values(JSON.parse(r.looks) || {})) for (const h of lookTextures(look)) used.add(h);
        } catch {
          /* битый JSON — ничего не держит */
        }
      }
      const old = Date.now() - 24 * 3600 * 1000;
      for (const name of names) {
        if (used.has(name.replace(/\.png$/, ''))) continue;
        try {
          const file = path.join(dir, name);
          if (fs.statSync(file).mtimeMs < old) fs.unlinkSync(file);
        } catch {
          /* файл уже удалён */
        }
      }
    },
  };
}
