/**
 * Карточки игроков в кабинете: статистика с Minecraft-сервера (routes/game.js) + то, что игрок написал о себе.
 * Видят только «Игроки» и админы (need.player); «Пользователю» — 403, без входа — 401. Публично ничего нет.
 * Скрытые карточки не отдаются никому, скрытые поля вырезаются здесь, на сервере.
 * С аккаунтом сайта карточка связана по нику без учёта регистра (users.nickname COLLATE NOCASE).
 */
import fs from 'node:fs';
import { HANDLED, fail } from '../lib/http.js';
import { isSkinHash } from '../lib/skins.js';
import { CARD_FIELDS, LIMITS, clean, validate } from '../lib/validate.js';

export const ONLINE_WINDOW_MS = 150 * 1000; // мод шлёт список раз в минуту; две пропущенные отправки — уже не в сети
export const DEFAULT_SKIN = '/assets/img/skin-default.png';
const SORTS = ['online', 'playtime', 'recent'];
const MAX_LIST = 500;

// Ключ поля, которое можно скрыть → поле в stats.
const STAT_FIELDS = {
  playtime: 'playtimeSec',
  deaths: 'deaths',
  mobKills: 'mobKills',
  playerKills: 'playerKills',
  blocksMined: 'blocksMined',
  distance: 'distanceM',
  advancements: 'advancements',
};

function parseFields(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v.filter((k) => CARD_FIELDS.includes(k)) : [];
  } catch {
    return [];
  }
}

