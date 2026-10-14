/**
 * Проверка данных на сервере. Правила ДОЛЖНЫ совпадать с validate/LIMITS в assets/js/api.js
 * (там те же проверки для мгновенных подсказок в форме). Меняете одно — меняйте и другое.
 */
import { readFileSync } from 'node:fs';

export const LIMITS = {
  nickname: { min: 3, max: 16, pattern: /^[A-Za-z0-9_]+$/ },
  password: { min: 8, max: 128 },
  email: { max: 254 },
  message: { max: 2000 },
  about: { min: 30, max: 1000 },
  contact: { max: 64 },
  reviewComment: { min: 5, max: 500 },
  avatarBytes: 400 * 1024,
  age: { min: 10, max: 99 },
  packTitle: { max: 80 },
  packDescription: { max: 1000 },
  packVersion: { max: 40 },
  setting: { max: 1000 },
  cardBio: { max: 140 },
};

export const APPLICATION_SOURCES = ['Друзья', 'YouTube', 'TikTok', 'Telegram', 'Другое'];
export const LICENSES = ['premium', 'cracked'];
export const ROLES = ['user', 'player', 'admin'];
export const LAUNCHERS = ['prism', 'curseforge', 'modrinth', 'other'];
// Что игрок может скрыть на своей карточке (PATCH /api/me/card → hideFields).
export const CARD_FIELDS = ['playtime', 'deaths', 'mobKills', 'playerKills', 'blocksMined', 'distance', 'advancements', 'firstSeen', 'lastSeen'];
// Поза персонажа и фон карточки (рисует assets/js/skin3d.js и assets/css/players.css).
export const CARD_POSES = ['stand', 'wave', 'walk', 'cheer', 'point', 'sit'];
export const CARD_BACKGROUNDS = ['meadow', 'night', 'sunset', 'ocean', 'cave', 'snow', 'nether', 'end'];

/**
 * Как стоит персонаж — отдельно на маленькой карточке (card) и в окне игрока (detail).
 * { pose: ключ позы | 'custom', angles: { head, body, rightArm, leftArm, rightLeg, leftLeg: [x, y, z], lift, move?, stretch? } (только у custom;
 *   move — сдвиг частей { часть: [x, y, z] }, stretch — растяжение частей { часть: [x, y, z] }, 1 — как есть),
 *   scale — приближение камеры карточки, offset — сдвиг кадра [x, y],
 *   camera — камера вида { yaw, pitch } в градусах; есть она — turn поворачивает только фигуру, нет (старые виды) —
 *     turn поворачивает камеру вокруг сцены, как было раньше,
 *   pos — где стоит фигура [x, y, z] (16 = блок), size — размер фигуры (только её: блоки и мобы не меняются),
 *   held — что в руках и на голове: { rightHand, leftHand, head: { id, rot: [x, y, z], size, at: [x, y, z], skin? } },
 *   blocks — блоки вокруг: [{ id, at: [x, y, z] (низ-центр, 16 = блок), rot — поворот вокруг вертикали, size, skin? }],
 *   mobs — мобы и другие игроки: [{ type, at, rot, size, pose?, skin?, slim? }] (модели — assets/js/mc-mobs.js),
 *   textures — свои картинки игрока 16×16 (data:image/png), в held и blocks это id tex1…tex3 }.
 * id предметов и блоков — из assets/js/mc-index.json (оглавление client.jar, собирает tools/mc-index.mjs), плюс головы
 * (LOOK_HEADS). skin — у головы игрока и моба «игрок»: sha256 скина с сайта или стандартный скин игры ('wide/steve').
 * Те же правила — в assets/js/api.js (LOOK).
 */
