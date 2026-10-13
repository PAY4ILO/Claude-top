/**
 * Проверка данных на сервере. Правила ДОЛЖНЫ совпадать с validate/LIMITS в assets/js/api.js
 * (там те же проверки для мгновенных подсказок в форме). Меняете одно — меняйте и другое.
 */
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
 * { pose: ключ позы | 'custom', angles: { head, body, rightArm, leftArm, rightLeg, leftLeg: [x, y, z], lift } (только у custom),
 *   scale — размер фигуры, turn — поворот всей фигуры в градусах }.
 * Те же правила — в assets/js/api.js (LOOK).
 */
export const LOOK_VIEWS = ['card', 'detail'];
export const LOOK_PARTS = ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'];
export const LOOK = { angle: 180, lift: [-12, 0], scale: [0.6, 1.3], turn: 180 };

const inRange = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/** Ошибка в одном виде (look) или ''. */
function lookError(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'Нужны настройки позы.';
  if (v.pose !== 'custom' && !CARD_POSES.includes(v.pose)) return 'Такой позы нет.';
  if (v.scale !== undefined && !inRange(v.scale, ...LOOK.scale)) return `Размер — от ${LOOK.scale[0]} до ${LOOK.scale[1]}.`;
  if (v.turn !== undefined && !inRange(v.turn, -LOOK.turn, LOOK.turn)) return `Поворот — от −${LOOK.turn}° до ${LOOK.turn}°.`;
  if (v.pose === 'custom') {
    const a = v.angles;
    if (!a || typeof a !== 'object' || Array.isArray(a)) return 'Для своей позы нужны углы.';
    for (const part of LOOK_PARTS) {
      const r = a[part];
      if (!Array.isArray(r) || r.length !== 3 || r.some((x) => !inRange(x, -LOOK.angle, LOOK.angle))) return `Углы — от −${LOOK.angle}° до ${LOOK.angle}°.`;
    }
    if (a.lift !== undefined && !inRange(a.lift, ...LOOK.lift)) return 'Неверная высота.';
  }
  return '';
}

/** Привести вид к хранимому: округлить, лишнее выбросить. Неверный → null. */
export function normalizeLook(v) {
  if (lookError(v)) return null;
  const round = (x, k = 1) => Math.round(x * k) / k;
  const out = { pose: v.pose, scale: v.scale === undefined ? 1 : round(v.scale, 100), turn: v.turn === undefined ? 0 : round(v.turn) };
  if (v.pose === 'custom') {
    out.angles = { lift: v.angles.lift === undefined ? 0 : round(v.angles.lift) };
    for (const part of LOOK_PARTS) out.angles[part] = v.angles[part].map((x) => round(x));
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
