/**
 * Статистика с Minecraft-сервера для карточек игроков (мод lwl-stats).
 * Доступ — как у /api/game/codes/*: Authorization: Bearer LWL_GAME_TOKEN (401 — неверный, 503 — не задан),
 * ошибки ровно { code, message } со строчными кодами. Оба маршрута отвечают 204.
 *
 *   POST /api/game/presence { players: [{ nickname, uuid? } | "ник"] } — полный список тех, кто сейчас в игре.
 *        Мод шлёт его при входе/выходе игрока и раз в минуту; при остановке сервера — пустой список.
 *   POST /api/game/stats { players: [{ nickname, uuid?, firstPlayed?, playTimeSec, deaths, mobKills, playerKills,
 *        blocksMined, distanceM, advancements, skin?: { url, slim } }] } — до 50 игроков за раз.
 *
 * Координаты, инвентарь, IP и способ входа (лицензия/пароль) сюда не приходят и не сохраняются.
 */
import { tx } from '../db.js';
import { HttpError, readJson } from '../lib/http.js';

const BODY_LIMIT = 256 * 1024;
const MAX_STATS_PLAYERS = 50;
const MAX_PRESENCE_PLAYERS = 1000;
const NICK = /^[A-Za-z0-9_]{1,16}$/;
const UUID = /^[0-9a-f]{8}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{4}-?[0-9a-f]{12}$/i;
const MAX_COUNT = 1e12; // больше не бывает: 1e12 секунд — это 30 000 лет
const MINECRAFT_RELEASE = Date.UTC(2009, 4, 17);

const bad = (message) => new HttpError(400, 'bad_request', message);

/** Тело запроса игрового сервера: свой лимит и ошибки в формате { code, message } со строчными кодами. */
async function gameBody(ctx) {
  try {
    return await readJson(ctx.req, BODY_LIMIT);
  } catch (e) {
    if (e instanceof HttpError) throw new HttpError(e.status, e.status === 413 ? 'too_large' : 'bad_request', e.message);
    throw e;
  }
}

function nickOf(v, where) {
  if (typeof v !== 'string' || !NICK.test(v)) throw bad(`${where}: ник — латиница, цифры и _, до 16 символов.`);
  return v;
}

function uuidOf(v, where) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'string' || !UUID.test(v)) throw bad(`${where}: uuid в неверном формате.`);
  const hex = v.replace(/-/g, '').toLowerCase();
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function countOf(v, name, where) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > MAX_COUNT) throw bad(`${where}: ${name} — число от 0.`);
  return Math.floor(v);
}

function playersOf(body, max) {
  if (!Array.isArray(body.players)) throw bad('Нужен список players.');
  if (body.players.length > max) throw bad(`Не больше ${max} игроков за раз.`);
  return body.players;
}

