/**
 * Скины для карточек игроков. Игровой сервер присылает только ссылку на текстуру, картинку сайт качает сам
 * и хранит в LWL_DATA_DIR/skins/<sha256>.png — браузер никогда не ходит к Mojang.
 * Туда же кладутся скины, загруженные в кабинете (routes/players.js → store).
 *
 * Защита от SSRF: принимается ТОЛЬКО https://textures.minecraft.net/texture/<hex> (Mojang в профиле пишет http:// —
 * такую ссылку переводим на https). Никаких редиректов, не больше 64 КБ, тайм-аут, внутри — PNG 64×64 или 64×32.
 * Ошибки скачивания только пишутся в лог: статистика принимается всё равно.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const SKIN_MAX_BYTES = 64 * 1024;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TEXTURE_PATH = /^\/texture\/([0-9a-f]{16,128})$/;
const HASH = /^[0-9a-f]{64}$/;
const RETRY_FAILED_MS = 3600 * 1000; // не получилось скачать — снова пробуем не раньше чем через час
const MAX_QUEUE = 200;
const PARALLEL = 2;

export const isSkinHash = (v) => typeof v === 'string' && HASH.test(v);

/** PNG скина: подпись PNG и размер 64×64 (или старый 64×32) из заголовка IHDR. */
export function isSkinPng(b) {
  if (b.length < 24 || !b.subarray(0, 8).equals(PNG_SIGNATURE) || b.toString('latin1', 12, 16) !== 'IHDR') return false;
  const width = b.readUInt32BE(16);
  const height = b.readUInt32BE(20);
  return width === 64 && (height === 64 || height === 32);
}

/**
 * origin — откуда разрешено качать: на проде всегда https://textures.minecraft.net (config.skinOrigin).
 * Тесты подставляют свой локальный адрес, чтобы не ходить в интернет.
 */
