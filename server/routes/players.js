/**
 * Карточки игроков: статистика с Minecraft-сервера (routes/game.js) + то, что игрок настроил в кабинете.
 *
 * Карточки видят все, даже без входа: ник, скин, поза, фон, «о себе», соцсети, роль.
 * Вошедшим «Игрокам» и админам («full») — ещё статистика, «в сети», когда был в игре, первый вход.
 * Скрытые карточки не отдаются никому, скрытые поля вырезаются здесь, на сервере.
 * Карточка есть у каждого «Игрока»/админа сайта (даже если он ещё не заходил в игру) и у каждого, кого прислал мод.
 * С аккаунтом сайта она связана по нику без учёта регистра (users.nickname COLLATE NOCASE).
 *
 * Свой скин: PUT /api/me/skin (PNG 64×64 сырым телом) → LWL_DATA_DIR/skins/<sha256>.png, публично по
 * /api/skins/<hash>.png, и сразу на Minecraft-сервер через RCON: `skin of <ник> url <LWL_PUBLIC_URL>/api/skins/<hash>.png [slim]`
 * (мод lwl-skins отдаёт ссылку MineSkin, тот подписывает скин). Нет RCON или адреса сайта — скин только на сайте.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { HANDLED, fail } from '../lib/http.js';
import { rconCommand, rconConfigured } from '../lib/rcon.js';
import { SKIN_MAX_BYTES, isSkinHash, isSkinPng } from '../lib/skins.js';
import { CARD_BACKGROUNDS, CARD_FIELDS, CARD_POSES, LIMITS, SOCIALS, clean, validate } from '../lib/validate.js';

export const ONLINE_WINDOW_MS = 150 * 1000; // мод шлёт список раз в минуту; две пропущенные отправки — уже не в сети
export const DEFAULT_SKIN = '/assets/img/skin-default.png';
const SORTS = ['online', 'playtime', 'recent'];
const MAX_LIST = 500;
const NICK = /^[A-Za-z0-9_]{3,16}$/;

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

function parseSocials(json) {
  try {
    const v = JSON.parse(json || '{}');
    const out = {};
    // Отдаём только то, что и сейчас проходит проверку: правила поменяются — старое не всплывёт ссылкой.
    for (const [key, re] of Object.entries(SOCIALS)) if (typeof v[key] === 'string' && re.test(v[key])) out[key] = v[key];
    return out;
  } catch {
    return {};
  }
}

/** Адрес сайта, который увидит MineSkin; локальный не подходит — скин туда не скачать. */
function publicBase(url) {
  if (!url) return '';
  try {
    const u = new URL(url);
    if (/^(localhost|127\.|0\.0\.0\.0|\[::1\]|10\.|192\.168\.)/.test(u.hostname) || u.hostname.endsWith('.local')) return '';
    return u.origin;
  } catch {
    return '';
  }
}

