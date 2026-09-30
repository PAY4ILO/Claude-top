/*
 * LWL — единый слой доступа к данным.
 *
 * Всё, что читает или пишет данные (аккаунты, сессии, заявки, обращения, сообщения),
 * проходит только через этот файл. Интерфейс страниц не знает, где лежат данные.
 *
 * Режимы:
 *   demo   — сервера ещё нет: данные живут только в localStorage этого браузера,
 *            пароли хешируются PBKDF2-SHA256 (WebCrypto, соль на пользователя).
 *   server — те же методы ходят в REST API (контракт описан в README.md, раздел «API»).
 *
 * Как подключить свой сервер — до подключения api.js задайте:
 *   <script>window.LWL_CONFIG = { apiMode: 'server', apiBaseUrl: 'https://api.example.com' };</script>
 * Больше ничего менять не нужно.
 */
(function () {
  'use strict';

  const CONFIG = Object.assign(
    {
      apiMode: 'demo', // 'demo' | 'server'
      apiBaseUrl: '', // например 'https://api.lwl.example'
      requestTimeoutMs: 15000,
      pollIntervalMs: 4000, // как часто сервер опрашивается на новые сообщения
      demoLatencyMs: [120, 420], // имитация сети в демо, чтобы были видны состояния загрузки
    },
    window.LWL_CONFIG || {}
  );

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
  };

  const APPLICATION_SOURCES = ['Друзья', 'YouTube', 'TikTok', 'Telegram', 'Другое'];
  /** Есть ли у игрока лицензия: от этого зависит, как добавить его на сервер. */
  const LICENSES = { premium: 'Есть лицензия', cracked: 'Нет лицензии' };

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
          NETWORK: 'Нет соединения с сервером. Проверьте интернет.',
          TIMEOUT: 'Сервер долго не отвечает. Попробуйте ещё раз.',
          STORAGE_FULL: 'В браузере закончилось место для данных. Удалите аватар или старые переписки.',
          UNSUPPORTED: 'Недоступно в этом режиме.',
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

  function fieldsError(fields) {
    const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => v));
    if (Object.keys(clean).length) throw new ApiError('VALIDATION', null, { fields: clean });
  }

  /* -------------------------------------------------------------- события */

  // Подписки внутри вкладки + синхронизация между вкладками (BroadcastChannel / storage).
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

  /* --------------------------------------------------------------- сессия */

  const SESSION_KEY = 'lwl.session';
  const session = {
    get() {
      return safe(() => sessionStorage.getItem(SESSION_KEY)) || safe(() => localStorage.getItem(SESSION_KEY)) || null;
    },
    // «Запомнить меня» — токен в localStorage (общий для вкладок), иначе только в этой вкладке.
    // Вход без запоминания не трогает сохранённую сессию других вкладок.
    set(token, remember) {
      if (remember) {
        safe(() => sessionStorage.removeItem(SESSION_KEY));
        safe(() => localStorage.setItem(SESSION_KEY, token));
      } else {
        safe(() => sessionStorage.setItem(SESSION_KEY, token));
      }
    },
    clear() {
      safe(() => sessionStorage.removeItem(SESSION_KEY));
      safe(() => localStorage.removeItem(SESSION_KEY));
    },
  };

  function safe(fn) {
    try {
      return fn();
    } catch (e) {
      return null;
    }
  }

  // Выход в другой вкладке (если сессия общая, через localStorage).
  window.addEventListener('storage', (e) => {
    if (e.key === SESSION_KEY) emitLocal('auth', null);
  });

  /* =========================================================== DEMO BACKEND */

  const demo = (function () {
    const P = 'lwl.v1.';
    const PBKDF2_ITERATIONS = 600000; // OWASP 2023 для PBKDF2-HMAC-SHA256
    const SESSION_TTL = 30 * 24 * 3600 * 1000;
    const ONLINE_MS = 70 * 1000;
    const enc = new TextEncoder();

    function read(key, fallback) {
      const raw = safe(() => localStorage.getItem(P + key));
      if (!raw) return fallback;
      try {
        return JSON.parse(raw);
      } catch (e) {
        return fallback;
      }
    }

    function write(key, value) {
      try {
        localStorage.setItem(P + key, JSON.stringify(value));
      } catch (e) {
        if (e && (e.name === 'QuotaExceededError' || e.code === 22)) throw new ApiError('STORAGE_FULL');
        throw new ApiError('SERVER', 'Браузер не даёт сохранить данные (приватный режим?).');
      }
    }

    function remove(key) {
      safe(() => localStorage.removeItem(P + key));
    }

    async function latency() {
      const [a, b] = CONFIG.demoLatencyMs;
      const fail = Number(new URLSearchParams(location.search).get('demoFail') || 0);
      await new Promise((r) => setTimeout(r, a + Math.random() * (b - a)));
      if (fail && Math.random() < fail) throw new ApiError('NETWORK', 'Демо: имитация сбоя сети (параметр ?demoFail).');
    }

    const id = (p) => p + '_' + Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => b.toString(36).padStart(2, '0')).join('');
    const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, '0')).join('');
    const fromHex = (s) => new Uint8Array(s.match(/../g).map((h) => parseInt(h, 16)));

    async function hash(password, saltHex, iterations) {
      const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
      const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations }, key, 256);
      return hex(bits);
    }

    function equal(a, b) {
      if (a.length !== b.length) return false;
      let diff = 0;
      for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
      return diff === 0;
    }

    async function makePassword(password) {
      const salt = hex(crypto.getRandomValues(new Uint8Array(16)));
      return { salt, iterations: PBKDF2_ITERATIONS, hash: await hash(password, salt, PBKDF2_ITERATIONS) };
    }

    async function checkPassword(user, password) {
      const h = await hash(password, user.password.salt, user.password.iterations);
      return equal(h, user.password.hash);
    }

    const publicUser = (u) =>
      u && { id: u.id, nickname: u.nickname, email: u.email, role: u.role, avatar: u.avatar || null, createdAt: u.createdAt, lastSeenAt: u.lastSeenAt || u.createdAt };

    const brief = (u) =>
      u ? { id: u.id, nickname: u.nickname, role: u.role, avatar: u.avatar || null, online: Date.now() - (u.lastSeenAt || 0) < ONLINE_MS, lastSeenAt: u.lastSeenAt || null } : null;

    const users = () => read('users', {});
    const findBy = (field, value) => Object.values(users()).find((u) => String(u[field]).toLowerCase() === String(value).toLowerCase());

    function currentUser() {
      const token = session.get();
      if (!token) return null;
      const s = read('sessions', {})[token];
      if (!s || s.expiresAt < Date.now()) return null;
      return users()[s.userId] || null;
    }

    function requireUser() {
      const u = currentUser();
      if (!u) throw new ApiError('UNAUTHORIZED');
      return u;
    }

    function requireAdmin() {
      const u = requireUser();
      if (u.role !== 'admin') throw new ApiError('FORBIDDEN');
      return u;
    }

    function saveUser(u) {
      const all = users();
      all[u.id] = u;
      write('users', all);
    }

    function startSession(user, remember) {
      const token = id('s') + id('');
      const sessions = read('sessions', {});
      for (const [t, s] of Object.entries(sessions)) if (s.expiresAt < Date.now()) delete sessions[t];
      sessions[token] = { userId: user.id, createdAt: Date.now(), expiresAt: Date.now() + SESSION_TTL };
      write('sessions', sessions);
      session.set(token, remember);
    }

    /* ----- ограничение попыток входа ----- */
    function attempts(key) {
      const all = read('attempts', {});
      return { all, rec: all[key] || { count: 0, until: 0 } };
    }

    function checkLock(key) {
      const { rec } = attempts(key);
      if (rec.until > Date.now()) {
        const retryAfter = Math.ceil((rec.until - Date.now()) / 1000);
        throw new ApiError('RATE_LIMITED', `Слишком много попыток. Попробуйте через ${retryAfter} с.`, { retryAfter });
      }
    }

    function registerFail(key) {
      const { all, rec } = attempts(key);
      rec.count = rec.until && rec.until < Date.now() ? 1 : rec.count + 1;
      rec.until = rec.count >= 5 ? Date.now() + 60 * 1000 : 0;
      if (rec.count >= 5) rec.count = 0;
      all[key] = rec;
      write('attempts', all);
    }

    function clearFails(key) {
      const { all } = attempts(key);
      delete all[key];
      write('attempts', all);
    }

    /* ----- чаты ----- */
    const conversations = () => read('conversations', {});
    const messagesOf = (cid) => read('messages.' + cid, []);

    function saveConversation(c) {
      const all = conversations();
      all[c.id] = c;
      write('conversations', all);
    }

    function canAccess(user, c) {
      return c && (user.role === 'admin' || c.playerId === user.id);
    }

    function unreadFor(user, c) {
      const since = (c.readAt && c.readAt[user.id]) || 0;
      return messagesOf(c.id).filter((m) => m.createdAt > since && m.authorId !== user.id && (m.authorId !== 'system' || user.role !== 'admin')).length;
    }

    function partnerFor(user, c) {
      if (user.role === 'admin' && c.playerId !== user.id) return brief(users()[c.playerId]);
      // для игрока собеседник — последний ответивший администратор
      const all = users();
      const last = messagesOf(c.id)
        .slice()
        .reverse()
        .find((m) => m.authorId !== user.id && all[m.authorId]);
      return last ? brief(all[last.authorId]) : null;
    }

    function conversationView(user, c) {
      const msgs = messagesOf(c.id);
      const last = msgs[msgs.length - 1] || null;
      return {
        id: c.id,
        status: c.status,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
        player: brief(users()[c.playerId]),
        partner: partnerFor(user, c),
        lastMessage: last && { text: last.text, authorId: last.authorId, createdAt: last.createdAt },
        messageCount: msgs.length,
        unread: unreadFor(user, c),
      };
    }

    function messageView(m, all) {
      const author = m.authorId === 'system' ? null : all[m.authorId];
      return { id: m.id, clientId: m.clientId || null, text: m.text, createdAt: m.createdAt, authorId: m.authorId, system: m.authorId === 'system', author: author ? brief(author) : null };
    }

    /* ----- заявки ----- */
    const applications = () => read('applications', {});

    function applicationView(a) {
      const all = users();
      return Object.assign({}, a, { applicant: brief(all[a.userId]), reviewer: a.reviewerId ? brief(all[a.reviewerId]) : null });
    }

    function deleteUserData(userId) {
      const apps = applications();
      for (const [k, a] of Object.entries(apps)) if (a.userId === userId) delete apps[k];
      write('applications', apps);
      const convs = conversations();
      for (const [k, c] of Object.entries(convs)) {
        if (c.playerId === userId) {
          delete convs[k];
          remove('messages.' + k);
        }
      }
      write('conversations', convs);
      const sessions = read('sessions', {});
      for (const [t, s] of Object.entries(sessions)) if (s.userId === userId) delete sessions[t];
      write('sessions', sessions);
    }

    return {
      async register({ nickname, email, password, remember }) {
        nickname = String(nickname || '').trim();
        email = String(email || '').trim().toLowerCase();
        fieldsError({ nickname: validate.nickname(nickname), email: validate.email(email), password: validate.password(password) });
        await latency();
        if (findBy('nickname', nickname)) throw new ApiError('NICK_TAKEN', null, { fields: { nickname: 'Этот никнейм уже занят.' } });
        if (findBy('email', email)) throw new ApiError('EMAIL_TAKEN', null, { fields: { email: 'Аккаунт с этой почтой уже есть.' } });
        const now = Date.now();
        const user = { id: id('u'), nickname, email, role: 'player', avatar: null, createdAt: now, lastSeenAt: now, password: await makePassword(password) };
        saveUser(user);
        startSession(user, remember);
        emit('auth', publicUser(user));
        return publicUser(user);
      },

      async login({ login, password, remember }) {
        login = String(login || '').trim();
        fieldsError({ login: login ? '' : 'Введите никнейм или почту.', password: password ? '' : 'Введите пароль.' });
        const key = login.toLowerCase();
        checkLock(key);
        await latency();
        const user = login.includes('@') ? findBy('email', login) : findBy('nickname', login);
        // хешируем даже для несуществующего пользователя, чтобы время ответа не выдавало, есть ли аккаунт
        const ok = user ? await checkPassword(user, password) : (await hash(password, '00'.repeat(16), PBKDF2_ITERATIONS), false);
        if (!ok) {
          registerFail(key);
          throw new ApiError('INVALID_CREDENTIALS');
        }
        clearFails(key);
        user.lastSeenAt = Date.now();
        saveUser(user);
        startSession(user, remember);
        emit('auth', publicUser(user));
        return publicUser(user);
      },

      async logout() {
        const token = session.get();
        const sessions = read('sessions', {});
        if (token) delete sessions[token];
        write('sessions', sessions);
        session.clear();
        emit('auth', null);
      },

      async me() {
        await latency();
        return publicUser(currentUser());
      },

      async requestPasswordReset() {
        await latency();
        throw new ApiError('UNSUPPORTED', 'В демо-режиме письма не отправляются. Восстановление заработает после подключения сервера.');
      },

      async updateProfile({ nickname, avatar }) {
        const user = requireUser();
        const f = {};
        if (nickname !== undefined) {
          nickname = String(nickname).trim();
          f.nickname = validate.nickname(nickname);
          const other = !f.nickname && findBy('nickname', nickname);
          if (other && other.id !== user.id) f.nickname = 'Этот никнейм уже занят.';
        }
        if (avatar !== undefined && avatar !== null) {
          if (!/^data:image\/(jpeg|png|webp);base64,/.test(avatar)) f.avatar = 'Поддерживаются JPG, PNG и WebP.';
          else if (avatar.length * 0.75 > LIMITS.avatarBytes) f.avatar = 'Картинка слишком большая.';
        }
        fieldsError(f);
        await latency();
        if (nickname !== undefined) user.nickname = nickname;
        if (avatar !== undefined) user.avatar = avatar;
        saveUser(user);
        emit('auth', publicUser(user));
        return publicUser(user);
      },

      async changePassword({ currentPassword, newPassword }) {
        const user = requireUser();
        fieldsError({ currentPassword: currentPassword ? '' : 'Введите текущий пароль.', newPassword: validate.password(newPassword) });
        await latency();
        if (!(await checkPassword(user, currentPassword))) throw new ApiError('INVALID_CREDENTIALS', 'Текущий пароль неверный.', { fields: { currentPassword: 'Неверный пароль.' } });
        if (currentPassword === newPassword) throw new ApiError('VALIDATION', null, { fields: { newPassword: 'Новый пароль совпадает со старым.' } });
        user.password = await makePassword(newPassword);
        saveUser(user);
        // остальные сессии этого пользователя завершаем
        const token = session.get();
        const sessions = read('sessions', {});
        for (const [t, s] of Object.entries(sessions)) if (s.userId === user.id && t !== token) delete sessions[t];
        write('sessions', sessions);
        return true;
      },

      async deleteAccount({ password }) {
        const user = requireUser();
        fieldsError({ password: password ? '' : 'Введите пароль.' });
        await latency();
        if (!(await checkPassword(user, password))) throw new ApiError('INVALID_CREDENTIALS', 'Неверный пароль.', { fields: { password: 'Неверный пароль.' } });
        deleteUserData(user.id);
        const all = users();
        delete all[user.id];
        write('users', all);
        session.clear();
        emit('auth', null);
        emit('conversations');
        emit('applications');
        return true;
      },

      async setDemoRole(role) {
        const user = requireUser();
        if (!['player', 'admin'].includes(role)) throw new ApiError('VALIDATION');
        await latency();
        user.role = role;
        saveUser(user);
        emit('auth', publicUser(user));
        return publicUser(user);
      },

      async heartbeat() {
        const user = currentUser();
        if (!user) return;
        user.lastSeenAt = Date.now();
        saveUser(user);
      },

      /* ----- заявки ----- */
      async myApplication() {
        const user = requireUser();
        await latency();
        const mine = Object.values(applications())
          .filter((a) => a.userId === user.id)
          .sort((a, b) => b.createdAt - a.createdAt);
        return mine[0] ? applicationView(mine[0]) : null;
      },

      async submitApplication(data) {
        const user = requireUser();
        fieldsError(validate.application(data));
        await latency();
        const apps = applications();
        if (Object.values(apps).some((a) => a.userId === user.id && (a.status === 'pending' || a.status === 'approved'))) throw new ApiError('CONFLICT', 'У вас уже есть активная заявка.');
        const now = Date.now();
        const app = {
          id: id('a'),
          userId: user.id,
          nickname: user.nickname,
          age: Number(data.age),
          about: String(data.about).trim(),
          source: data.source,
          license: data.license,
          contact: String(data.contact || '').trim(),
          status: 'pending',
          comment: '',
          reviewerId: null,
          createdAt: now,
          updatedAt: now,
          history: [{ status: 'pending', at: now }],
        };
        apps[app.id] = app;
        write('applications', apps);
        emit('applications');
        return applicationView(app);
      },

      async withdrawApplication(appId) {
        const user = requireUser();
        await latency();
        const apps = applications();
        const app = apps[appId];
        if (!app || app.userId !== user.id) throw new ApiError('NOT_FOUND', 'Заявка не найдена.');
        if (app.status !== 'pending') throw new ApiError('CONFLICT', 'Заявку уже рассмотрели — отозвать нельзя.');
        app.status = 'withdrawn';
        app.updatedAt = Date.now();
        app.history.push({ status: 'withdrawn', at: app.updatedAt });
        write('applications', apps);
        emit('applications');
        return applicationView(app);
      },

      async listApplications({ status = 'pending', query = '' } = {}) {
        requireAdmin();
        await latency();
        const all = Object.values(applications());
        const counts = { pending: 0, approved: 0, rejected: 0, withdrawn: 0 };
        all.forEach((a) => (counts[a.status] = (counts[a.status] || 0) + 1));
        const q = String(query).trim().toLowerCase();
        const items = all
          .filter((a) => status === 'all' || a.status === status)
          .filter((a) => !q || a.nickname.toLowerCase().includes(q) || a.about.toLowerCase().includes(q))
          .sort((a, b) => (status === 'pending' ? a.createdAt - b.createdAt : b.updatedAt - a.updatedAt))
          .map(applicationView);
        return { items, counts };
      },

      async getApplication(appId) {
        const user = requireUser();
        await latency();
        const app = applications()[appId];
        if (!app || (user.role !== 'admin' && app.userId !== user.id)) throw new ApiError('NOT_FOUND', 'Заявка не найдена.');
        return applicationView(app);
      },

      async reviewApplication(appId, { status, comment }) {
        const admin = requireAdmin();
        comment = String(comment || '').trim();
        const f = {};
        if (!['approved', 'rejected'].includes(status)) f.status = 'Выберите решение.';
        if (status === 'rejected' && comment.length < LIMITS.reviewComment.min) f.comment = 'Напишите причину отказа — игрок её увидит.';
        if (comment.length > LIMITS.reviewComment.max) f.comment = `Максимум ${LIMITS.reviewComment.max} символов.`;
        fieldsError(f);
        await latency();
        const apps = applications();
        const app = apps[appId];
        if (!app) throw new ApiError('NOT_FOUND', 'Заявка не найдена.');
        if (app.status !== 'pending') throw new ApiError('CONFLICT', 'Эту заявку уже рассмотрели или отозвали.');
        app.status = status;
        app.comment = comment;
        app.reviewerId = admin.id;
        app.updatedAt = Date.now();
        app.history.push({ status, at: app.updatedAt, by: admin.id });
        write('applications', apps);
        emit('applications');
        return applicationView(app);
      },

      /* ----- обращения и сообщения ----- */
      async supportConversation() {
        const user = requireUser();
        await latency();
        let c = Object.values(conversations()).find((x) => x.playerId === user.id);
        if (!c) {
          const now = Date.now();
          c = { id: id('c'), playerId: user.id, status: 'open', createdAt: now, updatedAt: now, readAt: {} };
          saveConversation(c);
        }
        return conversationView(user, c);
      },

      async listConversations({ status = 'open', query = '' } = {}) {
        const user = requireAdmin();
        await latency();
        const q = String(query).trim().toLowerCase();
        const all = users();
        return Object.values(conversations())
          .filter((c) => messagesOf(c.id).some((m) => m.authorId === c.playerId))
          .filter((c) => status === 'all' || c.status === status)
          .filter((c) => !q || ((all[c.playerId] && all[c.playerId].nickname) || '').toLowerCase().includes(q))
          .map((c) => conversationView(user, c))
          .sort((a, b) => b.unread - a.unread || b.updatedAt - a.updatedAt);
      },

      async getConversation(cid) {
        const user = requireUser();
        await latency();
        const c = conversations()[cid];
        if (!canAccess(user, c)) throw new ApiError('NOT_FOUND', 'Обращение не найдено.');
        return conversationView(user, c);
      },

      async listMessages(cid, { before = 0, limit = 50 } = {}) {
        const user = requireUser();
        await latency();
        const c = conversations()[cid];
        if (!canAccess(user, c)) throw new ApiError('NOT_FOUND', 'Обращение не найдено.');
        const all = users();
        let msgs = messagesOf(cid);
        if (before) msgs = msgs.filter((m) => m.createdAt < before);
        const items = msgs.slice(-limit).map((m) => messageView(m, all));
        return { items, hasMore: msgs.length > limit };
      },

      async sendMessage(cid, { text, clientId }) {
        const user = requireUser();
        const err = validate.message(text);
        if (err) throw new ApiError('VALIDATION', err, { fields: { text: err } });
        await latency();
        const all = conversations();
        const c = all[cid];
        if (!canAccess(user, c)) throw new ApiError('NOT_FOUND', 'Обращение не найдено.');
        const msgs = messagesOf(cid);
        const dup = clientId && msgs.find((m) => m.clientId === clientId);
        if (dup) return messageView(dup, users());
        const now = Date.now();
        const isFirstFromPlayer = user.id === c.playerId && !msgs.some((m) => m.authorId === c.playerId);
        const msg = { id: id('m'), clientId: clientId || null, authorId: user.id, text: String(text).trim(), createdAt: now };
        msgs.push(msg);
        if (isFirstFromPlayer) {
          msgs.push({ id: id('m'), authorId: 'system', text: 'Спасибо за обращение! Администратор ответит здесь, как только освободится. Уведомлений на почту пока нет — загляните позже.', createdAt: now + 1 });
        }
        write('messages.' + cid, msgs);
        c.updatedAt = now;
        if (user.id === c.playerId && c.status === 'closed') c.status = 'open';
        c.readAt = Object.assign({}, c.readAt, { [user.id]: now + 1 });
        all[cid] = c;
        write('conversations', all);
        user.lastSeenAt = now;
        saveUser(user);
        emit('messages', { conversationId: cid });
        emit('conversations');
        return messageView(msg, users());
      },

      async markRead(cid) {
        const user = requireUser();
        const all = conversations();
        const c = all[cid];
        if (!canAccess(user, c)) return;
        c.readAt = Object.assign({}, c.readAt, { [user.id]: Date.now() });
        write('conversations', all);
        emit('conversations');
      },

      async setConversationStatus(cid, status) {
        requireAdmin();
        await latency();
        const all = conversations();
        const c = all[cid];
        if (!c) throw new ApiError('NOT_FOUND', 'Обращение не найдено.');
        c.status = status;
        c.updatedAt = Date.now();
        write('conversations', all);
        emit('conversations');
        emit('messages', { conversationId: cid });
        return true;
      },

      async summary() {
        const user = requireUser();
        const convs = Object.values(conversations());
        if (user.role === 'admin') {
          const visible = convs.filter((c) => messagesOf(c.id).some((m) => m.authorId === c.playerId));
          return {
            pendingApplications: Object.values(applications()).filter((a) => a.status === 'pending').length,
            unreadConversations: visible.filter((c) => unreadFor(user, c) > 0).length,
          };
        }
        const mine = convs.find((c) => c.playerId === user.id);
        const app = Object.values(applications())
          .filter((a) => a.userId === user.id)
          .sort((a, b) => b.createdAt - a.createdAt)[0];
        return { unreadMessages: mine ? unreadFor(user, mine) : 0, applicationStatus: app ? app.status : null };
      },
    };
  })();

  /* ========================================================= SERVER BACKEND */

  const server = (function () {
    async function http(method, path, body) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), CONFIG.requestTimeoutMs);
      const headers = { Accept: 'application/json' };
      const token = session.get();
      if (token) headers.Authorization = 'Bearer ' + token;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      let res;
      try {
        res = await fetch(CONFIG.apiBaseUrl.replace(/\/$/, '') + path, {
          method,
          headers,
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: 'include',
          signal: ctrl.signal,
        });
      } catch (e) {
        throw new ApiError(e.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK');
      } finally {
        clearTimeout(timer);
      }
      const data = res.status === 204 ? null : await res.json().catch(() => null);
      if (res.ok) return data;
      const code = (data && data.code) || { 400: 'VALIDATION', 401: 'UNAUTHORIZED', 403: 'FORBIDDEN', 404: 'NOT_FOUND', 409: 'CONFLICT', 422: 'VALIDATION', 429: 'RATE_LIMITED' }[res.status] || 'SERVER';
      if (code === 'UNAUTHORIZED' && token) {
        session.clear();
        emit('auth', null);
      }
      throw new ApiError(code, data && data.message, { fields: data && data.fields, retryAfter: Number(res.headers.get('Retry-After')) || 0 });
    }

    const q = (params) => {
      const s = new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined && v !== '' && v !== 0)).toString();
      return s ? '?' + s : '';
    };

    async function authenticate(path, payload, remember) {
      const data = await http('POST', path, payload);
      if (data && data.token) session.set(data.token, remember);
      emit('auth', data.user);
      return data.user;
    }

    return {
      register: ({ nickname, email, password, remember }) => authenticate('/auth/register', { nickname, email, password }, remember),
      login: ({ login, password, remember }) => authenticate('/auth/login', { login, password, remember: !!remember }, remember),
      async logout() {
        await http('POST', '/auth/logout').catch(() => null);
        session.clear();
        emit('auth', null);
      },
      async me() {
        // Без токена всё равно спрашиваем сервер: авторизация может быть на httpOnly-куке.
        try {
          return (await http('GET', '/auth/me')).user;
        } catch (e) {
          if (e.code === 'UNAUTHORIZED') return null;
          throw e;
        }
      },
      requestPasswordReset: ({ email }) => http('POST', '/auth/password-reset', { email }),
      async updateProfile(patch) {
        const user = (await http('PATCH', '/me', patch)).user;
        emit('auth', user);
        return user;
      },
      changePassword: (p) => http('POST', '/me/password', p).then(() => true),
      async deleteAccount(p) {
        await http('DELETE', '/me', p);
        session.clear();
        emit('auth', null);
        return true;
      },
      setDemoRole: () => Promise.reject(new ApiError('UNSUPPORTED', 'Роль назначается на сервере.')),
      heartbeat: () => http('POST', '/me/presence').catch(() => null),

      myApplication: () => http('GET', '/applications/mine').then((d) => d.application),
      submitApplication: (data) => http('POST', '/applications', data).then((d) => (emit('applications'), d.application)),
      withdrawApplication: (id) => http('POST', `/applications/${encodeURIComponent(id)}/withdraw`).then((d) => (emit('applications'), d.application)),
      listApplications: ({ status = 'pending', query = '' } = {}) => http('GET', '/applications' + q({ status, q: query })),
      getApplication: (id) => http('GET', `/applications/${encodeURIComponent(id)}`).then((d) => d.application),
      reviewApplication: (id, body) => http('POST', `/applications/${encodeURIComponent(id)}/review`, body).then((d) => (emit('applications'), d.application)),

      supportConversation: () => http('POST', '/support/conversation').then((d) => d.conversation),
      listConversations: ({ status = 'open', query = '' } = {}) => http('GET', '/conversations' + q({ status, q: query })).then((d) => d.items),
      getConversation: (id) => http('GET', `/conversations/${encodeURIComponent(id)}`).then((d) => d.conversation),
      listMessages: (id, { before = 0, limit = 50 } = {}) => http('GET', `/conversations/${encodeURIComponent(id)}/messages` + q({ before, limit })),
      sendMessage: (id, body) => http('POST', `/conversations/${encodeURIComponent(id)}/messages`, body).then((d) => (emit('messages', { conversationId: id }), d.message)),
      markRead: (id) => http('POST', `/conversations/${encodeURIComponent(id)}/read`).catch(() => null),
      setConversationStatus: (id, status) => http('POST', `/conversations/${encodeURIComponent(id)}/${status === 'closed' ? 'close' : 'reopen'}`).then(() => (emit('conversations'), true)),
      summary: () => http('GET', '/me/summary'),
    };
  })();

  const backend = CONFIG.apiMode === 'server' ? server : demo;

  /* ======================================================= ПУБЛИЧНЫЙ ИНТЕРФЕЙС */

  // Опрос сервера для «живых» обновлений. В демо события приходят мгновенно
  // (BroadcastChannel), опрос нужен только чтобы обновлять статус «в сети».
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
    const beat = () => document.visibilityState === 'visible' && backend.heartbeat();
    beat();
    heartbeatTimer = setInterval(beat, 25000);
    document.addEventListener('visibilitychange', beat);
  }

  window.Api = {
    mode: CONFIG.apiMode,
    config: CONFIG,
    LIMITS,
    APPLICATION_SOURCES,
    LICENSES,
    ApiError,
    validate,
    on,

    auth: {
      register: (data) => backend.register(data),
      login: (data) => backend.login(data),
      logout: () => backend.logout(),
      me: () => backend.me(),
      requestPasswordReset: (data) => backend.requestPasswordReset(data),
      hasSession: () => !!session.get(),
      onChange: (cb) => on('auth', cb),
    },

    profile: {
      update: (patch) => backend.updateProfile(patch),
      changePassword: (data) => backend.changePassword(data),
      deleteAccount: (data) => backend.deleteAccount(data),
      setDemoRole: (role) => backend.setDemoRole(role),
      startPresence: startHeartbeat,
    },

    applications: {
      mine: () => backend.myApplication(),
      submit: (data) => backend.submitApplication(data),
      withdraw: (id) => backend.withdrawApplication(id),
      list: (params) => backend.listApplications(params),
      get: (id) => backend.getApplication(id),
      review: (id, decision) => backend.reviewApplication(id, decision),
      onChange: (cb) => on('applications', cb),
    },

    chats: {
      support: () => backend.supportConversation(),
      list: (params) => backend.listConversations(params),
      get: (id) => backend.getConversation(id),
      messages: (id, params) => backend.listMessages(id, params),
      send: (id, body) => backend.sendMessage(id, body),
      markRead: (id) => backend.markRead(id),
      close: (id) => backend.setConversationStatus(id, 'closed'),
      reopen: (id) => backend.setConversationStatus(id, 'open'),
      onListChange: (cb) => on('conversations', cb),
      /** Новые сообщения в диалоге: cb() вызывается, когда стоит перечитать ленту. */
      subscribe(id, cb) {
        const off = on('messages', (p) => p && p.conversationId === id && cb());
        const stop = poll(async () => cb(), CONFIG.apiMode === 'server' ? CONFIG.pollIntervalMs : 20000);
        return () => {
          off();
          stop();
        };
      },
    },

    summary: () => backend.summary(),
  };
})();
