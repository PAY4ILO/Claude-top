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
};

export const APPLICATION_SOURCES = ['Друзья', 'YouTube', 'TikTok', 'Telegram', 'Другое'];
export const LICENSES = ['premium', 'cracked'];
export const ROLES = ['user', 'player', 'admin'];
export const LAUNCHERS = ['prism', 'curseforge', 'modrinth', 'other'];

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
};

/** Убирает пустые сообщения: { поле: '' } → {} */
export function clean(fields) {
  return Object.fromEntries(Object.entries(fields).filter(([, v]) => v));
}
