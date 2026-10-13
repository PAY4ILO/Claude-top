/*
 * LWL — единый слой доступа к данным на странице.
 *
 * Все запросы к серверу сайта (server/, REST под /api) проходят только через этот файл.
 * Сессия — httpOnly-кука, её не видно из JS (не украсть через XSS); CSRF закрыт заголовком
 * X-Requested-With (сервер без него не выполняет изменяющие запросы).
 *
 * Правила проверки полей (LIMITS, validate) продублированы в server/lib/validate.js —
 * меняете здесь, поменяйте и там.
 */
(function () {
  'use strict';

  const CONFIG = {
    apiBase: '/api',
    requestTimeoutMs: 20000,
    pollIntervalMs: 4000, // опрос открытого чата, пока не работает поток событий (SSE)
  };

  const LIMITS = {
    nickname: { min: 3, max: 16, pattern: /^[A-Za-z0-9_]+$/ },
    password: { min: 8, max: 128 },
    email: { max: 254 },
    message: { max: 2000 },
    about: { min: 30, max: 1000 },
    contact: { max: 64 },
    reviewComment: { min: 5, max: 500 },
    avatarBytes: 400 * 1024, // после сжатия в браузере
    age: { min: 10, max: 99 },
    packTitle: { max: 80 },
    packDescription: { max: 1000 },
    packVersion: { max: 40 },
    cardBio: { max: 140 },
    skinBytes: 64 * 1024,
  };

  const APPLICATION_SOURCES = ['Друзья', 'YouTube', 'TikTok', 'Telegram', 'Другое'];
  /** Есть ли у игрока лицензия: от этого зависит, как добавить его на сервер. */
  const LICENSES = { premium: 'Есть лицензия', cracked: 'Нет лицензии' };
  /**
   * Роли: «Пользователь» после регистрации, «Игрок» после одобрения заявки, «Админ».
   * «Создатель» — владелец сайта (LWL_ADMINS на сервере): админ со всеми правами, у пользователя поле creator.
   * Права админов (permissions) и их подписи приходят с сервера — см. server/lib/permissions.js.
   */
  const ROLES = { user: 'Пользователь', player: 'Игрок', admin: 'Админ' };
  const CREATOR_LABEL = 'Создатель';
  const LAUNCHERS = { prism: 'Prism Launcher', curseforge: 'CurseForge', modrinth: 'Modrinth', other: 'Другой лаунчер' };
  /** Что игрок может скрыть на своей карточке (ключи — как в server/lib/validate.js → CARD_FIELDS). */
  const CARD_FIELDS = {
    playtime: 'Время в игре',
    deaths: 'Смерти',
    mobKills: 'Убито мобов',
    playerKills: 'Убито игроков',
    blocksMined: 'Добыто блоков',
    distance: 'Пройдено',
    advancements: 'Достижения',
    firstSeen: 'Первый вход',
    lastSeen: 'Когда был в игре',
  };
  /** Позы и фоны карточки (ключи — как в server/lib/validate.js → CARD_POSES, CARD_BACKGROUNDS). */
  const CARD_POSES = { stand: 'Стоит', wave: 'Машет', walk: 'Идёт', cheer: 'Ура!', point: 'Указывает', sit: 'Сидит' };
  const CARD_BACKGROUNDS = { meadow: 'Луг', night: 'Ночь', sunset: 'Закат', ocean: 'Океан', cave: 'Пещера', snow: 'Снег', nether: 'Незер', end: 'Энд' };
  /**
   * Как стоит персонаж: отдельно на маленькой карточке (card) и в окне игрока (detail).
   * { pose: ключ | 'custom', angles (у custom): { head, body, rightArm, leftArm, rightLeg, leftLeg: [x, y, z], lift }, scale, turn,
   *   offset — сдвиг фигуры в кадре [x, y],
   *   held — что в руках и на голове: { rightHand, leftHand, head: { id, rot: [x, y, z], size, at: [x, y, z] } | null },
   *   blocks — блоки вокруг: [{ id, at: [x, y, z] (низ-центр, 16 = блок), rot — поворот вокруг вертикали, size }],
   *   textures — свои картинки игрока 16×16 (data:image/png), в held и blocks это id tex1…tex3 }.
   * id предметов и блоков — из assets/js/mc-index.json: здесь проверяются, только если на странице есть McArt
   * и он уже загрузил оглавление (иначе решает сервер).
   * Пределы — как в server/lib/validate.js → LOOK (slots — там LOOK_HELD).
   */
  const LOOK = {
    views: { card: 'Карточка', detail: 'Окно игрока' },
    parts: ['head', 'body', 'rightArm', 'leftArm', 'rightLeg', 'leftLeg'],
    slots: ['rightHand', 'leftHand', 'head'],
    angle: 180,
    lift: [-12, 0],
    scale: [0.2, 4],
    turn: 180,
    offset: 200,
    move: 32,
    stretch: [0.25, 3],
    held: { rot: 180, size: [0.5, 2], at: 16 },
    blocks: { max: 32, side: 96, y: [-48, 96], size: [0.25, 2] },
    textures: { max: 3, chars: 4096, side: 16 },
  };
  /** Свой фон: кабинет уменьшает картинку до side точек и сжимает в WebP, чтобы файл был не больше bytes. */
  const BACKGROUND = { side: 1280, bytes: 400 * 1024, sourceBytes: 25 * 1024 * 1024 };
  /**
   * Соцсети на карточке. Хранится только ник (pattern — как в server/lib/validate.js → SOCIALS),
   * ссылку собирает страница: url + ник. Без url (Discord) — ник копируется.
   * hosts — с каких адресов можно вставить ссылку целиком: ник из неё достанет parseSocial.
   */
  const SOCIALS = {
    telegram: { label: 'Telegram', url: 'https://t.me/', at: true, pattern: /^[A-Za-z][A-Za-z0-9_]{4,31}$/, hosts: ['t.me', 'telegram.me'], placeholder: '@nickname' },
    discord: { label: 'Discord', url: null, pattern: /^[A-Za-z0-9_.]{2,32}(#\d{4})?$/, hosts: [], placeholder: 'nickname' },
    youtube: { label: 'YouTube', url: 'https://www.youtube.com/@', at: true, pattern: /^[A-Za-z0-9_.-]{3,30}$/, hosts: ['youtube.com', 'www.youtube.com', 'm.youtube.com'], placeholder: '@channel' },
    twitch: { label: 'Twitch', url: 'https://www.twitch.tv/', pattern: /^[A-Za-z0-9_]{3,25}$/, hosts: ['twitch.tv', 'www.twitch.tv'], placeholder: 'nickname' },
    vk: { label: 'VK', url: 'https://vk.com/', pattern: /^[A-Za-z0-9_.]{2,32}$/, hosts: ['vk.com', 'm.vk.com', 'vk.ru'], placeholder: 'nickname' },
    tiktok: { label: 'TikTok', url: 'https://www.tiktok.com/@', at: true, pattern: /^[A-Za-z0-9_.]{2,24}$/, hosts: ['tiktok.com', 'www.tiktok.com'], placeholder: '@nickname' },
  };

  /** Что ввели в поле соцсети → ник: «@name», «name» или ссылка на профиль. Непонятное — как есть (покажем ошибку). */
  function parseSocial(key, raw) {
    let v = String(raw || '').trim();
    const s = SOCIALS[key];
    if (!v || !s) return v;
    if (/^(https?:\/\/)?[\w.-]+\.\w+\//i.test(v)) {
      try {
        const u = new URL(/^https?:\/\//i.test(v) ? v : 'https://' + v);
        if (s.hosts.includes(u.hostname.toLowerCase())) v = decodeURIComponent(u.pathname.split('/').filter(Boolean)[0] || '');
      } catch (e) {
        /* оставим как есть */
      }
    }
    return v.replace(/^@/, '');
  }

  /* ------------------------------------------------------------------ ошибки */

  class ApiError extends Error {
    constructor(code, message, extra) {
      super(message || ApiError.defaultMessage(code));
      this.name = 'ApiError';
      this.code = code;
      this.fields = (extra && extra.fields) || null; // { поле: 'текст ошибки' }
      this.retryAfter = (extra && extra.retryAfter) || 0; // секунды
    }

    static defaultMessage(code) {
      return (
        {
          VALIDATION: 'Проверьте поля формы.',
          INVALID_CREDENTIALS: 'Неверный логин или пароль.',
          NICK_TAKEN: 'Этот никнейм уже занят.',
          EMAIL_TAKEN: 'Аккаунт с этой почтой уже есть.',
          UNAUTHORIZED: 'Сессия истекла. Войдите снова.',
          FORBIDDEN: 'Недостаточно прав.',
          NOT_FOUND: 'Не найдено.',
          CONFLICT: 'Действие уже выполнено или недоступно.',
          RATE_LIMITED: 'Слишком много попыток. Подождите немного.',
          TOO_LARGE: 'Файл слишком большой.',
          NETWORK: 'Нет соединения с сервером. Проверьте интернет.',
          TIMEOUT: 'Сервер долго не отвечает. Попробуйте ещё раз.',
          SERVER: 'Ошибка на сервере. Попробуйте позже.',
        }[code] || 'Что-то пошло не так.'
      );
    }
  }

  /* ------------------------------------------------------------ валидация */

  // Какие блоки и предметы бывают — у McArt (assets/js/mc-art.js), если он есть на странице и уже загрузил оглавление.
  // Оглавление после загрузки не меняется, поэтому списки собираются один раз.
  let mcIds = null;
  function mcKnown() {
    const art = window.McArt;
    if (!mcIds && art && art.kind && art.ready) {
      const list = art.list();
      mcIds = { blocks: new Set(list.blocks), items: new Set(list.items) };
    }
    return mcIds;
  }

  /** Своя картинка: PNG 16×16 в data:-адресе (смотрим заголовок IHDR, как сервер). */
  function textureOk(v) {
    if (typeof v !== 'string' || v.length > LOOK.textures.chars) return false;
    const m = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(v);
    if (!m || m[1].replace(/=+$/, '').length < 34) return false; // меньше 25 байт — не PNG
    let head;
    try {
      head = atob(m[1].slice(0, 32)); // первые 24 байта: подпись, длина и имя IHDR, ширина, высота
    } catch (e) {
      return false;
    }
    const u32 = (i) => ((head.charCodeAt(i) << 24) | (head.charCodeAt(i + 1) << 16) | (head.charCodeAt(i + 2) << 8) | head.charCodeAt(i + 3)) >>> 0;
    const png = u32(0) === 0x89504e47 && u32(4) === 0x0d0a1a0a && head.slice(12, 16) === 'IHDR';
    return png && u32(16) === LOOK.textures.side && u32(20) === LOOK.textures.side;
  }

  const inRange = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

  /** Ошибка в одном виде (look) или '' — тексты и порядок проверок как в server/lib/validate.js → lookError. */
  function lookError(v) {
    const isObj = (x) => !!x && typeof x === 'object' && !Array.isArray(x);
    const vec = (x, n, check) => Array.isArray(x) && x.length === n && x.every((k, i) => check(k, i));
    if (!isObj(v)) return 'Нужны настройки позы.';
    if (v.pose !== 'custom' && !Object.hasOwn(CARD_POSES, v.pose)) return 'Такой позы нет.';
    if (v.scale !== undefined && !inRange(v.scale, ...LOOK.scale)) return `Размер — от ${LOOK.scale[0]} до ${LOOK.scale[1]}.`;
    if (v.turn !== undefined && !inRange(v.turn, -LOOK.turn, LOOK.turn)) return `Поворот — от −${LOOK.turn}° до ${LOOK.turn}°.`;
    if (v.pose === 'custom') {
      const a = v.angles;
      if (!isObj(a)) return 'Для своей позы нужны углы.';
      if (LOOK.parts.some((p) => !vec(a[p], 3, (x) => inRange(x, -LOOK.angle, LOOK.angle)))) return `Углы — от −${LOOK.angle}° до ${LOOK.angle}°.`;
      if (a.lift !== undefined && !inRange(a.lift, ...LOOK.lift)) return 'Неверная высота.';
      if (a.move !== undefined) {
        if (!isObj(a.move)) return 'Неверный сдвиг частей тела.';
        for (const [part, m] of Object.entries(a.move)) {
          if (!LOOK.parts.includes(part)) return 'Неверный сдвиг частей тела.';
          if (!vec(m, 3, (x) => inRange(x, -LOOK.move, LOOK.move))) return `Сдвиг части тела — от −${LOOK.move} до ${LOOK.move}.`;
        }
      }
      if (a.stretch !== undefined) {
        if (!isObj(a.stretch)) return 'Неверный размер частей тела.';
        for (const [part, k] of Object.entries(a.stretch)) {
          if (!LOOK.parts.includes(part)) return 'Неверный размер частей тела.';
          if (!vec(k, 3, (x) => inRange(x, ...LOOK.stretch))) return `Размер части тела — от ${LOOK.stretch[0]} до ${LOOK.stretch[1]}.`;
        }
      }
    }
    if (v.offset !== undefined && !vec(v.offset, 2, (k) => inRange(k, -LOOK.offset, LOOK.offset))) return `Сдвиг — от −${LOOK.offset} до ${LOOK.offset}.`;
    if (v.textures !== undefined) {
      if (!Array.isArray(v.textures) || v.textures.length > LOOK.textures.max) return `Своих картинок — не больше ${LOOK.textures.max}.`;
      if (!v.textures.every(textureOk)) return 'Своя картинка — PNG 16×16.';
    }
    const known = mcKnown();
    const texCount = Array.isArray(v.textures) ? v.textures.length : 0;
    const tex = (id) => /^tex[1-3]$/.test(id) && Number(id.slice(3)) <= texCount;
    // tex1…tex3 — только из присланных картинок. Остальное — по оглавлению игры; пока его нет, пропускаем
    // всё похожее на id Minecraft (кроме texN), а есть ли такой блок или предмет, проверит сервер.
    const exists = (id, kinds) => tex(id) || (known ? kinds.some((k) => known[k].has(id)) : /^[a-z0-9_./-]+$/.test(id) && !/^tex\d*$/.test(id));
    if (v.held !== undefined) {
      if (!isObj(v.held)) return 'Неверные предметы в руках.';
      const H = LOOK.held;
      for (const [slot, e] of Object.entries(v.held)) {
        if (!LOOK.slots.includes(slot)) return 'Предмет можно держать только в руках или на голове.';
        if (e === null) continue;
        if (!isObj(e) || typeof e.id !== 'string') return 'Неверный предмет.';
        if (!exists(e.id, ['items', 'blocks'])) return 'Такого предмета нет.';
        if (e.rot !== undefined && !vec(e.rot, 3, (k) => inRange(k, -H.rot, H.rot))) return `Поворот предмета — от −${H.rot}° до ${H.rot}°.`;
        if (e.size !== undefined && !inRange(e.size, ...H.size)) return `Размер предмета — от ${H.size[0]} до ${H.size[1]}.`;
        if (e.at !== undefined && !vec(e.at, 3, (k) => inRange(k, -H.at, H.at))) return 'Предмет слишком далеко от руки.';
      }
    }
    if (v.blocks !== undefined) {
      const B = LOOK.blocks;
      if (!Array.isArray(v.blocks) || v.blocks.length > B.max) return `Блоков — не больше ${B.max}.`;
      for (const b of v.blocks) {
        if (!isObj(b) || typeof b.id !== 'string' || !exists(b.id, ['blocks'])) return 'Такого блока нет.';
        if (!vec(b.at, 3, (k, i) => (i === 1 ? inRange(k, ...B.y) : inRange(k, -B.side, B.side)))) return 'Блок слишком далеко.';
        if (b.rot !== undefined && !inRange(b.rot, -180, 180)) return 'Поворот блока — от −180° до 180°.';
        if (b.size !== undefined && !inRange(b.size, ...B.size)) return `Размер блока — от ${B.size[0]} до ${B.size[1]}.`;
      }
    }
    return '';
  }

  const validate = {
    nickname(v) {
      v = String(v || '').trim();
      if (!v) return 'Введите никнейм.';
      if (v.length < LIMITS.nickname.min || v.length > LIMITS.nickname.max) return `От ${LIMITS.nickname.min} до ${LIMITS.nickname.max} символов.`;
      if (!LIMITS.nickname.pattern.test(v)) return 'Только латиница, цифры и «_», как в Minecraft.';
      return '';
    },
    email(v) {
      v = String(v || '').trim();
      if (!v) return 'Введите почту.';
      if (v.length > LIMITS.email.max || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v)) return 'Почта выглядит неправильно.';
      return '';
    },
    password(v) {
      v = String(v || '');
      if (!v) return 'Введите пароль.';
      if (v.length < LIMITS.password.min) return `Минимум ${LIMITS.password.min} символов.`;
      if (v.length > LIMITS.password.max) return `Максимум ${LIMITS.password.max} символов.`;
      if (!/[A-Za-zА-Яа-яЁё]/.test(v) || !/\d/.test(v)) return 'Нужны хотя бы одна буква и одна цифра.';
      return '';
    },
    message(v) {
      v = String(v || '').trim();
      if (!v) return 'Сообщение пустое.';
      if (v.length > LIMITS.message.max) return `Максимум ${LIMITS.message.max} символов.`;
      return '';
    },
    /** Подпись к фото или файлу в чате: может быть пустой. */
    caption(v) {
      v = String(v || '').trim();
      if (v.length > LIMITS.message.max) return `Подпись — максимум ${LIMITS.message.max} символов.`;
      return '';
    },
    application(d) {
      const f = {};
      const age = Number(d.age);
      if (!Number.isInteger(age) || age < LIMITS.age.min || age > LIMITS.age.max) f.age = `Возраст — число от ${LIMITS.age.min} до ${LIMITS.age.max}.`;
      const about = String(d.about || '').trim();
      if (about.length < LIMITS.about.min) f.about = `Расскажите подробнее — минимум ${LIMITS.about.min} символов.`;
      else if (about.length > LIMITS.about.max) f.about = `Максимум ${LIMITS.about.max} символов.`;
      if (!APPLICATION_SOURCES.includes(d.source)) f.source = 'Выберите вариант.';
      if (!Object.hasOwn(LICENSES, d.license)) f.license = 'Укажите, есть ли у вас лицензия Minecraft.';
      if (String(d.contact || '').trim().length > LIMITS.contact.max) f.contact = `Максимум ${LIMITS.contact.max} символов.`;
      if (!d.agree) f.agree = 'Нужно согласиться с правилами сервера.';
      return f;
    },
    /** «Моя карточка»: проверяются только переданные поля. */
    card(d) {
      const f = {};
      if (d.bio !== undefined) {
        if (typeof d.bio !== 'string') f.bio = 'Это должен быть текст.';
        else if (d.bio.trim().length > LIMITS.cardBio.max) f.bio = `Максимум ${LIMITS.cardBio.max} символов.`;
      }
      if (d.hidden !== undefined && typeof d.hidden !== 'boolean') f.hidden = 'Нужно «да» или «нет».';
      if (d.hideFields !== undefined) {
        const keys = Object.keys(CARD_FIELDS);
        if (!Array.isArray(d.hideFields) || d.hideFields.length > keys.length || d.hideFields.some((k) => !keys.includes(k))) f.hideFields = 'Неизвестное поле карточки.';
      }
      if (d.pose !== undefined && !Object.hasOwn(CARD_POSES, d.pose)) f.pose = 'Такой позы нет.';
      if (d.background !== undefined && d.background !== 'custom' && !Object.hasOwn(CARD_BACKGROUNDS, d.background)) f.background = 'Такого фона нет.';
      if (d.looks !== undefined) {
        if (!d.looks || typeof d.looks !== 'object' || Array.isArray(d.looks)) f.looks = 'Нужны настройки позы.';
        else for (const [view, look] of Object.entries(d.looks)) f.looks = f.looks || (Object.hasOwn(LOOK.views, view) ? lookError(look) : 'Нет такого вида карточки.');
        if (!f.looks) delete f.looks;
      }
      if (d.socials !== undefined) {
        if (!d.socials || typeof d.socials !== 'object' || Array.isArray(d.socials)) f.socials = { _: 'Нужен список соцсетей.' };
        else {
          const bad = {};
          for (const [key, v] of Object.entries(d.socials)) {
            if (!Object.hasOwn(SOCIALS, key)) bad[key] = 'Такой соцсети нет.';
            else if (typeof v !== 'string') bad[key] = 'Это должен быть текст.';
            else if (v && !SOCIALS[key].pattern.test(v)) bad[key] = 'Ник выглядит неправильно.';
          }
          if (Object.keys(bad).length) f.socials = bad;
        }
      }
      return f;
    },
  };

  /* -------------------------------------------------------------- события */

  // Подписки внутри вкладки + рассылка в другие вкладки (BroadcastChannel):
  // вошли/вышли в одной — остальные сразу это видят.
  const listeners = new Map();
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel('lwl') : null;

  function on(type, cb) {
    if (!listeners.has(type)) listeners.set(type, new Set());
    listeners.get(type).add(cb);
    return () => listeners.get(type) && listeners.get(type).delete(cb);
  }

  function emitLocal(type, payload) {
    (listeners.get(type) || []).forEach((cb) => {
      try {
        cb(payload);
      } catch (e) {
        console.error(e);
      }
    });
  }

  function emit(type, payload) {
    emitLocal(type, payload);
    if (channel) channel.postMessage({ type, payload });
  }

  if (channel) channel.onmessage = (e) => e.data && emitLocal(e.data.type, e.data.payload);

  /* ------------------------------------------------------------ запросы */

  /** quiet — не сообщать «сессия истекла» (для проверки «вошёл ли я»). */
  async function http(method, path, body, quiet) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), CONFIG.requestTimeoutMs);
    const headers = { Accept: 'application/json', 'X-Requested-With': 'lwl' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    let res;
    try {
      res = await fetch(CONFIG.apiBase + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        credentials: 'same-origin',
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new ApiError(e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
    } finally {
      clearTimeout(timer);
    }
    const data = res.status === 204 ? null : await res.json().catch(() => null);
    if (res.ok) return data;
    throw toError(res.status, data, Number(res.headers.get('Retry-After')) || 0, quiet);
  }

  function toError(status, data, retryAfter, quiet) {
    const code = (data && data.code) || { 400: 'VALIDATION', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'TOO_LARGE', 422: 'VALIDATION', 429: 'RATE_LIMITED' }[status] || 'SERVER';
    // Сессия истекла или вышли в другой вкладке — страница покажет вход.
    if (code === 'UNAUTHORIZED' && !quiet) emitLocal('auth', null);
    return new ApiError(code, data && data.message, { fields: data && data.fields, retryAfter });
  }

  const enc = encodeURIComponent;
  const q = (params) => {
    const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '' && v !== 0)).toString();
    return s ? '?' + s : '';
  };

  /** Загрузка файла с прогрессом (fetch не умеет показывать прогресс отправки). headers — дополнительные заголовки. */
  /** Картинка → Blob WebP (или JPEG) не больше BACKGROUND.side точек по стороне и BACKGROUND.bytes. */
  async function compressBackground(file) {
    if (!file) throw new ApiError('VALIDATION', 'Выберите картинку.');
    if (file.type && !file.type.startsWith('image/')) throw new ApiError('VALIDATION', 'Нужна картинка: JPEG, PNG, WebP.');
    if (file.size > BACKGROUND.sourceBytes) throw new ApiError('VALIDATION', 'Картинка больше 25 МБ — выберите поменьше.');
    let img;
    try {
      img = await createImageBitmap(file);
    } catch (e) {
      throw new ApiError('VALIDATION', 'Не получилось открыть картинку. Подойдут JPEG, PNG, WebP.');
    }
    const encode = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));
    try {
      // Сначала крупно и почти без потерь; не влезает — меньше и сильнее.
      for (const [side, quality] of [[BACKGROUND.side, 0.82], [BACKGROUND.side, 0.65], [960, 0.6], [720, 0.5]]) {
        const k = Math.min(1, side / Math.max(img.width, img.height));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(img.width * k));
        canvas.height = Math.max(1, Math.round(img.height * k));
        const g = canvas.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, canvas.width, canvas.height);
        let blob = await encode(canvas, 'image/webp', quality);
        if (!blob || blob.type !== 'image/webp') blob = await encode(canvas, 'image/jpeg', quality);
        if (blob && blob.size <= BACKGROUND.bytes) return blob;
      }
    } finally {
      img.close && img.close();
    }
    throw new ApiError('VALIDATION', 'Не получилось сжать картинку до 400 КБ. Выберите другую.');
  }

  function upload(path, file, onProgress, headers) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', CONFIG.apiBase + path);
      xhr.setRequestHeader('X-Requested-With', 'lwl');
      xhr.setRequestHeader('X-File-Name', encodeURIComponent(file.name || 'файл'));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      Object.entries(headers || {}).forEach(([k, v]) => v && xhr.setRequestHeader(k, v));
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress && onProgress(e.loaded / e.total);
      xhr.onload = () => {
        let data = null;
        try {
          data = JSON.parse(xhr.responseText);
        } catch (e) {
          /* пусто */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(data);
        else reject(toError(xhr.status, data, Number(xhr.getResponseHeader('Retry-After')) || 0));
      };
      xhr.onerror = () => reject(new ApiError('NETWORK'));
      xhr.send(file);
    });
  }

  /* ------------------------------------------------------------ «в сети» и опрос */

  // Опрос сервера для «живых» обновлений; пока вкладка скрыта — не опрашиваем.
  function poll(fn, ms) {
    let timer = null;
    let stopped = false;
    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible') await fn().catch(() => null);
      timer = setTimeout(tick, ms);
    };
    timer = setTimeout(tick, ms);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }

  let heartbeatTimer = null;
  function startHeartbeat() {
    if (heartbeatTimer) return;
    const beat = () => document.visibilityState === 'visible' && http('POST', '/me/presence').catch(() => null);
    beat();
    heartbeatTimer = setInterval(beat, 25000);
    document.addEventListener('visibilitychange', beat);
  }

  let publicSettings = null;

  /* ======================================================= ПУБЛИЧНЫЙ ИНТЕРФЕЙС */

  window.Api = {
    config: CONFIG,
    LIMITS,
    APPLICATION_SOURCES,
    LICENSES,
    ROLES,
    CREATOR_LABEL,
    LAUNCHERS,
    CARD_FIELDS,
    CARD_POSES,
    CARD_BACKGROUNDS,
    LOOK,
    BACKGROUND,
    SOCIALS,
    parseSocial,
    ApiError,
    validate,
    on,

    auth: {
      async register({ nickname, email, password, remember }) {
        const { user } = await http('POST', '/auth/register', { nickname, email, password, remember: !!remember });
        emit('auth', user);
        return user;
      },
      async login({ login, password, remember }) {
        const { user } = await http('POST', '/auth/login', { login, password, remember: !!remember });
        emit('auth', user);
        return user;
      },
      async logout() {
        await http('POST', '/auth/logout').catch(() => null);
        emit('auth', null);
      },
      /** Текущий пользователь или null, если не вошли. */
      async me() {
        try {
          return (await http('GET', '/auth/me', undefined, true)).user;
        } catch (e) {
          if (e.code === 'UNAUTHORIZED') return null;
          throw e;
        }
      },
      /** → { mail }: true — ссылка уходит и письмом (если почта есть на сайте). */
      requestPasswordReset: ({ email }) => http('POST', '/auth/password-reset', { email }),
      /** Проверить ссылку сброса: { nickname } или ошибка NOT_FOUND. */
      resetInfo: (token) => http('GET', `/auth/password-reset/${enc(token)}`),
      async resetPassword(token, password) {
        const { user } = await http('POST', `/auth/password-reset/${enc(token)}`, { password });
        emit('auth', user);
        return user;
      },
      onChange: (cb) => on('auth', cb),
    },

    profile: {
      async update(patch) {
        const { user } = await http('PATCH', '/me', patch);
        emit('auth', user);
        return user;
      },
      changePassword: (data) => http('POST', '/me/password', data).then(() => true),
      async deleteAccount(data) {
        await http('DELETE', '/me', data);
        emit('auth', null);
        return true;
      },
      startPresence: startHeartbeat,
    },

    applications: {
      mine: () => http('GET', '/applications/mine').then((d) => d.application),
      submit: (data) => http('POST', '/applications', data).then((d) => (emit('applications'), d.application)),
      withdraw: (id) => http('POST', `/applications/${enc(id)}/withdraw`).then((d) => (emit('applications'), d.application)),
      list: ({ status = 'pending', query = '' } = {}) => http('GET', '/applications' + q({ status, q: query })),
      get: (id) => http('GET', `/applications/${enc(id)}`).then((d) => d.application),
      async review(id, decision) {
        const d = await http('POST', `/applications/${enc(id)}/review`, decision);
        emit('applications');
        emit('users');
        return d.application;
      },
      /** Ещё раз добавить в вайтлист через RCON (например, сервер был выключен). */
      retryWhitelist: (id) => http('POST', `/applications/${enc(id)}/whitelist`).then((d) => (emit('applications'), d.application)),
      remove: (id) => http('DELETE', `/applications/${enc(id)}`).then(() => (emit('applications'), emit('users'), true)),
      onChange: (cb) => on('applications', cb),
    },

    chats: {
      support: () => http('POST', '/support/conversation').then((d) => d.conversation),
      list: ({ status = 'open', query = '' } = {}) => http('GET', '/conversations' + q({ status, q: query })).then((d) => d.items),
      get: (id) => http('GET', `/conversations/${enc(id)}`).then((d) => d.conversation),
      messages: (id, { before = 0, limit = 50 } = {}) => http('GET', `/conversations/${enc(id)}/messages` + q({ before, limit })),
      send: (id, body) => http('POST', `/conversations/${enc(id)}/messages`, body).then((d) => (emit('messages', { conversationId: id }), emit('conversations'), d.message)),
      /**
       * Фото или файл — отдельным сообщением: { clientId, caption, onProgress(доля 0..1) }.
       * Повтор с тем же clientId не создаёт дубль. Лимит размера — conversation.maxFileBytes.
       * Подпись идёт заголовком, поэтому длинную (см. CAPTION_HEADER_MAX) отправляйте обычным сообщением.
       */
      attach: (id, file, { clientId, caption, onProgress } = {}) =>
        upload(`/conversations/${enc(id)}/attachments`, file, onProgress, { 'X-Client-Id': clientId, 'X-Caption': caption ? enc(caption) : '' }).then(
          (d) => (emit('messages', { conversationId: id }), emit('conversations'), d.message)
        ),
      /** Сколько символов подписи (после URL-кодирования) влезает в заголовок: прокси режут длинные заголовки. */
      CAPTION_HEADER_MAX: 4000,
      markRead: (id) => http('POST', `/conversations/${enc(id)}/read`).then(() => emit('conversations')).catch(() => null),
      close: (id) => http('POST', `/conversations/${enc(id)}/close`).then(() => (emit('conversations'), emit('messages', { conversationId: id }), true)),
      reopen: (id) => http('POST', `/conversations/${enc(id)}/reopen`).then(() => (emit('conversations'), emit('messages', { conversationId: id }), true)),
      remove: (id) => http('DELETE', `/conversations/${enc(id)}`).then(() => (emit('conversations'), true)),
      onListChange: (cb) => on('conversations', cb),
      /**
       * Новые сообщения в диалоге: cb() вызывается, когда стоит перечитать ленту. Сервер сам говорит «change»
       * по потоку (SSE); пока поток не работает — опрос. Скрытая вкладка не перечитывает (иначе отметит
       * «прочитано» за человека) — догоняет, когда её откроют.
       */
      subscribe(id, cb) {
        const off = on('messages', (p) => p && p.conversationId === id && cb());
        let live = false;
        let opened = false;
        let pending = false;
        const kick = () => {
          if (document.visibilityState === 'visible') cb();
          else pending = true;
        };
        const es = window.EventSource ? new EventSource(`${CONFIG.apiBase}/conversations/${enc(id)}/events`) : null;
        if (es) {
          es.addEventListener('change', kick);
          es.onopen = () => {
            if (opened) kick(); // переподключились — могли что-то пропустить
            opened = live = true;
          };
          es.onerror = () => {
            live = false;
          };
        }
        const stop = poll(async () => {
          if (!live) await cb();
        }, CONFIG.pollIntervalMs);
        const onVisible = () => {
          if (document.visibilityState !== 'visible' || !pending) return;
          pending = false;
          cb();
        };
        document.addEventListener('visibilitychange', onVisible);
        return () => {
          off();
          stop();
          if (es) es.close();
          document.removeEventListener('visibilitychange', onVisible);
        };
      },
    },

    /**
     * Вкладка «Сервер» (игроки и админы): код входа, как зайти, сборки.
     * Адреса сервера здесь нет — игрок его не видит, мод LWL получает адрес по личному коду.
     */
    server: {
      /** { server: { ready, version, note, … }, me, code: { exists, last4, createdAt }, packs } */
      info: () => http('GET', '/me/server'),
      /** Новый личный код (старый перестаёт работать): { code: 'XXXX-XXXX-XXXX', info }. Целиком код приходит только здесь. */
      newCode: () => http('POST', '/me/connect-code'),
    },

    /**
     * Карточки игроков — их видят все, даже без входа (ник, скин, поза, фон, «о себе», соцсети).
     * Вошедшим «Игрокам» и админам — ещё статистика и «в сети» (в ответе full: true).
     */
    players: {
      /** sort: 'online' | 'playtime' | 'recent' (без статистики — по нику); → { players, total, full } */
      list: ({ sort = 'online', query = '' } = {}) => http('GET', '/players' + q({ sort, q: query.trim() }), undefined, true),
      get: (nickname) => http('GET', `/players/${enc(nickname)}`, undefined, true).then((d) => d.player),
      /** Сколько человек сейчас на сервере (без входа): { count } */
      online: () => http('GET', '/online', undefined, true),
      /** Своя карточка: { card (как её видят), bio, hidden, hideFields, pose, background, socials, skin: { slim, sync } | null } */
      myCard: () => http('GET', '/me/card'),
      /** Меняет только переданное: { bio?, hidden?, hideFields?, pose?, looks? (см. LOOK), background?, socials? } */
      async updateMyCard(patch) {
        const fields = validate.card(patch);
        if (Object.keys(fields).length) throw new ApiError('VALIDATION', null, { fields });
        const card = await http('PATCH', '/me/card', patch);
        emit('players');
        return card;
      },
      /** Проверить файл скина ещё в браузере: PNG 64×64 (или старый 64×32), до 64 КБ. → { slim } — похоже ли на тонкие руки. */
      async checkSkinFile(file) {
        if (!file) throw new ApiError('VALIDATION', 'Выберите файл.');
        if (file.size > LIMITS.skinBytes) throw new ApiError('VALIDATION', 'Файл больше 64 КБ. Скин — маленькая картинка PNG 64×64.');
        if (file.type && file.type !== 'image/png') throw new ApiError('VALIDATION', 'Скин — это картинка PNG.');
        const url = URL.createObjectURL(file);
        try {
          const skin = await window.Skin3D.load(url, { cache: false });
          return { slim: window.Skin3D.guessSlim(skin) };
        } catch (e) {
          throw new ApiError('VALIDATION', 'Это не скин Minecraft: нужна картинка PNG 64×64 (или старая 64×32).');
        } finally {
          URL.revokeObjectURL(url);
        }
      },
      /** Свой скин: сайт сохранит его и сам поставит на сервере Minecraft. → как myCard */
      async uploadSkin(file, slim, onProgress) {
        const d = await upload('/me/skin', file, onProgress, { 'X-Skin-Model': slim ? 'slim' : 'classic' });
        emit('players');
        return d;
      },
      /** Тонкие (Алекс) или обычные (Стив) руки. */
      setSkinModel: (slim) => http('PATCH', '/me/skin', { slim: !!slim }).then((d) => (emit('players'), d)),
      /** Ещё раз поставить скин на сервере (если в прошлый раз не вышло). */
      syncSkin: () => http('POST', '/me/skin/sync').then((d) => (emit('players'), d)),
      removeSkin: () => http('DELETE', '/me/skin').then((d) => (emit('players'), d)),
      /** Скин как у лицензии с этим ником (сайт спрашивает Mojang). */
      skinByNick: (nickname) => {
        const nick = String(nickname || '').trim();
        if (!/^[A-Za-z0-9_]{3,16}$/.test(nick)) return Promise.reject(new ApiError('VALIDATION', 'Ник Minecraft — латиница, цифры и _, от 3 до 16 символов.', { fields: { nickname: 'Ник Minecraft — латиница, цифры и _, от 3 до 16 символов.' } }));
        return http('POST', '/me/skin/nick', { nickname: nick }).then((d) => (emit('players'), d));
      },
      /**
       * Свой фон. Картинку уменьшает и сжимает браузер (WebP; где WebP не умеют сохранять — JPEG),
       * на сервер уходит уже маленький файл. → как myCard
       */
      async uploadBackground(file, onProgress) {
        const blob = await compressBackground(file);
        const d = await upload('/me/background', blob, onProgress);
        emit('players');
        return d;
      },
      /** Убрать свою картинку (фон станет «Луг»). */
      removeBackground: () => http('DELETE', '/me/background').then((d) => (emit('players'), d)),
      /** Админ с правом «Люди»: убрать чужую картинку фона. → карточка */
      removePlayerBackground: (nickname) => http('DELETE', `/players/${enc(nickname)}/background`).then((d) => (emit('players'), d.player)),
      /** Модерация: убрать свои картинки 16×16 игрока (и предметы/блоки с ними) → карточка игрока. */
      removePlayerTextures: (nickname) => http('DELETE', `/players/${enc(nickname)}/textures`).then((d) => (emit('players'), d.player)),
      onChange: (cb) => on('players', cb),
    },

    /** Ссылки для страниц сайта (Telegram, Discord); запрашиваются один раз. */
    settings: {
      public() {
        if (!publicSettings) publicSettings = http('GET', '/settings').catch(() => ({ telegramUrl: '', discordUrl: '' }));
        return publicSettings;
      },
    },

    admin: {
      users: {
        list: ({ role = 'all', query = '' } = {}) => http('GET', '/admin/users' + q({ role, q: query })),
        get: (id) => http('GET', `/admin/users/${enc(id)}`),
        setRole: (id, role) => http('PATCH', `/admin/users/${enc(id)}`, { role }).then((d) => (emit('users'), d.user)),
        /** Права админа — меняет только создатель. permissions — список ключей из permissionCatalog. */
        setPermissions: (id, permissions) => http('PUT', `/admin/users/${enc(id)}/permissions`, { permissions }).then((d) => (emit('users'), d.user)),
        resetLink: (id) => http('POST', `/admin/users/${enc(id)}/reset-link`).then((d) => (emit('users'), d)),
        /** Отозвать личный код входа на сервер: мод и сервер перестанут его принимать. */
        revokeCode: (id) => http('DELETE', `/admin/users/${enc(id)}/connect-code`).then(() => (emit('users'), true)),
        remove: (id) => http('DELETE', `/admin/users/${enc(id)}`).then(() => (emit('users'), emit('applications'), emit('conversations'), true)),
        onChange: (cb) => on('users', cb),
      },
      settings: {
        /** { settings, rcon: { enabled, address? } } */
        get: () => http('GET', '/admin/settings'),
        save: (values) =>
          http('PUT', '/admin/settings', values).then((d) => {
            publicSettings = null;
            emit('settings');
            return d.settings;
          }),
      },
      /** Проверка связи с Minecraft-сервером: { ok, reply } (ответ на /wl list). */
      rcon: {
        test: () => http('POST', '/admin/rcon/test'),
      },
      packs: {
        list: () => http('GET', '/admin/packs').then((d) => d.items),
        create: (data) => http('POST', '/admin/packs', data).then((d) => (emit('packs'), d.pack)),
        update: (id, data) => http('PATCH', `/admin/packs/${enc(id)}`, data).then((d) => (emit('packs'), d.pack)),
        remove: (id) => http('DELETE', `/admin/packs/${enc(id)}`).then(() => (emit('packs'), true)),
        /** onProgress(доля 0..1) */
        upload: (id, file, onProgress) => upload(`/admin/packs/${enc(id)}/file`, file, onProgress).then((d) => (emit('packs'), d.pack)),
        onChange: (cb) => on('packs', cb),
      },
    },

    summary: () => http('GET', '/me/summary'),
  };
})();