export function createSkins({ db, dir, origin, defaultTexture = null, timeoutMs = 10_000 }) {
  const allowed = new URL(origin);
  const failedAt = new Map(); // url → когда не получилось
  const queue = [];
  const running = new Map(); // url → Promise
  let active = 0;
  let lastLog = 0;

  const log = (msg) => {
    // Не чаще раза в минуту: сервер Mojang недоступен — не засыпать лог.
    if (Date.now() - lastLog < 60_000) return;
    lastLog = Date.now();
    console.warn(`[${new Date().toISOString()}] скины: ${msg}`);
  };

  /** Ссылка из профиля игрока → нормальная ссылка для скачивания или null, если адрес чужой. */
  function normalize(raw) {
    if (typeof raw !== 'string' || raw.length > 300) return null;
    let u;
    try {
      u = new URL(raw);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.hostname !== allowed.hostname || u.port !== allowed.port || u.username || u.password || u.search || u.hash) return null;
    const m = TEXTURE_PATH.exec(u.pathname);
    return m ? `${allowed.origin}/texture/${m[1]}` : null;
  }

  const fileOf = (hash) => path.join(dir, `${hash}.png`);

  // Стив для тех, у кого скина нет. Имя текстуры Mojang и есть sha256 картинки — после первого скачивания
  // файл уже лежит под этим именем, и в сеть больше не ходим. Не скачался — карточки берут запасной из assets.
  let defaultHash = defaultTexture && isSkinHash(defaultTexture) && fs.existsSync(fileOf(defaultTexture)) ? defaultTexture : null;
  let defaultJob = null;
  let defaultFailedAt = 0;
  function loadDefault() {
    if (defaultHash || !defaultTexture) return Promise.resolve(defaultHash);
    if (defaultJob) return defaultJob;
    if (Date.now() - defaultFailedAt < RETRY_FAILED_MS) return Promise.resolve(null);
    defaultJob = download(`${allowed.origin}/texture/${defaultTexture}`)
      .then((hash) => (defaultHash = hash))
      .catch((e) => {
        defaultFailedAt = Date.now();
        log(`стандартный скин — ${e.message}`);
        return null;
      })
      .finally(() => {
        defaultJob = null;
      });
    return defaultJob;
  }
  const hashOfUrl = db.prepare('SELECT skin_hash FROM player_stats WHERE skin_url = ? AND skin_hash IS NOT NULL LIMIT 1');
  const setHash = db.prepare('UPDATE player_stats SET skin_hash = ? WHERE skin_url = ?');

  /** Нужно ли качать: картинки по этой ссылке ещё нет на диске и недавно не было ошибки. */
  function needsDownload(url) {
    const row = hashOfUrl.get(url);
    if (row && fs.existsSync(fileOf(row.skin_hash))) {
      setHash.run(row.skin_hash, url); // у других игроков с этим скином — та же картинка
      return false;
    }
    const failed = failedAt.get(url);
    return !(failed && Date.now() - failed < RETRY_FAILED_MS);
  }

  /** Поставить ссылку в очередь (сразу возвращается). */
  function want(url) {
    if (running.has(url) || queue.includes(url) || !needsDownload(url)) return;
    if (queue.length >= MAX_QUEUE) return;
    queue.push(url);
    pump();
  }

  function pump() {
    while (active < PARALLEL && queue.length) {
      const url = queue.shift();
      active++;
      const job = download(url)
        .then((hash) => {
          failedAt.delete(url);
          setHash.run(hash, url);
        })
        .catch((e) => {
          failedAt.set(url, Date.now());
          if (failedAt.size > 5000) failedAt.clear();
          log(`${url} — ${e.message}`);
        })
        .finally(() => {
          active--;
          running.delete(url);
          pump();
        });
      running.set(url, job);
    }
  }

  async function download(url) {
    const res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'LWL-site (skins for player cards)' } });
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new Error(`ответ ${res.status}`);
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body) {
      size += chunk.length;
      if (size > SKIN_MAX_BYTES) throw new Error('больше 64 КБ');
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    if (!isSkinPng(data)) throw new Error('не PNG 64×64 / 64×32');
    const hash = createHash('sha256').update(data).digest('hex');
    await store(hash, data);
    return hash;
  }

  /** Сохранить проверенную картинку под её sha256 (скачанную или загруженную в кабинете). */
  async function store(hash, data) {
    const file = fileOf(hash);
    if (fs.existsSync(file)) return;
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    await fs.promises.writeFile(tmp, data);
    await fs.promises.rename(tmp, file);
  }

  /** Скачать текстуру сейчас (скин по нику из кабинета): только textures.minecraft.net, иначе ошибка. → sha256. */
  async function fetchNow(raw) {
    const url = normalize(raw);
    if (!url) throw new Error('ссылка не на textures.minecraft.net');
    return download(url);
  }

  return {
    normalize,
    want,
    fetchNow,
    store,
    fileOf,
    /** sha256 стандартного скина или null (ещё не скачан — тогда запускает скачивание в фоне). */
    defaultSkin() {
      if (!defaultHash) loadDefault();
      return defaultHash;
    },
    /** Дождаться стандартного скина (тесты, инструменты). */
    loadDefault,
    /** Для тестов: дождаться, пока очередь скачается. */
    async idle() {
      while (running.size || queue.length) await Promise.allSettled([...running.values()]);
    },
    /** Удаляет с диска картинки, на которые больше никто не ссылается (раз в час). */
    sweep() {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      const used = new Set(
        db
          .prepare('SELECT skin_hash FROM player_stats WHERE skin_hash IS NOT NULL UNION SELECT skin_hash FROM player_cards WHERE skin_hash IS NOT NULL')
          .all()
          .map((r) => r.skin_hash)
      );
      if (defaultHash) used.add(defaultHash);
      const old = Date.now() - 24 * 3600 * 1000;
      for (const name of names) {
        const hash = name.replace(/\.png$/, '');
        try {
          const file = path.join(dir, name);
          if (!used.has(hash) && fs.statSync(file).mtimeMs < old) fs.unlinkSync(file);
        } catch {
          /* файл уже удалён */
        }
      }
    },
  };
}
