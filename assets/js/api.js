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
    pollIntervalMs: 4000, // как часто опрашиваются новые сообщения в открытом чате
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
      /** Новые сообщения в диалоге: cb() вызывается, когда стоит перечитать ленту. */
      subscribe(id, cb) {
        const off = on('messages', (p) => p && p.conversationId === id && cb());
        const stop = poll(async () => cb(), CONFIG.pollIntervalMs);
        return () => {
          off();
          stop();
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