export default function register(router, s) {
  const { db, need, config } = s;

  // Все карточки: игроки из мода (+ аккаунт сайта, если есть) и «Игроки»/админы сайта, которые в игру ещё не заходили.
  const CARD_COLUMNS = `u.id AS user_id, u.role AS user_role, u.email AS user_email, u.nickname AS user_nickname, u.avatar_at,
      c.bio, c.hidden, c.hide_fields, c.pose, c.background, c.socials, c.skin_hash AS site_skin_hash, c.skin_slim AS site_skin_slim, c.skin_at`;
  const ALL = `
    SELECT p.nick_key, p.nickname, 1 AS has_stats, p.first_seen, p.last_seen, p.online, p.presence_at, p.playtime_sec, p.deaths,
      p.mob_kills, p.player_kills, p.blocks_mined, p.advancements, p.distance_m, p.skin_hash AS game_skin_hash,
      p.skin_slim AS game_skin_slim, p.skin_changed_at, p.stats_at, ${CARD_COLUMNS}
    FROM player_stats p
    LEFT JOIN users u ON u.nickname = p.nick_key
    LEFT JOIN player_cards c ON c.user_id = u.id
    UNION ALL
    SELECT lower(u.nickname), u.nickname, 0, NULL, NULL, 0, NULL, 0, 0, 0, 0, 0, 0, 0, NULL, 0, NULL, NULL, ${CARD_COLUMNS}
    FROM users u
    LEFT JOIN player_cards c ON c.user_id = u.id
    WHERE u.role IN ('player', 'admin') AND NOT EXISTS (SELECT 1 FROM player_stats p WHERE p.nick_key = lower(u.nickname))`;

  const isOnline = (row, now) => row.online === 1 && row.presence_at > now - ONLINE_WINDOW_MS;

  /** Какой скин показать: загруженный в кабинете или из игры — что поменяли позже. */
  function skinOf(row) {
    const site = isSkinHash(row.site_skin_hash) ? { hash: row.site_skin_hash, slim: row.site_skin_slim === 1, at: row.skin_at || 0 } : null;
    const game = isSkinHash(row.game_skin_hash) ? { hash: row.game_skin_hash, slim: row.game_skin_slim === 1, at: row.skin_changed_at || 0 } : null;
    const pick = site && game ? (game.at > site.at ? game : site) : site || game;
    return pick ? { skinUrl: `/api/skins/${pick.hash}.png`, skinSlim: pick.slim } : { skinUrl: DEFAULT_SKIN, skinSlim: false };
  }

  /**
   * Карточка, как её видят другие. full — со статистикой (вошёл «Игрок» или админ).
   * Скрытые поля вырезаются; гостю статистика не отдаётся вовсе.
   */
  function view(row, full, now = Date.now()) {
    const account = row.user_id ? { id: row.user_id, email: row.user_email, nickname: row.user_nickname, role: row.user_role } : null;
    const card = {
      nickname: row.nickname,
      role: account ? account.role : null,
      creator: account ? s.isOwner(account) : false,
      avatar: account && row.avatar_at ? `/api/avatars/${encodeURIComponent(account.id)}?v=${row.avatar_at}` : null,
      ...skinOf(row),
      pose: CARD_POSES.includes(row.pose) ? row.pose : 'stand',
      background: CARD_BACKGROUNDS.includes(row.background) ? row.background : 'meadow',
      bio: row.bio || '',
      socials: parseSocials(row.socials),
    };
    if (!full) return card;
    if (!row.has_stats) {
      card.stats = null; // в игру ещё не заходил
      return card;
    }
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
    card.stats = {};
    for (const [key, field] of Object.entries(STAT_FIELDS)) if (!hide.has(key)) card.stats[field] = all[field];
    card.statsAt = row.stats_at;
    // «Когда был в игре» скрыт — не показываем и «в сети»: иначе по нему видно то же самое.
    if (!hide.has('lastSeen')) {
      card.online = isOnline(row, now);
      card.lastSeen = row.last_seen;
    }
    if (!hide.has('firstSeen')) card.firstSeen = row.first_seen;
    return card;
  }

  /** Видна ли статистика: вошёл «Игрок» или админ. */
  const isFull = (ctx) => !!ctx.user && (ctx.user.role === 'player' || ctx.user.role === 'admin');
  const byKey = db.prepare(`SELECT * FROM (${ALL}) WHERE nick_key = ?`);

  router.add('GET', '/api/players', (ctx) => {
    need.rate(ctx, 'players', 120, 60_000);
    const full = isFull(ctx);
    const sort = full && SORTS.includes(ctx.query.get('sort')) ? ctx.query.get('sort') : 'online';
    const search = String(ctx.query.get('q') || '').trim().toLowerCase().slice(0, 32);
    const now = Date.now();
    const rows = db
      .prepare(`SELECT * FROM (${ALL}) WHERE COALESCE(hidden, 0) = 0`)
      .all()
      .filter((row) => !search || row.nick_key.includes(search));
    const cards = rows.map((row) => view(row, full, now));
    if (full) {
      const num = (v) => (typeof v === 'number' ? v : -1); // скрытое поле и «ещё не заходил» — в конец
      const by = {
        // Сначала те, кто в игре, дальше — кто больше наиграл.
        online: (a, b) => (b.online === true) - (a.online === true) || num(b.stats?.playtimeSec) - num(a.stats?.playtimeSec),
        playtime: (a, b) => num(b.stats?.playtimeSec) - num(a.stats?.playtimeSec),
        // У тех, кто в игре, lastSeen обновляется раз в минуту — они и так наверху.
        recent: (a, b) => num(b.lastSeen) - num(a.lastSeen),
      }[sort];
      cards.sort((a, b) => by(a, b) || a.nickname.localeCompare(b.nickname));
    } else {
      // Гостю — по нику: порядок не должен выдавать, кто в сети или кто больше играет.
      cards.sort((a, b) => a.nickname.localeCompare(b.nickname));
    }
    const out = { players: cards.slice(0, MAX_LIST), total: cards.length, full };
    if (full) {
      out.online = cards.filter((c) => c.online === true).length;
      out.onlineWindowMs = ONLINE_WINDOW_MS;
    }
    return out;
  });

  router.add('GET', '/api/players/:nick', (ctx) => {
    need.rate(ctx, 'players', 120, 60_000);
    const row = byKey.get(String(ctx.params.nick).trim().toLowerCase().slice(0, 32));
    // Нет такого и скрыт — один ответ, чтобы по нему нельзя было узнать, что карточка есть.
    if (!row || row.hidden === 1) throw fail.notFound('Карточки нет или игрок её скрыл.');
    return { player: view(row, isFull(ctx)) };
  });

  // Сколько человек сейчас в игре — для главной, без входа. Только число: кто именно — видно игрокам в кабинете.
  router.add('GET', '/api/online', (ctx) => {
    need.rate(ctx, 'online', 60, 60_000);
    const { n } = db.prepare('SELECT COUNT(*) AS n FROM player_stats WHERE online = 1 AND presence_at > ?').get(Date.now() - ONLINE_WINDOW_MS);
    return { count: n };
  });

  /* ------------------------------------------------------------ своя карточка */

  const cardOf = db.prepare('SELECT * FROM player_cards WHERE user_id = ?');

  function myCard(user) {
    const c = cardOf.get(user.id);
    const row = byKey.get(user.nickname.toLowerCase());
    return {
      bio: c ? c.bio : '',
      hidden: c ? c.hidden === 1 : false,
      hideFields: c ? parseFields(c.hide_fields) : [],
      pose: c && CARD_POSES.includes(c.pose) ? c.pose : 'stand',
      background: c && CARD_BACKGROUNDS.includes(c.background) ? c.background : 'meadow',
      socials: c ? parseSocials(c.socials) : {},
      // Свой скин из кабинета; sync — поставлен ли он на сервере.
      skin:
        c && isSkinHash(c.skin_hash)
          ? { url: `/api/skins/${c.skin_hash}.png`, slim: c.skin_slim === 1, at: c.skin_at, sync: { status: c.skin_sync || 'off', message: c.skin_sync_note || '' } }
          : null,
      // Как карточку видят игроки (со статистикой, без скрытых полей) — даже если она скрыта.
      card: row ? view(row, true) : null,
    };
  }

  /** Строка player_cards есть всегда, когда что-то меняем. */
  const ensureCard = db.prepare('INSERT INTO player_cards (user_id, updated_at) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING');

  router.add('GET', '/api/me/card', (ctx) => myCard(need.player(ctx)));

  router.add('PATCH', '/api/me/card', (ctx) => {
    const user = need.player(ctx);
    need.rate(ctx, 'card', 60, 60_000);
    const { bio, hidden, hideFields, pose, background, socials } = ctx.body;
    const f = clean(validate.card({ bio, hidden, hideFields, pose, background, socials }));
    if (Object.keys(f).length) throw fail.validation(f);
    const cur = myCard(user);
    // Переводы строк и прочие управляющие символы — в пробелы: «о себе» — одна строка.
    const nextBio = bio === undefined ? cur.bio : bio.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, LIMITS.cardBio.max);
    const nextHidden = hidden === undefined ? cur.hidden : hidden;
    const nextFields = hideFields === undefined ? cur.hideFields : CARD_FIELDS.filter((k) => hideFields.includes(k));
    let nextSocials = cur.socials;
    if (socials !== undefined) {
      nextSocials = { ...cur.socials };
      for (const [key, v] of Object.entries(socials)) {
        if (v) nextSocials[key] = v;
        else delete nextSocials[key];
      }
    }
    ensureCard.run(user.id, Date.now());
    db.prepare('UPDATE player_cards SET bio = ?, hidden = ?, hide_fields = ?, pose = ?, background = ?, socials = ?, updated_at = ? WHERE user_id = ?').run(
      nextBio,
      nextHidden ? 1 : 0,
      JSON.stringify(nextFields),
      pose === undefined ? cur.pose : pose,
      background === undefined ? cur.background : background,
      JSON.stringify(nextSocials),
      Date.now(),
      user.id
    );
    return myCard(user);
  });

  /* ------------------------------------------------------------ свой скин */

  const setSync = db.prepare('UPDATE player_cards SET skin_sync = ?, skin_sync_note = ? WHERE user_id = ?');

  /**
   * Поставить скин на Minecraft-сервере (или сбросить: hash = null). Ничего не бросает —
   * результат пишется в player_cards.skin_sync: 'ok' | 'error' | 'off'.
   */
  async function syncSkin(user, hash, slim) {
    const base = publicBase(config.publicUrl);
    if (!rconConfigured(config.rcon) || (hash && !base)) {
      const why = !rconConfigured(config.rcon) ? 'Связь сайта с сервером (RCON) не настроена.' : 'У сайта нет публичного адреса (LWL_PUBLIC_URL) — серверу неоткуда скачать скин.';
      setSync.run('off', why, user.id);
      return;
    }
    // В консоль сервера уходит только то, что точно ник Minecraft.
    if (!NICK.test(user.nickname)) {
      setSync.run('error', 'Такой ник в Minecraft невозможен.', user.id);
      return;
    }
    const command = hash ? `skin of ${user.nickname} url ${base}/api/skins/${hash}.png${slim ? ' slim' : ''}` : `skin of ${user.nickname} clear`;
    try {
      const reply = await rconCommand(config.rcon, command);
      // Мод сразу отвечает «Загружаю скин…», а сам скин готовит MineSkin за несколько секунд — дальше консоль не ждём.
      // При сбросе ответ приходит позже (или «не выбран свой скин» — сбрасывать нечего): оба случая — успех.
      const ok = hash ? /Загружаю скин|обновлён/.test(reply) : !reply || /сброшен|не выбран свой скин/.test(reply);
      if (ok) setSync.run('ok', '', user.id);
      else if (/unknown or incomplete command|неизвестная или неполная команда/i.test(reply)) setSync.run('error', 'На сервере нет команды /skin — установлен ли мод LWL Skins?', user.id);
      else setSync.run('error', reply.slice(0, 300) || 'Сервер Minecraft ничего не ответил.', user.id);
    } catch (e) {
      setSync.run('error', e.message, user.id);
    }
  }

  const skinModel = (ctx) => String(ctx.req.headers['x-skin-model'] || '').toLowerCase() === 'slim';

  router.add(
    'PUT',
    '/api/me/skin',
    async (ctx) => {
      const user = need.player(ctx);
      need.rate(ctx, 'skin', 20, 10 * 60_000, 'Слишком часто меняете скин. Подождите несколько минут.');
      const chunks = [];
      let size = 0;
      for await (const chunk of ctx.req) {
        size += chunk.length;
        if (size > SKIN_MAX_BYTES) throw fail.tooLarge('Файл больше 64 КБ. Скин — маленькая картинка PNG 64×64.');
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      if (!isSkinPng(data)) {
        const msg = 'Это не скин Minecraft: нужна картинка PNG 64×64 (или старая 64×32).';
        throw fail.validation({ skin: msg }, msg);
      }
      const hash = createHash('sha256').update(data).digest('hex');
      await s.skins.store(hash, data);
      const slim = skinModel(ctx);
      ensureCard.run(user.id, Date.now());
      db.prepare("UPDATE player_cards SET skin_hash = ?, skin_slim = ?, skin_at = ?, skin_sync = 'off', skin_sync_note = NULL WHERE user_id = ?").run(hash, slim ? 1 : 0, Date.now(), user.id);
      await syncSkin(user, hash, slim);
      return myCard(user);
    },
    { raw: true }
  );

  // Тонкие/обычные руки — тот же скин, на сервер уходит заново (у MineSkin это разные скины).
  router.add('PATCH', '/api/me/skin', async (ctx) => {
    const user = need.player(ctx);
    need.rate(ctx, 'skin', 20, 10 * 60_000, 'Слишком часто меняете скин. Подождите несколько минут.');
    if (typeof ctx.body.slim !== 'boolean') throw fail.validation({ slim: 'Нужно «да» или «нет».' });
    const c = cardOf.get(user.id);
    if (!c || !isSkinHash(c.skin_hash)) throw fail.notFound('Сначала загрузите свой скин.');
    db.prepare('UPDATE player_cards SET skin_slim = ?, skin_at = ? WHERE user_id = ?').run(ctx.body.slim ? 1 : 0, Date.now(), user.id);
    await syncSkin(user, c.skin_hash, ctx.body.slim);
    return myCard(user);
  });

  router.add('POST', '/api/me/skin/sync', async (ctx) => {
    const user = need.player(ctx);
    need.rate(ctx, 'skin', 20, 10 * 60_000, 'Слишком часто. Подождите несколько минут.');
    const c = cardOf.get(user.id);
    if (!c || !isSkinHash(c.skin_hash)) throw fail.notFound('Своего скина нет — отправлять нечего.');
    await syncSkin(user, c.skin_hash, c.skin_slim === 1);
    return myCard(user);
  });

  router.add('DELETE', '/api/me/skin', async (ctx) => {
    const user = need.player(ctx);
    need.rate(ctx, 'skin', 20, 10 * 60_000, 'Слишком часто. Подождите несколько минут.');
    const c = cardOf.get(user.id);
    if (!c || !isSkinHash(c.skin_hash)) return myCard(user);
    db.prepare('UPDATE player_cards SET skin_hash = NULL, skin_slim = 0, skin_at = NULL WHERE user_id = ?').run(user.id);
    // Скин из игры — тот же, что сняли (MineSkin-копия); до следующего отчёта мода показываем стандартный.
    db.prepare('UPDATE player_stats SET skin_url = NULL, skin_hash = NULL, skin_changed_at = NULL WHERE nick_key = ?').run(user.nickname.toLowerCase());
    await syncSkin(user, null, false);
    return myCard(user);
  });

  /* ------------------------------------------------------------ картинки скинов */

  // Публично: скины видны на карточках всем, а серверу Minecraft (MineSkin) нужна прямая ссылка на .png.
  // Имя — sha256 содержимого, картинка по адресу никогда не меняется.
  router.add('GET', '/api/skins/:hash', (ctx) => {
    const hash = String(ctx.params.hash).replace(/\.png$/, '');
    if (!isSkinHash(hash)) throw fail.notFound();
    let data;
    try {
      data = fs.readFileSync(s.skins.fileOf(hash));
    } catch {
      throw fail.notFound();
    }
    const etag = `"${hash}"`;
    const headers = { 'Cache-Control': 'public, max-age=31536000, immutable', ETag: etag, 'X-Content-Type-Options': 'nosniff' };
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