export default function register(router, s) {
  const { db, skins } = s;

  router.add(
    'POST',
    '/api/game/presence',
    async (ctx) => {
      s.needGame(ctx);
      const list = playersOf(await gameBody(ctx), MAX_PRESENCE_PLAYERS).map((p, i) => {
        const where = `players[${i}]`;
        if (typeof p === 'string') return { nickname: nickOf(p, where), uuid: null };
        if (!p || typeof p !== 'object') throw bad(`${where}: нужен ник.`);
        return { nickname: nickOf(p.nickname, where), uuid: uuidOf(p.uuid, where) };
      });
      const now = Date.now();
      const inGame = new Set(list.map((p) => p.nickname.toLowerCase()));
      tx(db, () => {
        // Кто был в сети, но в списке его нет — вышел.
        const leave = db.prepare('UPDATE player_stats SET online = 0, last_seen = ? WHERE nick_key = ?');
        for (const row of db.prepare('SELECT nick_key FROM player_stats WHERE online = 1').all()) if (!inGame.has(row.nick_key)) leave.run(now, row.nick_key);
        const here = db.prepare(
          `INSERT INTO player_stats (nick_key, nickname, uuid, first_seen, last_seen, online, presence_at) VALUES (?, ?, ?, ?, ?, 1, ?)
           ON CONFLICT(nick_key) DO UPDATE SET nickname = excluded.nickname, uuid = COALESCE(excluded.uuid, uuid), online = 1, last_seen = excluded.last_seen, presence_at = excluded.presence_at`
        );
        for (const p of list) here.run(p.nickname.toLowerCase(), p.nickname, p.uuid, now, now, now);
      });
      return null;
    },
    { raw: true }
  );

  router.add(
    'POST',
    '/api/game/stats',
    async (ctx) => {
      s.needGame(ctx);
      const now = Date.now();
      // Сначала проверяем всё, потом пишем: неверный игрок — весь запрос отклоняется.
      const rows = playersOf(await gameBody(ctx), MAX_STATS_PLAYERS).map((p, i) => {
        const where = `players[${i}]`;
        if (!p || typeof p !== 'object') throw bad(`${where}: нужен объект игрока.`);
        const nickname = nickOf(p.nickname, where);
        let firstPlayed = null;
        if (p.firstPlayed !== undefined && p.firstPlayed !== null) {
          if (typeof p.firstPlayed !== 'number' || !Number.isFinite(p.firstPlayed)) throw bad(`${where}: firstPlayed — время в миллисекундах.`);
          firstPlayed = Math.floor(p.firstPlayed);
          if (firstPlayed < MINECRAFT_RELEASE || firstPlayed > now + 86_400_000) firstPlayed = null; // часы сервера сбиты — не верим
        }
        let skin = null;
        if (p.skin !== undefined && p.skin !== null) {
          if (typeof p.skin !== 'object' || typeof p.skin.url !== 'string') throw bad(`${where}: skin — { url, slim }.`);
          // Чужой адрес — скин просто не берём, статистику принимаем.
          const url = skins.normalize(p.skin.url);
          if (url) skin = { url, slim: p.skin.slim === true ? 1 : 0 };
        }
        return {
          key: nickname.toLowerCase(),
          nickname,
          uuid: uuidOf(p.uuid, where),
          firstPlayed,
          playtime: countOf(p.playTimeSec, 'playTimeSec', where),
          deaths: countOf(p.deaths, 'deaths', where),
          mobKills: countOf(p.mobKills, 'mobKills', where),
          playerKills: countOf(p.playerKills, 'playerKills', where),
          blocksMined: countOf(p.blocksMined, 'blocksMined', where),
          distance: countOf(p.distanceM, 'distanceM', where),
          advancements: countOf(p.advancements, 'advancements', where),
          skin,
        };
      });
      tx(db, () => {
        const up = db.prepare(
          `INSERT INTO player_stats (nick_key, nickname, uuid, first_seen, last_seen, online, playtime_sec, deaths, mob_kills, player_kills,
             blocks_mined, advancements, distance_m, skin_url, skin_slim, stats_at)
           VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(nick_key) DO UPDATE SET nickname = excluded.nickname, uuid = COALESCE(excluded.uuid, uuid),
             first_seen = MIN(first_seen, excluded.first_seen), playtime_sec = excluded.playtime_sec, deaths = excluded.deaths,
             mob_kills = excluded.mob_kills, player_kills = excluded.player_kills, blocks_mined = excluded.blocks_mined,
             advancements = excluded.advancements, distance_m = excluded.distance_m,
             skin_url = COALESCE(excluded.skin_url, skin_url), skin_slim = CASE WHEN excluded.skin_url IS NULL THEN skin_slim ELSE excluded.skin_slim END,
             stats_at = excluded.stats_at`
        );
        for (const r of rows) {
          up.run(r.key, r.nickname, r.uuid, r.firstPlayed ?? now, now, r.playtime, r.deaths, r.mobKills, r.playerKills, r.blocksMined, r.advancements, r.distance, r.skin ? r.skin.url : null, r.skin ? r.skin.slim : 0, now);
        }
      });
      // Скины качаются в фоне, ответ серверу Minecraft не ждёт.
      for (const r of rows) if (r.skin) skins.want(r.skin.url);
      return null;
    },
    { raw: true }
  );
}