export default function register(router, s) {
  const { db, need } = s;

  const SELECT = `SELECT p.*, u.id AS user_id, u.role AS user_role, u.email AS user_email, u.nickname AS user_nickname, u.avatar_at,
      c.bio, c.hidden, c.hide_fields
    FROM player_stats p
    LEFT JOIN users u ON u.nickname = p.nick_key
    LEFT JOIN player_cards c ON c.user_id = u.id`;

  const isOnline = (row, now) => row.online === 1 && row.presence_at > now - ONLINE_WINDOW_MS;

  /** Карточка, как её видят другие: без скрытых полей. */
  function view(row, now = Date.now()) {
    const hide = new Set(parseFields(row.hide_fields));
    const all = {
      playtimeSec: row.playtime_sec,
      deaths: row.deaths,
      mobKills: row.mob_kills,
      playerKills: row.player_kills,
      blocksMined: row.blocks_mined,
      distanceM: row.distance_m,
      advancements: row.advancements,
    };
    const stats = {};
    for (const [key, field] of Object.entries(STAT_FIELDS)) if (!hide.has(key)) stats[field] = all[field];
    const account = row.user_id ? { id: row.user_id, email: row.user_email, nickname: row.user_nickname, avatar_at: row.avatar_at, role: row.user_role } : null;
    const card = {
      nickname: row.nickname,
      role: account ? account.role : null,
      creator: account ? s.isOwner(account) : false,
      avatar: account && account.avatar_at ? `/api/avatars/${encodeURIComponent(account.id)}?v=${account.avatar_at}` : null,
      skinUrl: isSkinHash(row.skin_hash) ? `/api/skins/${row.skin_hash}` : DEFAULT_SKIN,
      skinSlim: row.skin_slim === 1,
      bio: row.bio || '',
      stats,
      statsAt: row.stats_at,
    };
    // «Когда был в игре» скрыт — не показываем и «в сети»: иначе по нему видно то же самое.
    if (!hide.has('lastSeen')) {
      card.online = isOnline(row, now);
      card.lastSeen = row.last_seen;
    }
    if (!hide.has('firstSeen')) card.firstSeen = row.first_seen;
    return card;
  }

  const byKey = db.prepare(`${SELECT} WHERE p.nick_key = ?`);

  router.add('GET', '/api/players', (ctx) => {
    need.player(ctx);
    const sort = SORTS.includes(ctx.query.get('sort')) ? ctx.query.get('sort') : 'online';
    const search = String(ctx.query.get('q') || '').trim().toLowerCase().slice(0, 32);
    const now = Date.now();
    const cards = db
      .prepare(`${SELECT} WHERE COALESCE(c.hidden, 0) = 0`)
      .all()
      .filter((row) => !search || row.nick_key.includes(search))
      .map((row) => view(row, now));
    const num = (v) => (typeof v === 'number' ? v : -1); // скрытое поле — в конец списка
    const by = {
      // Сначала те, кто в игре, дальше — кто больше наиграл.
      online: (a, b) => (b.online === true) - (a.online === true) || num(b.stats.playtimeSec) - num(a.stats.playtimeSec),
      playtime: (a, b) => num(b.stats.playtimeSec) - num(a.stats.playtimeSec),
      // У тех, кто в игре, lastSeen обновляется раз в минуту — они и так наверху.
      recent: (a, b) => num(b.lastSeen) - num(a.lastSeen),
    }[sort];
    cards.sort((a, b) => by(a, b) || a.nickname.localeCompare(b.nickname));
    return { players: cards.slice(0, MAX_LIST), total: cards.length, onlineWindowMs: ONLINE_WINDOW_MS };
  });

  router.add('GET', '/api/players/:nick', (ctx) => {
    need.player(ctx);
    const row = byKey.get(String(ctx.params.nick).trim().toLowerCase().slice(0, 32));
    // Нет такого и скрыт — один ответ, чтобы по нему нельзя было узнать, что карточка есть.
    if (!row || row.hidden === 1) throw fail.notFound('Карточки нет или игрок её скрыл.');
    return { player: view(row) };
  });

  /* ------------------------------------------------------------ своя карточка */

  function myCard(user) {
    const card = db.prepare('SELECT * FROM player_cards WHERE user_id = ?').get(user.id);
    const row = byKey.get(user.nickname.toLowerCase());
    return {
      bio: card ? card.bio : '',
      hidden: card ? card.hidden === 1 : false,
      hideFields: card ? parseFields(card.hide_fields) : [],
      // Как карточку видят другие (без скрытых полей); null — в игре ещё не был.
      player: row ? view(row) : null,
    };
  }

  router.add('GET', '/api/me/card', (ctx) => myCard(need.player(ctx)));

  router.add('PATCH', '/api/me/card', (ctx) => {
    const user = need.player(ctx);
    need.rate(ctx, 'card', 60, 60_000);
    const { bio, hidden, hideFields } = ctx.body;
    const f = clean(validate.card({ bio, hidden, hideFields }));
    if (Object.keys(f).length) throw fail.validation(f);
    const cur = myCard(user);
    // Переводы строк и прочие управляющие символы — в пробелы: «о себе» — одна строка.
    const nextBio = bio === undefined ? cur.bio : bio.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, LIMITS.cardBio.max);
    const nextHidden = hidden === undefined ? cur.hidden : hidden;
    const nextFields = hideFields === undefined ? cur.hideFields : CARD_FIELDS.filter((k) => hideFields.includes(k));
    db.prepare(
      `INSERT INTO player_cards (user_id, bio, hidden, hide_fields, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET bio = excluded.bio, hidden = excluded.hidden, hide_fields = excluded.hide_fields, updated_at = excluded.updated_at`
    ).run(user.id, nextBio, nextHidden ? 1 : 0, JSON.stringify(nextFields), Date.now());
    return myCard(user);
  });

  /* ------------------------------------------------------------ картинки скинов */

  // Доступ как к карточкам. Имя — sha256 содержимого, поэтому ETag не меняется, пока не сменится скин.
  router.add('GET', '/api/skins/:hash', (ctx) => {
    need.player(ctx);
    const hash = ctx.params.hash;
    if (!isSkinHash(hash)) throw fail.notFound();
    let data;
    try {
      data = fs.readFileSync(s.skins.fileOf(hash));
    } catch {
      throw fail.notFound();
    }
    const etag = `"${hash}"`;
    const headers = { 'Cache-Control': 'private, no-cache', ETag: etag, 'X-Content-Type-Options': 'nosniff' };
    if (ctx.req.headers['if-none-match'] === etag) {
      ctx.res.writeHead(304, headers);
      ctx.res.end();
      return HANDLED;
    }
    ctx.res.writeHead(200, { ...headers, 'Content-Type': 'image/png', 'Content-Length': data.length });
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : data);
    return HANDLED;
  });
}
