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
 * Скин по нику: POST /api/me/skin/nick — сайт спрашивает Mojang (lib/mojang.js), картинку берёт с textures.minecraft.net,
 * на сервер уходит `skin of <ник> set <ник лицензии>` — MineSkin и публичный адрес сайта не нужны.
 * Скин из игры (его присылает мод lwl-stats) сам заменяет свой, если поменялся позже, — карточка следует за игрой.
 * Скина нет нигде — классический Стив (s.skins.defaultSkin(), пока не скачан — запасной из assets).
 *
 * Поза — отдельно для маленькой карточки и окна игрока (looks.card / looks.detail, см. LOOK в lib/validate.js);
 * старое поле pose повторяет позу маленькой карточки. Свой фон — PUT /api/me/background (картинку сжимает кабинет),
 * включается background = 'custom'; админ с правом «Люди» может его убрать (DELETE /api/players/<ник>/background).
 * Так же — свои картинки 16×16 в позе (DELETE /api/players/<ник>/textures: картинки и всё, что на них ссылается).
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { HANDLED, fail } from '../lib/http.js';
import { MojangError } from '../lib/mojang.js';
import { rconCommand, rconConfigured } from '../lib/rcon.js';
import { BG_MAX_BYTES, backgroundMime, checkBackground, isBackgroundName } from '../lib/backgrounds.js';
import { SKIN_MAX_BYTES, isSkinHash, isSkinPng } from '../lib/skins.js';
import { TEX_MAX_BYTES, checkTexture, isTextureHash, lookTextures } from '../lib/textures.js';
import { CARD_BACKGROUNDS, CARD_FIELDS, CARD_POSES, LIMITS, LOOK_VIEWS, SOCIALS, clean, lookSkins, normalizeLook, validate } from '../lib/validate.js';

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