export const LOOK_VIEWS = ['card', 'detail'];
export const LOOK_PARTS = ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'];
export const LOOK_HELD = ['rightHand', 'leftHand', 'head'];
export const LOOK_HEADS = ['skeleton_skull', 'wither_skeleton_skull', 'zombie_head', 'creeper_head', 'piglin_head', 'dragon_head', 'player_head'];
export const LOOK_MOBS = ['player', 'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'wither_skeleton', 'creeper', 'enderman', 'spider', 'cave_spider', 'slime', 'piglin', 'zombified_piglin', 'witch', 'villager', 'iron_golem', 'snow_golem', 'pig', 'cow', 'sheep', 'chicken', 'wolf'];
export const LOOK_MOB_POSES = ['stand', 'walk', 'wave', 'cheer', 'point', 'sit', 'zombie'];
// Стандартные скины игры (client.jar, textures/entity/player/…) или скин с сайта (sha256 файла в LWL_DATA_DIR/skins).
export const LOOK_SKIN = /^((wide|slim)\/(steve|alex|ari|efe|kai|makena|noor|sunny|zuri)|[0-9a-f]{64})$/;
export const LOOK = {
  angle: 180,
  lift: [-64, 64],
  scale: [0.05, 20],
  turn: 180,
  offset: 2000,
  pitch: 90, // наклон камеры вида
  size: [0.05, 20], // размер фигуры
  world: { side: 1024, y: [-1024, 1024] }, // где может стоять фигура (pos)
  move: 256, // сдвиг части тела (angles.move), единицы модели
  stretch: [0.05, 20], // растяжение части тела (angles.stretch) по каждой оси
  held: { rot: 180, size: [0.1, 8], at: 128 },
  blocks: { max: 64, side: 1024, y: [-1024, 1024], size: [0.1, 8] },
  mobs: { max: 16, side: 1024, y: [-1024, 1024], size: [0.1, 8] },
  textures: { max: 3, chars: 4096, side: 16 },
};

// Какие блоки и предметы бывают — из оглавления игры (файл в репозитории, сеть не нужна).
let mcIds = null;
function mcKnown() {
  if (!mcIds) {
    mcIds = { blocks: new Set(), items: new Set() };
    try {
      const ix = JSON.parse(readFileSync(new URL('../../assets/js/mc-index.json', import.meta.url), 'utf8'));
      for (const [id] of ix.blocks) mcIds.blocks.add(id);
      for (const [id] of ix.items) mcIds.items.add(id);
    } catch {
      // Нет оглавления — разрешены только свои картинки.
    }
  }
  return mcIds;
}

/** Своя картинка: PNG 16×16 в data:-адресе. */
function textureOk(v) {
  if (typeof v !== 'string' || v.length > LOOK.textures.chars) return false;
  const m = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(v);
  if (!m) return false;
  const b = Buffer.from(m[1], 'base64');
  const png = b.length > 24 && b.readUInt32BE(0) === 0x89504e47 && b.readUInt32BE(4) === 0x0d0a1a0a && b.toString('latin1', 12, 16) === 'IHDR';
  return png && b.readUInt32BE(16) === LOOK.textures.side && b.readUInt32BE(20) === LOOK.textures.side;
}

const inRange = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** Углы своей позы (персонаж и игрок на сцене): части тела, подъём, сдвиг и растяжение частей. Ошибка или ''. */
function anglesError(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return 'Для своей позы нужны углы.';
  for (const part of LOOK_PARTS) {
    const r = a[part];
    if (!Array.isArray(r) || r.length !== 3 || r.some((x) => !inRange(x, -LOOK.angle, LOOK.angle))) return `Углы — от −${LOOK.angle}° до ${LOOK.angle}°.`;
  }
  if (a.lift !== undefined && !inRange(a.lift, ...LOOK.lift)) return 'Неверная высота.';
  if (a.move !== undefined) {
    if (!a.move || typeof a.move !== 'object' || Array.isArray(a.move)) return 'Неверный сдвиг частей тела.';
    for (const [part, m] of Object.entries(a.move)) {
      if (!LOOK_PARTS.includes(part)) return 'Неверный сдвиг частей тела.';
      if (!Array.isArray(m) || m.length !== 3 || m.some((x) => !inRange(x, -LOOK.move, LOOK.move))) return `Сдвиг части тела — от −${LOOK.move} до ${LOOK.move}.`;
    }
  }
  if (a.stretch !== undefined) {
    if (!a.stretch || typeof a.stretch !== 'object' || Array.isArray(a.stretch)) return 'Неверный размер частей тела.';
    for (const [part, k] of Object.entries(a.stretch)) {
      if (!LOOK_PARTS.includes(part)) return 'Неверный размер частей тела.';
      if (!Array.isArray(k) || k.length !== 3 || k.some((x) => !inRange(x, ...LOOK.stretch))) return `Размер части тела — от ${LOOK.stretch[0]} до ${LOOK.stretch[1]}.`;
    }
  }
  return '';
}

/** Углы своей позы к хранимому виду: округлить, нулевые сдвиги и растяжения «как есть» выбросить. */
function normalizeAngles(a) {
  const round = (x, k = 1) => Math.round(x * k) / k;
  const out = { lift: a.lift === undefined ? 0 : round(a.lift) };
  for (const part of LOOK_PARTS) out[part] = a[part].map((x) => round(x));
  const move = {};
  for (const part of LOOK_PARTS) {
    const m = a.move && a.move[part];
    if (m && m.some((x) => round(x, 10))) move[part] = m.map((x) => round(x, 10));
  }
  if (Object.keys(move).length) out.move = move;
  const stretch = {};
  for (const part of LOOK_PARTS) {
    const k = a.stretch && a.stretch[part];
    if (k && k.some((x) => round(x, 100) !== 1)) stretch[part] = k.map((x) => round(x, 100));
  }
  if (Object.keys(stretch).length) out.stretch = stretch;
  return out;
}

/** Ошибка в одном виде (look) или ''. */
function lookError(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'Нужны настройки позы.';
  if (v.pose !== 'custom' && !CARD_POSES.includes(v.pose)) return 'Такой позы нет.';
  if (v.scale !== undefined && !inRange(v.scale, ...LOOK.scale)) return `Размер — от ${LOOK.scale[0]} до ${LOOK.scale[1]}.`;
  if (v.turn !== undefined && !inRange(v.turn, -LOOK.turn, LOOK.turn)) return `Поворот — от −${LOOK.turn}° до ${LOOK.turn}°.`;
  if (v.pose === 'custom') {
    const err = anglesError(v.angles);
    if (err) return err;
  }
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const vec = (x, n, check) => Array.isArray(x) && x.length === n && x.every((k, i) => check(k, i));
  if (v.offset !== undefined && !vec(v.offset, 2, (k) => inRange(k, -LOOK.offset, LOOK.offset))) return `Сдвиг — от −${LOOK.offset} до ${LOOK.offset}.`;
  if (v.camera !== undefined && (!isObj(v.camera) || !inRange(v.camera.yaw, -180, 180) || !inRange(v.camera.pitch, -LOOK.pitch, LOOK.pitch))) return `Камера: поворот от −180° до 180°, наклон от −${LOOK.pitch}° до ${LOOK.pitch}°.`;
  const W = LOOK.world;
  if (v.pos !== undefined && !vec(v.pos, 3, (k, i) => (i === 1 ? inRange(k, ...W.y) : inRange(k, -W.side, W.side)))) return 'Персонаж слишком далеко.';
  if (v.size !== undefined && !inRange(v.size, ...LOOK.size)) return `Размер персонажа — от ${LOOK.size[0]} до ${LOOK.size[1]}.`;
  if (v.textures !== undefined) {
    if (!Array.isArray(v.textures) || v.textures.length > LOOK.textures.max) return `Своих картинок — не больше ${LOOK.textures.max}.`;
    if (!v.textures.every(textureOk)) return 'Своя картинка — PNG 16×16.';
  }
  const known = mcKnown();
  const texCount = Array.isArray(v.textures) ? v.textures.length : 0;
  const tex = (id) => /^tex[1-3]$/.test(id) && Number(id.slice(3)) <= texCount;
  const head = (id) => LOOK_HEADS.includes(id);
  // Скин — только у головы игрока; без него — Стив.
  const skinOk = (e) => e.skin === undefined || (e.id === 'player_head' && typeof e.skin === 'string' && LOOK_SKIN.test(e.skin));
  if (v.held !== undefined) {
    if (!isObj(v.held)) return 'Неверные предметы в руках.';
    const H = LOOK.held;
    for (const [slot, e] of Object.entries(v.held)) {
      if (!LOOK_HELD.includes(slot)) return 'Предмет можно держать только в руках или на голове.';
      if (e === null) continue;
      if (!isObj(e) || typeof e.id !== 'string') return 'Неверный предмет.';
      if (!known.items.has(e.id) && !known.blocks.has(e.id) && !tex(e.id) && !head(e.id)) return 'Такого предмета нет.';
      if (!skinOk(e)) return 'Неверный скин головы.';
      if (e.rot !== undefined && !vec(e.rot, 3, (k) => inRange(k, -H.rot, H.rot))) return `Поворот предмета — от −${H.rot}° до ${H.rot}°.`;
      if (e.size !== undefined && !inRange(e.size, ...H.size)) return `Размер предмета — от ${H.size[0]} до ${H.size[1]}.`;
      if (e.at !== undefined && !vec(e.at, 3, (k) => inRange(k, -H.at, H.at))) return 'Предмет слишком далеко от руки.';
    }
  }
  if (v.blocks !== undefined) {
    const B = LOOK.blocks;
    if (!Array.isArray(v.blocks) || v.blocks.length > B.max) return `Блоков — не больше ${B.max}.`;
    for (const b of v.blocks) {
      if (!isObj(b) || typeof b.id !== 'string' || (!known.blocks.has(b.id) && !tex(b.id) && !head(b.id))) return 'Такого блока нет.';
      if (!skinOk(b)) return 'Неверный скин головы.';
      if (!vec(b.at, 3, (k, i) => (i === 1 ? inRange(k, ...B.y) : inRange(k, -B.side, B.side)))) return 'Блок слишком далеко.';
      if (b.rot !== undefined && !inRange(b.rot, -180, 180)) return 'Поворот блока — от −180° до 180°.';
      if (b.size !== undefined && !inRange(b.size, ...B.size)) return `Размер блока — от ${B.size[0]} до ${B.size[1]}.`;
    }
  }
  if (v.mobs !== undefined) {
    const M = LOOK.mobs;
    if (!Array.isArray(v.mobs) || v.mobs.length > M.max) return `Мобов — не больше ${M.max}.`;
    for (const m of v.mobs) {
      if (!isObj(m) || !LOOK_MOBS.includes(m.type)) return 'Такого моба нет.';
      if (!vec(m.at, 3, (k, i) => (i === 1 ? inRange(k, ...M.y) : inRange(k, -M.side, M.side)))) return 'Моб слишком далеко.';
      // Поворот моба — [x, y, z] (старые карточки: одно число — вокруг вертикали).
      if (m.rot !== undefined && !(inRange(m.rot, -180, 180) || vec(m.rot, 3, (k) => inRange(k, -180, 180)))) return 'Поворот моба — от −180° до 180°.';
      if (m.size !== undefined && !inRange(m.size, ...M.size)) return `Размер моба — от ${M.size[0]} до ${M.size[1]}.`;
      // Своя поза (как у персонажа: каждая часть тела) — только у игрока на сцене.
      if (m.pose === 'custom') {
        if (m.type !== 'player') return 'Свою позу можно задать только игроку.';
        const err = anglesError(m.angles);
        if (err) return err;
      } else if (m.pose !== undefined && !LOOK_MOB_POSES.includes(m.pose)) return 'Такой позы у моба нет.';
      if (m.skin !== undefined && (m.type !== 'player' || typeof m.skin !== 'string' || !LOOK_SKIN.test(m.skin))) return 'Неверный скин игрока.';
      if (m.slim !== undefined && typeof m.slim !== 'boolean') return 'Неверный скин игрока.';
    }
  }
  return '';
}

/** Скины с сайта (sha256), на которые ссылается вид: головы игроков и мобы-игроки. */
export function lookSkins(v) {
  const out = new Set();
  const add = (s) => typeof s === 'string' && /^[0-9a-f]{64}$/.test(s) && out.add(s);
  if (v && typeof v === 'object') {
    for (const e of Object.values(v.held || {})) if (e) add(e.skin);
    for (const b of v.blocks || []) if (b) add(b.skin);
    for (const m of v.mobs || []) if (m) add(m.skin);
  }
  return [...out];
}

/** Привести вид к хранимому: округлить, лишнее выбросить. Неверный → null. */
export function normalizeLook(v) {
  if (lookError(v)) return null;
  const round = (x, k = 1) => Math.round(x * k) / k;
  const out = { pose: v.pose, scale: v.scale === undefined ? 1 : round(v.scale, 100), turn: v.turn === undefined ? 0 : round(v.turn) };
  if (v.pose === 'custom') out.angles = normalizeAngles(v.angles);
  const offset = v.offset ? v.offset.map((x) => round(x, 10)) : null;
  if (offset && offset.some((x) => x)) out.offset = offset;
  if (v.camera) out.camera = { yaw: round(v.camera.yaw), pitch: round(v.camera.pitch) };
  const pos = v.pos ? v.pos.map((x) => round(x, 10)) : null;
  if (pos && pos.some((x) => x)) out.pos = pos;
  if (v.size !== undefined && round(v.size, 100) !== 1) out.size = round(v.size, 100);
  if (v.textures && v.textures.length) out.textures = [...v.textures];
  const withSkin = (o, e) => (typeof e.skin === 'string' ? { ...o, skin: e.skin } : o);
  if (v.held) {
    const held = {};
    for (const slot of LOOK_HELD) {
      const e = v.held[slot];
      if (!e) continue;
      held[slot] = withSkin({ id: e.id, rot: (e.rot || [0, 0, 0]).map((x) => round(x)), size: e.size === undefined ? 1 : round(e.size, 100), at: (e.at || [0, 0, 0]).map((x) => round(x, 10)) }, e);
    }
    if (Object.keys(held).length) out.held = held;
  }
  if (v.blocks && v.blocks.length) out.blocks = v.blocks.map((b) => withSkin({ id: b.id, at: b.at.map((x) => round(x, 10)), rot: b.rot === undefined ? 0 : round(b.rot), size: b.size === undefined ? 1 : round(b.size, 100) }, b));
  if (v.mobs && v.mobs.length) {
    out.mobs = v.mobs.map((m) => {
      const rot = Array.isArray(m.rot) ? m.rot.map((x) => round(x)) : [0, m.rot === undefined ? 0 : round(m.rot), 0];
      let o = withSkin({ type: m.type, at: m.at.map((x) => round(x, 10)), rot, size: m.size === undefined ? 1 : round(m.size, 100), pose: m.pose || 'stand' }, m);
      if (m.type === 'player' && m.slim) o = { ...o, slim: true };
      if (m.pose === 'custom') o.angles = normalizeAngles(m.angles);
      return o;
    });
  }
  return out;
}
// Соцсети на карточке: хранится только ник, ссылку собирает страница — чужой адрес в карточку не попадёт.
export const SOCIALS = {
  telegram: /^[A-Za-z][A-Za-z0-9_]{4,31}$/,
  discord: /^[A-Za-z0-9_.]{2,32}(#\d{4})?$/,
  youtube: /^[A-Za-z0-9_.-]{3,30}$/,
  twitch: /^[A-Za-z0-9_]{3,25}$/,
  vk: /^[A-Za-z0-9_.]{2,32}$/,
  tiktok: /^[A-Za-z0-9_.]{2,24}$/,
};

const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

export const validate = {
  nickname(v) {
    v = str(v).trim();
    if (!v) return 'Введите никнейм.';
    if (v.length < LIMITS.nickname.min || v.length > LIMITS.nickname.max) return `От ${LIMITS.nickname.min} до ${LIMITS.nickname.max} символов.`;
    if (!LIMITS.nickname.pattern.test(v)) return 'Только латиница, цифры и «_», как в Minecraft.';
    return '';
  },
  email(v) {
    v = str(v).trim();
    if (!v) return 'Введите почту.';
    if (v.length > LIMITS.email.max || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return 'Почта выглядит неправильно.';
    return '';
  },
  password(v) {
    v = str(v);
    if (!v) return 'Введите пароль.';
    if (v.length < LIMITS.password.min) return `Минимум ${LIMITS.password.min} символов.`;
    if (v.length > LIMITS.password.max) return `Максимум ${LIMITS.password.max} символов.`;
    if (!/[A-Za-zА-Яа-яЁё]/.test(v) || !/\d/.test(v)) return 'Нужны хотя бы одна буква и одна цифра.';
    return '';
  },
  message(v) {
    v = str(v).trim();
    if (!v) return 'Сообщение пустое.';
    if (v.length > LIMITS.message.max) return `Максимум ${LIMITS.message.max} символов.`;
    return '';
  },
  /** Подпись к фото или файлу в чате: может быть пустой. */
  caption(v) {
    v = str(v).trim();
    if (v.length > LIMITS.message.max) return `Подпись — максимум ${LIMITS.message.max} символов.`;
    return '';
  },
  application(d) {
    const f = {};
    const age = Number(d.age);
    if (!Number.isInteger(age) || age < LIMITS.age.min || age > LIMITS.age.max) f.age = `Возраст — число от ${LIMITS.age.min} до ${LIMITS.age.max}.`;
    const about = str(d.about).trim();
    if (about.length < LIMITS.about.min) f.about = `Расскажите подробнее — минимум ${LIMITS.about.min} символов.`;
    else if (about.length > LIMITS.about.max) f.about = `Максимум ${LIMITS.about.max} символов.`;
    if (!APPLICATION_SOURCES.includes(d.source)) f.source = 'Выберите вариант.';
    if (!LICENSES.includes(d.license)) f.license = 'Укажите, есть ли у вас лицензия Minecraft.';
    if (str(d.contact).trim().length > LIMITS.contact.max) f.contact = `Максимум ${LIMITS.contact.max} символов.`;
    if (d.agree !== true) f.agree = 'Нужно согласиться с правилами сервера.';
    return f;
  },
  /** «Моя карточка»: проверяются только присланные поля. */
  card(d) {
    const f = {};
    if (d.bio !== undefined) {
      if (typeof d.bio !== 'string') f.bio = 'Это должен быть текст.';
      else if (d.bio.trim().length > LIMITS.cardBio.max) f.bio = `Максимум ${LIMITS.cardBio.max} символов.`;
    }
    if (d.hidden !== undefined && typeof d.hidden !== 'boolean') f.hidden = 'Нужно «да» или «нет».';
    if (d.hideFields !== undefined) {
      if (!Array.isArray(d.hideFields) || d.hideFields.length > CARD_FIELDS.length || d.hideFields.some((k) => !CARD_FIELDS.includes(k))) f.hideFields = 'Неизвестное поле карточки.';
    }
    if (d.pose !== undefined && !CARD_POSES.includes(d.pose)) f.pose = 'Такой позы нет.';
    if (d.background !== undefined && d.background !== 'custom' && !CARD_BACKGROUNDS.includes(d.background)) f.background = 'Такого фона нет.';
    if (d.looks !== undefined) {
      if (!d.looks || typeof d.looks !== 'object' || Array.isArray(d.looks)) f.looks = 'Нужны настройки позы.';
      else {
        for (const [view, look] of Object.entries(d.looks)) {
          const err = LOOK_VIEWS.includes(view) ? lookError(look) : 'Нет такого вида карточки.';
          if (err) {
            f.looks = err;
            break;
          }
        }
      }
    }
    if (d.socials !== undefined) {
      if (!d.socials || typeof d.socials !== 'object' || Array.isArray(d.socials)) f.socials = { _: 'Нужен список соцсетей.' };
      else {
        const bad = {};
        for (const [key, v] of Object.entries(d.socials)) {
          if (!Object.hasOwn(SOCIALS, key)) bad[key] = 'Такой соцсети нет.';
          else if (typeof v !== 'string') bad[key] = 'Это должен быть текст.';
          else if (v && !SOCIALS[key].test(v)) bad[key] = 'Ник выглядит неправильно.';
        }
        if (Object.keys(bad).length) f.socials = bad;
      }
    }
    return f;
  },
};

/** Убирает пустые сообщения: { поле: '' } → {} */
export function clean(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v));
}