/** Поза для каждого вида; в базе её ещё нет — из старого поля pose (одна на обе). */
function parseLooks(json, pose) {
  const base = { pose: CARD_POSES.includes(pose) ? pose : 'stand', scale: 1, turn: 0 };
  let saved = {};
  try {
    saved = JSON.parse(json || '{}') || {};
  } catch {
    /* испорчено — как будто не настраивали */
  }
  return Object.fromEntries(LOOK_VIEWS.map((v) => [v, normalizeLook(saved[v]) || { ...base }]));
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
      c.bio, c.hidden, c.hide_fields, c.pose, c.looks, c.background, c.bg_file, c.socials, c.skin_hash AS site_skin_hash, c.skin_slim AS site_skin_slim, c.skin_at`;
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
    if (pick) return { skinUrl: `/api/skins/${pick.hash}.png`, skinSlim: pick.slim, skinDefault: false };
    const steve = s.skins.defaultSkin();
    return { skinUrl: steve ? `/api/skins/${steve}.png` : DEFAULT_SKIN, skinSlim: false, skinDefault: true };
  }

  /** Фон: заготовка или своя картинка (если файл есть). */
  function backgroundOf(c) {
    if (c && c.background === 'custom' && isBackgroundName(c.bg_file)) return { background: 'custom', backgroundUrl: `/api/backgrounds/${c.bg_file}` };
    return { background: c && CARD_BACKGROUNDS.includes(c.background) ? c.background : 'meadow', backgroundUrl: null };
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
      looks: parseLooks(row.looks, row.pose),
      ...backgroundOf(row),
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
      looks: parseLooks(c?.looks, c?.pose),
      ...backgroundOf(c),
      // Своя картинка загружена (даже если сейчас выбран другой фон) — её можно вернуть одним нажатием.
      customBackground: c && isBackgroundName(c.bg_file) ? `/api/backgrounds/${c.bg_file}` : null,
      socials: c ? parseSocials(c.socials) : {},
      // Свой скин из кабинета; sync — поставлен ли он на сервере.
      skin:
        c && isSkinHash(c.skin_hash)
          ? { url: `/api/skins/${c.skin_hash}.png`, slim: c.skin_slim === 1, at: c.skin_at, nick: c.skin_nick || null, sync: { status: c.skin_sync || 'off', message: c.skin_sync_note || '' } }
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
    const { bio, hidden, hideFields, pose, background, socials, looks } = ctx.body;
    const f = clean(validate.card({ bio, hidden, hideFields, pose, background, socials, looks }));
    if (Object.keys(f).length) throw fail.validation(f);
    const cur = myCard(user);
    if (background === 'custom' && !cur.customBackground) throw fail.validation({ background: 'Сначала загрузите свою картинку.' });
    // Поза по видам; старое поле pose — поза маленькой карточки.
    const nextLooks = { ...cur.looks };
    for (const view of LOOK_VIEWS) if (looks && looks[view]) nextLooks[view] = normalizeLook(looks[view]);
    // Головы игроков и мобы-игроки: скин с сайта должен лежать у нас (его отдаёт /api/skins/<хеш>.png).
    for (const view of LOOK_VIEWS) {
      if (!(looks && looks[view])) continue;
      if (lookSkins(nextLooks[view]).some((hash) => !fs.existsSync(s.skins.fileOf(hash)))) throw fail.validation({ looks: 'Скин для головы или игрока на сцене не найден — выберите его заново.' });
      if (lookTextures(nextLooks[view]).some((hash) => !s.textures.exists(hash))) throw fail.validation({ looks: 'Своя картинка не найдена на сайте — загрузите её заново.' });
    }
    if (pose !== undefined && !(looks && looks.card)) {
      // Готовая поза вместо своих углов; предметы, блоки и остальное остаются.
      const { angles, ...rest } = nextLooks.card;
      nextLooks.card = { ...rest, pose };
    }
    const nextPose = nextLooks.card.pose === 'custom' ? cur.pose : nextLooks.card.pose;
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
    db.prepare('UPDATE player_cards SET bio = ?, hidden = ?, hide_fields = ?, pose = ?, looks = ?, background = ?, socials = ?, updated_at = ? WHERE user_id = ?').run(
      nextBio,
      nextHidden ? 1 : 0,
      JSON.stringify(nextFields),
      nextPose,
      JSON.stringify(nextLooks),
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
   * Поставить скин на Minecraft-сервере (или сбросить: hash = null). nick — скин взят по нику лицензии:
   * тогда `set <ник>` (мод сам возьмёт подписанный скин у Mojang). Ничего не бросает —
   * результат пишется в player_cards.skin_sync: 'ok' | 'error' | 'off'.
   */
  // Мод отвечает сразу, а MineSkin/Mojang готовят скин несколько секунд — потом спрашиваем у мода, чем кончилось
  // (`/skin of <ник> status`, lwl-skins). «загружается…» — спросим ещё (до 3 раз); старый мод без status — молчим.
  const checks = new Map(); // id пользователя → таймер
  s.onClose(() => {
    for (const t of checks.values()) clearTimeout(t);
  });
  function checkLater(user, tries = 3) {
    clearTimeout(checks.get(user.id));
    const t = setTimeout(async () => {
      checks.delete(user.id);
      let reply;
      try {
        reply = await rconCommand(config.rcon, `skin of ${user.nickname} status`);
      } catch {
        return;
      }
      if (/: загружается/.test(reply)) {
        if (tries > 1) checkLater(user, tries - 1);
        return;
      }
      const m = /: ошибка — ([\s\S]+)/.exec(reply);
      if (m) setSync.run('error', m[1].trim().slice(0, 300), user.id);
    }, config.skinCheckMs);
    t.unref?.();
    checks.set(user.id, t);
  }

  async function syncSkin(user, hash, slim, nick = null) {
    const base = publicBase(config.publicUrl);
    if (!rconConfigured(config.rcon) || (hash && !nick && !base)) {
      const why = !rconConfigured(config.rcon) ? 'Связь сайта с сервером (RCON) не настроена.' : 'У сайта нет публичного адреса (LWL_PUBLIC_URL) — серверу неоткуда скачать скин.';
      setSync.run('off', why, user.id);
      return;
    }
    // В консоль сервера уходит только то, что точно ник Minecraft.
    if (!NICK.test(user.nickname) || (nick && !NICK.test(nick))) {
      setSync.run('error', 'Такой ник в Minecraft невозможен.', user.id);
      return;
    }
    const command = !hash
      ? `skin of ${user.nickname} clear`
      : nick
        ? `skin of ${user.nickname} set ${nick}`
        : `skin of ${user.nickname} url ${base}/api/skins/${hash}.png${slim ? ' slim' : ''}`;
    try {
      const reply = await rconCommand(config.rcon, command);
      // Мод сразу отвечает «Загружаю скин…», а сам скин готовит MineSkin за несколько секунд — дальше консоль не ждём.
      // При сбросе ответ приходит позже (или «не выбран свой скин» — сбрасывать нечего): оба случая — успех.
      // По нику мод так же сразу пишет «Ищу скин лицензии…», а Mojang спрашивает уже без нас.
      const ok = hash ? /Загружаю скин|Ищу скин лицензии|обновлён|теперь как у/.test(reply) : !reply || /сброшен|не выбран свой скин/.test(reply);
      if (ok) {
        setSync.run('ok', '', user.id);
        if (hash) checkLater(user);
        else clearTimeout(checks.get(user.id));
      } else if (/unknown or incomplete command|неизвестная или неполная команда/i.test(reply)) setSync.run('error', 'На сервере нет команды /skin — установлен ли мод LWL Skins?', user.id);
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
      db.prepare("UPDATE player_cards SET skin_hash = ?, skin_slim = ?, skin_at = ?, skin_nick = NULL, skin_sync = 'off', skin_sync_note = NULL WHERE user_id = ?").run(hash, slim ? 1 : 0, Date.now(), user.id);
      await syncSkin(user, hash, slim);
      return myCard(user);
    },
    { raw: true }
  );

  // Скин как у лицензии с этим ником (свой ник тоже можно — «как в лаунчере»).
  router.add('POST', '/api/me/skin/nick', async (ctx) => {
    const user = need.player(ctx);
    need.rate(ctx, 'skin', 20, 10 * 60_000, 'Слишком часто меняете скин. Подождите несколько минут.');
    const nickname = String(ctx.body.nickname ?? '').trim();
    if (!NICK.test(nickname)) throw fail.validation({ nickname: 'Ник Minecraft — латиница, цифры и _, от 3 до 16 символов.' });
    let found;
    try {
      found = await s.mojang.skinOf(nickname);
    } catch (e) {
      if (e instanceof MojangError) throw fail.validation({ nickname: e.message }, e.message);
      throw e;
    }
    if (!found) {
      const msg = `Лицензии с ником ${nickname} нет — скин взять неоткуда. Проверьте написание.`;
      throw fail.validation({ nickname: msg }, msg);
    }
    if (!found.url) {
      const msg = `У ${found.name} стандартный скин Minecraft — своего нет.`;
      throw fail.validation({ nickname: msg }, msg);
    }
    let hash;
    try {
      hash = await s.skins.fetchNow(found.url);
    } catch {
      const msg = 'Не получилось скачать скин у Mojang. Попробуйте через минуту.';
      throw fail.validation({ nickname: msg }, msg);
    }
    ensureCard.run(user.id, Date.now());
    db.prepare("UPDATE player_cards SET skin_hash = ?, skin_slim = ?, skin_at = ?, skin_nick = ?, skin_sync = 'off', skin_sync_note = NULL WHERE user_id = ?").run(hash, found.slim ? 1 : 0, Date.now(), found.name, user.id);
    await syncSkin(user, hash, found.slim, found.name);
    return myCard(user);
  });

  // Скин лицензии по нику — для головы игрока или игрока на сцене студии. Свой скин не меняется; скин хранится
  // как обычно (textures.minecraft.net → LWL_DATA_DIR/skins) и не удаляется, пока на него ссылается чья-то карточка.
  router.add('POST', '/api/skins/nick', async (ctx) => {
    need.player(ctx);
    need.rate(ctx, 'skin-lookup', 30, 10 * 60_000, 'Слишком часто ищете скины. Подождите несколько минут.');
    const nickname = String(ctx.body.nickname ?? '').trim();
    if (!NICK.test(nickname)) throw fail.validation({ nickname: 'Ник Minecraft — латиница, цифры и _, от 3 до 16 символов.' });
    let found;
    try {
      found = await s.mojang.skinOf(nickname);
    } catch (e) {
      if (e instanceof MojangError) throw fail.validation({ nickname: e.message }, e.message);
      throw e;
    }
    if (!found) {
      const msg = `Лицензии с ником ${nickname} нет. Проверьте написание.`;
      throw fail.validation({ nickname: msg }, msg);
    }
    if (!found.url) return { nickname: found.name, skin: found.slim ? 'slim/alex' : 'wide/steve', slim: !!found.slim };
    let hash;
    try {
      hash = await s.skins.fetchNow(found.url);
    } catch {
      const msg = 'Не получилось скачать скин у Mojang. Попробуйте через минуту.';
      throw fail.validation({ nickname: msg }, msg);
    }
    return { nickname: found.name, skin: hash, slim: !!found.slim };
  });

  // Тонкие/обычные руки — тот же скин, на сервер уходит заново (у MineSkin это разные скины).
  router.add('PATCH', '/api/me/skin', async (ctx) => {
    const user = need.player(ctx);
    need.rate(ctx, 'skin', 20, 10 * 60_000, 'Слишком часто меняете скин. Подождите несколько минут.');
    if (typeof ctx.body.slim !== 'boolean') throw fail.validation({ slim: 'Нужно «да» или «нет».' });
    const c = cardOf.get(user.id);
    if (!c || !isSkinHash(c.skin_hash)) throw fail.notFound('Сначала загрузите свой скин.');
    // Руки поменяли — это уже не «как у лицензии», а своя картинка: на сервер уходит по ссылке.
    db.prepare('UPDATE player_cards SET skin_slim = ?, skin_at = ?, skin_nick = NULL WHERE user_id = ?').run(ctx.body.slim ? 1 : 0, Date.now(), user.id);
    await syncSkin(user, c.skin_hash, ctx.body.slim);
    return myCard(user);
  });

  router.add('POST', '/api/me/skin/sync', async (ctx) => {
    const user = need.player(ctx);
    need.rate(ctx, 'skin', 20, 10 * 60_000, 'Слишком часто. Подождите несколько минут.');
    const c = cardOf.get(user.id);
    if (!c || !isSkinHash(c.skin_hash)) throw fail.notFound('Своего скина нет — отправлять нечего.');
    await syncSkin(user, c.skin_hash, c.skin_slim === 1, c.skin_nick);
    return myCard(user);
  });

  router.add('DELETE', '/api/me/skin', async (ctx) => {
    const user = need.player(ctx);
    need.rate(ctx, 'skin', 20, 10 * 60_000, 'Слишком часто. Подождите несколько минут.');
    const c = cardOf.get(user.id);
    if (!c || !isSkinHash(c.skin_hash)) return myCard(user);
    db.prepare('UPDATE player_cards SET skin_hash = NULL, skin_slim = 0, skin_at = NULL, skin_nick = NULL WHERE user_id = ?').run(user.id);
    // Если скин стоял и на сервере, то скин из игры — его же копия: до следующего отчёта мода — стандартный.
    // Не дошёл до сервера — в игре прежний скин, его и показываем сразу.
    if (c.skin_sync === 'ok') db.prepare('UPDATE player_stats SET skin_url = NULL, skin_hash = NULL, skin_changed_at = NULL WHERE nick_key = ?').run(user.nickname.toLowerCase());
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

  /* ------------------------------------------------------------ свой фон */

  const setBackground = db.prepare('UPDATE player_cards SET bg_file = ?, background = ?, updated_at = ? WHERE user_id = ?');

  // Сырое тело — картинка, уже уменьшенная и сжатая кабинетом (WebP). Старый файл удаляется сразу.
  router.add(
    'PUT',
    '/api/me/background',
    async (ctx) => {
      const user = need.player(ctx);
      need.rate(ctx, 'background', 10, 10 * 60_000, 'Слишком часто меняете фон. Подождите несколько минут.');
      const chunks = [];
      let size = 0;
      for await (const chunk of ctx.req) {
        size += chunk.length;
        if (size > BG_MAX_BYTES) throw fail.tooLarge(`Картинка больше ${BG_MAX_BYTES / 1024} КБ даже после сжатия. Выберите другую.`);
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      const checked = checkBackground(data);
      if (checked.error) throw fail.validation({ background: checked.error }, checked.error);
      const name = await s.backgrounds.store(data, checked.ext);
      ensureCard.run(user.id, Date.now());
      const old = cardOf.get(user.id).bg_file;
      setBackground.run(name, 'custom', Date.now(), user.id);
      if (old !== name) s.backgrounds.release(old);
      return myCard(user);
    },
    { raw: true }
  );

  router.add('DELETE', '/api/me/background', (ctx) => {
    const user = need.player(ctx);
    const c = cardOf.get(user.id);
    if (!c || !c.bg_file) return myCard(user);
    setBackground.run(null, c.background === 'custom' ? 'meadow' : c.background, Date.now(), user.id);
    s.backgrounds.release(c.bg_file);
    return myCard(user);
  });

  // Модерация: картинку видят все, даже гости, — админ с правом «Люди» может её убрать.
  router.add('DELETE', '/api/players/:nick/background', (ctx) => {
    need.perm(ctx, 'users');
    const row = byKey.get(String(ctx.params.nick).trim().toLowerCase().slice(0, 32));
    if (!row || !row.user_id) throw fail.notFound('Нет такого игрока.');
    const c = cardOf.get(row.user_id);
    if (c && c.bg_file) {
      setBackground.run(null, c.background === 'custom' ? 'meadow' : c.background, Date.now(), row.user_id);
      s.backgrounds.release(c.bg_file);
    }
    return { player: view(byKey.get(row.nick_key), true) };
  });

  // Модерация своих картинок 16×16 (looks.<вид>.textures): их тоже видят все. Убираем картинки из обоих видов
  // и всё, что на них ссылается (предметы tex1…tex3 в руках/на голове, такие же блоки); остальное остаётся.
  router.add('DELETE', '/api/players/:nick/textures', (ctx) => {
    need.perm(ctx, 'users');
    const row = byKey.get(String(ctx.params.nick).trim().toLowerCase().slice(0, 32));
    if (!row || !row.user_id) throw fail.notFound('Нет такого игрока.');
    const c = cardOf.get(row.user_id);
    if (c) {
      const isTex = (id) => /^tex\d+$/.test(id);
      const looks = parseLooks(c.looks, c.pose);
      let changed = false;
      for (const v of LOOK_VIEWS) {
        const { textures, held, blocks, ...rest } = looks[v];
        const keptHeld = held ? Object.fromEntries(Object.entries(held).filter(([, e]) => e && !isTex(e.id))) : {};
        const keptBlocks = blocks ? blocks.filter((b) => !isTex(b.id)) : [];
        if (textures || Object.keys(keptHeld).length !== Object.keys(held || {}).length || keptBlocks.length !== (blocks || []).length) changed = true;
        looks[v] = { ...rest, ...(Object.keys(keptHeld).length ? { held: keptHeld } : {}), ...(keptBlocks.length ? { blocks: keptBlocks } : {}) };
      }
      if (changed) db.prepare('UPDATE player_cards SET looks = ?, updated_at = ? WHERE user_id = ?').run(JSON.stringify(looks), Date.now(), row.user_id);
    }
    return { player: view(byKey.get(row.nick_key), true) };
  });

  /* ------------------------------------------------------------ свои картинки студии */

  // Сырое тело — PNG в своём разрешении (до 512 точек по стороне; обрезает и кодирует кабинет). → { texture: sha256 }
  // В карточку картинка попадает только при сохранении вида (looks.<вид>.textures); без ссылок файл живёт сутки.
  router.add(
    'PUT',
    '/api/me/textures',
    async (ctx) => {
      need.player(ctx);
      need.rate(ctx, 'texture', 30, 10 * 60_000, 'Слишком много картинок подряд. Подождите несколько минут.');
      const chunks = [];
      let size = 0;
      for await (const chunk of ctx.req) {
        size += chunk.length;
        if (size > TEX_MAX_BYTES) throw fail.tooLarge(`Картинка больше ${TEX_MAX_BYTES / 1024 / 1024} МБ — выберите размер поменьше.`);
        chunks.push(chunk);
      }
      const data = Buffer.concat(chunks);
      const checked = checkTexture(data);
      if (checked.error) throw fail.validation({ texture: checked.error }, checked.error);
      const texture = await s.textures.store(data);
      return { texture, width: checked.width, height: checked.height };
    },
    { raw: true }
  );

  router.add('GET', '/api/textures/:name', (ctx) => {
    const m = /^([0-9a-f]{64})\.png$/.exec(String(ctx.params.name));
    if (!m || !isTextureHash(m[1])) throw fail.notFound();
    let data;
    try {
      data = fs.readFileSync(s.textures.fileOf(m[1]));
    } catch {
      throw fail.notFound();
    }
    const etag = `"${m[1]}"`;
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

  // Публично, как скины: имя — sha256 содержимого, по адресу всегда одна и та же картинка.
  router.add('GET', '/api/backgrounds/:name', (ctx) => {
    const name = String(ctx.params.name);
    if (!isBackgroundName(name)) throw fail.notFound();
    let data;
    try {
      data = fs.readFileSync(s.backgrounds.fileOf(name));
    } catch {
      throw fail.notFound();
    }
    const etag = `"${name}"`;
    const headers = { 'Cache-Control': 'public, max-age=31536000, immutable', ETag: etag, 'X-Content-Type-Options': 'nosniff' };
    if (ctx.req.headers['if-none-match'] === etag) {
      ctx.res.writeHead(304, headers);
      ctx.res.end();
      return HANDLED;
    }
    ctx.res.writeHead(200, { ...headers, 'Content-Type': backgroundMime(name), 'Content-Length': data.length });
    ctx.res.end(ctx.req.method === 'HEAD' ? undefined : data);
    return HANDLED;
  });
}
