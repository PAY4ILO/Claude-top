/*
 * Личный кабинет: каркас приложения, роутер и экраны.
 * Роли: user «Пользователь» (после регистрации) → player «Игрок» (заявку одобрили) → admin «Админ».
 *   #/                          — главная (пользователь/игрок | админ)
 *   #/server                    — «Сервер»: адрес, как зайти, сборки (игрок); у админа — управление
 *   #/application               — моя заявка (анкета, если заявки ещё нет)
 *   #/apply                     — анкета
 *   #/support                   — чат с тех поддержкой
 *   #/profile                   — профиль
 *   #/admin/applications[/id]   — заявки: список | карточка заявки
 *   #/admin/tickets[/id]        — обращения: список | чат
 *   #/admin/users[/id]          — пользователи и роли, ссылки для сброса пароля
 *   #/reset/<токен>             — новый пароль по ссылке от администратора (без входа)
 */
(function () {
  'use strict';
  const { h, icon, clear, field } = UI;
  const app = document.getElementById('app');
  const navEl = document.getElementById('app-nav');
  const tabbar = document.getElementById('tabbar');
  const userMenu = document.getElementById('user-menu');

  let me = null;
  let cleanup = null;
  let screen = null; // { name, key, update(parts, query) } — для экранов со списком слева
  let summary = {};

  const STATUS = { pending: 'На рассмотрении', approved: 'Одобрена', rejected: 'Отклонена', withdrawn: 'Отозвана' };
  const ROLE = Api.ROLES;
  // Ссылки на Telegram/Discord задаёт админ; пока не задали — кнопки не показываем.
  let links = { telegramUrl: '', discordUrl: '' };
  const telegramUrl = () => (/^https:\/\//.test(links.telegramUrl || '') ? links.telegramUrl : '');
  const isPlayer = () => me && (me.role === 'player' || me.role === 'admin');

  /* ============================================================ запуск */

  async function boot() {
    showLoading();
    Api.settings.public().then((l) => (links = l));
    // Ссылка для нового пароля открывается и без входа.
    const { parts } = parseHash();
    if (parts[0] === 'reset' && parts[1]) return renderReset(decodeURIComponent(parts[1]));
    try {
      me = await Api.auth.me();
    } catch (err) {
      return renderFatal(err, boot);
    }
    if (!me) return renderGate();
    Api.profile.startPresence();
    renderShell();
    route();
    updateSummary();
  }

  // Событие может прийти из другой вкладки (с другим аккаунтом) — перечитываем пользователя этой вкладки.
  Api.auth.onChange(async () => {
    if (!me) return;
    let user;
    try {
      user = await Api.auth.me();
    } catch (e) {
      return;
    }
    if (!user) {
      me = null;
      return renderGate();
    }
    const changed = me.role !== user.role || me.id !== user.id;
    const updated = me.nickname !== user.nickname || me.avatar !== user.avatar;
    me = user;
    if (changed) {
      renderShell();
      screen = null;
      route();
      updateSummary();
    } else if (updated) {
      renderShell();
    }
  });

  Api.on('conversations', () => updateSummary());
  Api.on('applications', () => updateSummary());
  Api.on('users', () => updateSummary());
  setInterval(() => me && document.visibilityState === 'visible' && updateSummary(), 20000);

  window.addEventListener('hashchange', () => {
    if (parseHash().parts[0] === 'reset') return boot();
    if (me) route();
  });

  function parseHash() {
    const raw = location.hash.replace(/^#\/?/, '');
    const [path, query] = raw.split('?');
    return { parts: path.split('/').filter(Boolean), query: new URLSearchParams(query || '') };
  }

  function go(hash) {
    if (location.hash === hash) route();
    else location.hash = hash;
  }

  function route() {
    const { parts, query } = parseHash();
    const [a, b, c] = parts;

    // экраны «список + карточка» не перерисовываем целиком при смене выбранного элемента
    const splitName = a === 'admin' && (b === 'applications' || b === 'tickets' || b === 'users') ? b : null;
    if (splitName && screen && screen.name === splitName && screen.key === query.toString()) {
      screen.select(c ? decodeURIComponent(c) : null);
      setActive(splitName);
      return;
    }

    if (cleanup) cleanup();
    cleanup = null;
    screen = null;
    document.body.classList.remove('lk--chat', 'lk--detail');
    window.scrollTo(0, 0);

    if (!a) return renderDashboard();
    if (a === 'application') return renderApplication();
    if (a === 'apply') return renderApply();
    if (a === 'support') return renderSupport();
    if (a === 'profile') return renderProfile();
    if (a === 'server') {
      if (!isPlayer()) return renderServerLocked();
      return me.role === 'admin' && query.get('preview') !== '1' ? renderServerAdmin() : renderServer();
    }
    if (splitName) {
      if (me.role !== 'admin') return renderForbidden();
      if (splitName === 'users') return renderUsers(query, c);
      return splitName === 'applications' ? renderApplications(query, c) : renderTickets(query, c);
    }
    renderNotFound();
  }

  /* ============================================================ каркас */

  function navItems() {
    if (me.role === 'admin') {
      return [
        { key: 'home', href: '#/', icon: 'home', label: 'Главная' },
        { key: 'applications', href: '#/admin/applications', icon: 'file', label: 'Заявки', badge: summary.pendingApplications },
        { key: 'tickets', href: '#/admin/tickets', icon: 'chat', label: 'Обращения', short: 'Чаты', badge: summary.unreadConversations },
        { key: 'users', href: '#/admin/users', icon: 'users', label: 'Люди', badge: summary.resetRequests },
        { key: 'server', href: '#/server', icon: 'server', label: 'Сервер' },
        { key: 'profile', href: '#/profile', icon: 'user', label: 'Профиль' },
      ];
    }
    // «Сервер» (адрес, сборки) открывается, когда заявку одобрили и выдали роль «Игрок».
    return [
      { key: 'home', href: '#/', icon: 'home', label: 'Главная' },
      isPlayer() && { key: 'server', href: '#/server', icon: 'server', label: 'Сервер' },
      { key: 'application', href: '#/application', icon: 'file', label: 'Заявка' },
      { key: 'support', href: '#/support', icon: 'chat', label: 'Поддержка', badge: summary.unreadMessages },
      { key: 'profile', href: '#/profile', icon: 'user', label: 'Профиль' },
    ].filter(Boolean);
  }

  function badgeEl(n) {
    return h('span', { class: 'nav-badge', hidden: !n, text: n ? String(n > 99 ? '99+' : n) : '' });
  }

  function renderShell() {
    navEl.hidden = false;
    tabbar.hidden = false;
    document.body.classList.add('lk--app');
    const items = navItems();

    clear(navEl).append(
      h(
        'a',
        { class: 'nav-profile', href: '#/profile' },
        UI.avatar(me, 48),
        h('span', { class: 'nav-profile__text' }, h('span', { class: 'nav-profile__name', text: me.nickname }), roleBadge(me.role))
      ),
      h(
        'nav',
        { class: 'nav-list', 'aria-label': 'Разделы' },
        items.map((it) => h('a', { class: 'nav-link', href: it.href, dataset: { key: it.key } }, icon(it.icon), h('span', { text: it.label }), badgeEl(it.badge)))
      ),
      h(
        'div',
        { class: 'nav-foot' },
        h('a', { class: 'nav-link', href: 'index.html' }, icon('external'), h('span', { text: 'На сайт' })),
        h('button', { class: 'nav-link', type: 'button', onclick: onLogout }, icon('logout'), h('span', { text: 'Выйти' }))
      )
    );

    clear(tabbar).append(
      ...items.map((it) => h('a', { class: 'tab', href: it.href, dataset: { key: it.key } }, h('span', { class: 'tab__icon' }, icon(it.icon), badgeEl(it.badge)), h('span', { class: 'tab__label', text: it.short || it.label })))
    );

    // меню пользователя в шапке
    const menu = h(
      'div',
      { class: 'menu', role: 'menu', hidden: true },
      h('div', { class: 'menu__head' }, h('p', { class: 'menu__name' }, me.nickname, ' ', roleBadge(me.role)), h('p', { class: 'menu__email', text: me.email })),
      h('a', { class: 'menu__item', role: 'menuitem', href: '#/profile' }, icon('user'), 'Профиль'),
      h('a', { class: 'menu__item', role: 'menuitem', href: 'index.html' }, icon('external'), 'На сайт'),
      h('button', { class: 'menu__item', role: 'menuitem', type: 'button', onclick: onLogout }, icon('logout'), 'Выйти')
    );
    const btn = h(
      'button',
      { class: 'user-btn', type: 'button', 'aria-haspopup': 'menu', 'aria-expanded': 'false', 'aria-label': 'Меню пользователя' },
      UI.avatar(me, 36),
      h('span', { class: 'user-btn__name', text: me.nickname }),
      icon('chevronDown')
    );
    const toggle = (open) => {
      menu.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      if (open) (menu.querySelector('.menu__item') || menu).focus();
    };
    btn.addEventListener('click', () => toggle(menu.hidden));
    menu.addEventListener('click', (e) => e.target.closest('.menu__item') && toggle(false));
    clear(userMenu).append(btn, menu);
    if (!userMenu.dataset.bound) {
      userMenu.dataset.bound = '1';
      document.addEventListener('click', (e) => {
        const m = userMenu.querySelector('.menu');
        if (m && !m.hidden && !userMenu.contains(e.target)) userMenu.querySelector('.user-btn').click();
      });
      document.addEventListener('keydown', (e) => {
        const m = userMenu.querySelector('.menu');
        if (e.key === 'Escape' && m && !m.hidden) {
          userMenu.querySelector('.user-btn').click();
          userMenu.querySelector('.user-btn').focus();
        }
      });
    }
    setActive(currentKey());
  }

  function hideShell() {
    navEl.hidden = true;
    tabbar.hidden = true;
    clear(userMenu);
    document.body.classList.remove('lk--app', 'lk--chat', 'lk--detail');
  }

  function currentKey() {
    const [a, b] = parseHash().parts;
    if (!a) return 'home';
    if (a === 'apply') return 'application';
    if (a === 'admin') return b;
    return a;
  }

  function setActive(key) {
    document.querySelectorAll('.nav-link[data-key], .tab[data-key]').forEach((el) => {
      if (el.dataset.key === key) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });
  }

  async function updateSummary() {
    if (!me) return;
    try {
      summary = await Api.summary();
    } catch (e) {
      return;
    }
    // Роль поменяли на сервере (одобрили заявку, выдали/сняли админа) — перестраиваем кабинет.
    if (summary.role && summary.role !== me.role) {
      const user = await Api.auth.me().catch(() => null);
      if (!user) return;
      me = user;
      renderShell();
      screen = null;
      route();
      return;
    }
    const counts = { applications: summary.pendingApplications, tickets: summary.unreadConversations, support: summary.unreadMessages, users: summary.resetRequests };
    document.querySelectorAll('[data-key]').forEach((el) => {
      const b = el.querySelector('.nav-badge');
      if (!b) return;
      const n = counts[el.dataset.key];
      b.hidden = !n;
      b.textContent = n ? String(n > 99 ? '99+' : n) : '';
    });
    const total = (summary.unreadMessages || 0) + (summary.unreadConversations || 0);
    document.title = document.title.replace(/^\(\d+\) /, '');
    if (total) document.title = `(${total}) ${document.title}`;
  }

  /* ============================================================ общие блоки */

  function showLoading() {
    clear(app).append(h('div', { class: 'lk-loading', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { class: 'visually-hidden', text: 'Загрузка…' })));
  }

  function page({ title, sub, actions, fill, key }) {
    setActive(key || currentKey());
    const titleEl = h('h1', { class: 'page-title', tabindex: '-1', text: title });
    const head = h('header', { class: 'page-head' }, h('div', {}, titleEl, sub && h('p', { class: 'page-sub', text: sub })), actions && h('div', { class: 'page-actions' }, actions));
    const body = h('div', { class: 'page-body' });
    const root = h('div', { class: 'page' + (fill ? ' page--fill' : '') }, head, body);
    clear(app).append(root);
    document.title = `${title} — LWL`;
    updateSummary();
    requestAnimationFrame(() => titleEl.focus({ preventScroll: true }));
    return { root, head, body, titleEl };
  }

  function stateBlock({ iconName, logo, title, text, action, error, compact }) {
    return h(
      'div',
      { class: 'state' + (error ? ' state--error' : '') + (compact ? ' state--compact' : '') },
      h('div', { class: 'state__icon' }, logo ? h('img', { src: 'assets/img/logo.svg', alt: '', width: '64', height: '64' }) : icon(iconName || 'info')),
      h('p', { class: 'state__title', text: title }),
      text && h('p', { class: 'state__text', text }),
      action
    );
  }

  function errorState(err, retry) {
    return stateBlock({ iconName: 'alert', error: true, title: 'Не удалось загрузить', text: err.message, action: h('button', { class: 'btn', type: 'button', text: 'Повторить', onclick: retry }) });
  }

  function skeleton(n = 3, cls = '') {
    return h('div', { class: 'skeleton-list ' + cls, 'aria-hidden': 'true' }, Array.from({ length: n }, () => h('div', { class: 'skeleton' })));
  }

  function pill(status) {
    return h('span', { class: 'pill pill--' + status, text: STATUS[status] || status });
  }

  /** «Префикс» роли: Пользователь / Игрок / Админ. */
  function roleBadge(role) {
    return h('span', { class: 'role role--' + role, text: ROLE[role] || role });
  }

  function renderFatal(err, retry) {
    hideShell();
    clear(app).append(h('div', { class: 'lk-center' }, errorState(err, retry)));
  }

  function renderForbidden() {
    const p = page({ title: 'Нет доступа' });
    p.body.append(h('div', { class: 'card' }, stateBlock({ iconName: 'lock', title: 'Раздел только для администраторов', text: 'Если вы админ, попросите выдать права.', action: h('a', { class: 'btn', href: '#/', text: 'На главную' }) })));
  }

  function renderNotFound() {
    const p = page({ title: 'Страница не найдена' });
    p.body.append(h('div', { class: 'card' }, stateBlock({ logo: true, title: 'Такой страницы нет', text: 'Возможно, ссылка устарела.', action: h('a', { class: 'btn', href: '#/', text: 'На главную' }) })));
  }

  async function onLogout() {
    const ok = await UI.confirm({ title: 'Выйти из аккаунта?', text: 'Чтобы вернуться, понадобится снова ввести пароль.', confirmText: 'Выйти' });
    if (!ok) return;
    await Api.auth.logout().catch(() => null);
    location.href = 'index.html';
  }

  /* ============================================================ вход */

  function renderGate() {
    if (cleanup) cleanup();
    cleanup = null;
    screen = null;
    hideShell();
    document.title = 'Вход — LWL';
    const openAuth = (mode) => Auth.open({ mode, onSuccess: () => boot() });
    clear(app).append(
      h(
        'div',
        { class: 'lk-center' },
        h(
          'div',
          { class: 'gate card' },
          h('img', { class: 'gate__logo', src: 'assets/img/logo-3d.svg', alt: '', width: '140', height: '140' }),
          h('h1', { class: 'gate__title', text: 'Личный кабинет' }),
          h('p', { class: 'gate__text', text: 'Войдите или создайте аккаунт, чтобы подать заявку на сервер и написать в поддержку.' }),
          h(
            'div',
            { class: 'gate__actions' },
            h('button', { class: 'btn btn--lg', type: 'button', text: 'Войти', onclick: () => openAuth('login') }),
            h('button', { class: 'btn btn--lg btn--secondary', type: 'button', text: 'Создать аккаунт', onclick: () => openAuth('register') })
          ),
          h('a', { class: 'link-btn gate__back', href: 'index.html', text: '← На главную сайта' })
        )
      )
    );
    if (!document.querySelector('.auth-dialog')) openAuth('login');
  }

  /* ============================================================ главная */

  function renderDashboard() {
    return me.role === 'admin' ? renderAdminHome() : renderPlayerHome();
  }

  function renderPlayerHome() {
    const p = page({ title: `Привет, ${me.nickname}!`, sub: isPlayer() ? 'Вы игрок LWL: адрес сервера и сборки — во вкладке «Сервер».' : 'Здесь ваша заявка на сервер и связь с администрацией.', key: 'home' });
    const statusBox = h('div', {}, h('div', { class: 'hero-card hero-card--loading skeleton', 'aria-hidden': 'true' }));
    const supportMeta = h('span', { class: 'tile__meta' }, 'Открыть чат', icon('arrowRight'));
    const support = h(
      'a',
      { class: 'tile tile--art card', href: '#/support' },
      h('span', { class: 'tile__icon' }, icon('chat')),
      h('h2', { class: 'tile__title', text: 'Тех поддержка' }),
      h('p', { class: 'tile__text', text: 'Вопросы по заявке, серверу или аккаунту — ответим прямо в чате.' }),
      supportMeta,
      h('img', { class: 'tile__art', src: 'assets/img/lk-support.webp', alt: '', width: '281', height: '224' })
    );
    const profile = h(
      'a',
      { class: 'tile card', href: '#/profile' },
      h('span', { class: 'tile__row' }, UI.avatar(me, 56), h('span', {}, h('span', { class: 'tile__name', text: me.nickname }), h('span', { class: 'tile__muted', text: me.email }))),
      h('h2', { class: 'tile__title', text: 'Профиль' }),
      h('p', { class: 'tile__text', text: me.avatar ? 'Фото, никнейм и пароль.' : 'Добавьте фото — так администраторам проще вас узнать.' }),
      h('span', { class: 'tile__meta' }, 'Настроить', icon('arrowRight'))
    );
    p.body.append(statusBox, h('div', { class: 'grid-2' }, support, profile));

    const load = async () => {
      try {
        const a = await Api.applications.mine();
        clear(statusBox).append(applicationHero(a));
      } catch (err) {
        clear(statusBox).append(h('div', { class: 'card' }, errorState(err, load)));
      }
    };
    load();
    const refreshMeta = async () => {
      const s = await Api.summary().catch(() => ({}));
      UI.append(clear(supportMeta), [
        s.unreadMessages > 0 && h('span', { class: 'nav-badge nav-badge--inline', text: String(s.unreadMessages) }),
        s.unreadMessages ? UI.plural(s.unreadMessages, 'новое сообщение', 'новых сообщения', 'новых сообщений') : 'Открыть чат',
        icon('arrowRight'),
      ]);
    };
    refreshMeta();
    const offs = [Api.applications.onChange(load), Api.on('conversations', refreshMeta)];
    cleanup = () => offs.forEach((off) => off());
  }

  function applicationHero(a) {
    const art = h('img', { class: 'hero-card__art', src: 'assets/img/lk-progress.webp', alt: '', width: '255', height: '223' });
    let state = a ? a.status : 'none';
    const body = h('div', { class: 'hero-card__body' });
    const actions = h('div', { class: 'hero-card__actions' });
    let title;
    let text;
    if (!a && isPlayer()) {
      state = 'approved';
      title = 'Вы игрок LWL';
      text = 'Адрес сервера, как зайти и сборки для лаунчеров — во вкладке «Сервер».';
      actions.append(h('a', { class: 'btn btn--lg', href: '#/server' }, icon('server'), 'Как зайти на сервер'));
    } else if (!a) {
      title = 'Подайте заявку на сервер';
      text = 'Короткая анкета: возраст, откуда узнали о нас и пара слов о себе. Администраторы рассмотрят её и ответят здесь.';
      actions.append(h('a', { class: 'btn btn--lg', href: '#/apply', text: 'Подать заявку' }));
    } else if (a.status === 'pending') {
      title = 'Заявка на рассмотрении';
      text = `Отправлена ${UI.fullDate(a.createdAt)}. Решение появится здесь — следите за статусом.`;
      actions.append(h('a', { class: 'btn btn--secondary', href: '#/application', text: 'Подробнее' }));
    } else if (a.status === 'approved') {
      title = 'Добро пожаловать на LWL!';
      text = a.comment || `Заявка одобрена ${UI.fullDate(a.updatedAt)}. Адрес сервера и сборки — во вкладке «Сервер».`;
      UI.append(actions, [
        isPlayer() && h('a', { class: 'btn', href: '#/server' }, icon('server'), 'Как зайти на сервер'),
        telegramUrl() && h('a', { class: 'btn btn--secondary', href: telegramUrl(), target: '_blank', rel: 'noopener noreferrer' }, 'Наш Telegram', icon('external')),
        h('a', { class: 'btn btn--ghost', href: '#/application', text: 'Моя заявка' }),
      ]);
    } else if (a.status === 'rejected') {
      title = 'Заявка отклонена';
      text = a.comment ? `Причина: ${a.comment}` : 'Можно исправить анкету и подать заново.';
      actions.append(h('a', { class: 'btn', href: '#/apply', text: 'Подать заново' }), h('a', { class: 'btn btn--ghost', href: '#/support', text: 'Задать вопрос' }));
    } else {
      title = 'Заявка отозвана';
      text = 'Подайте новую, когда будете готовы.';
      actions.append(h('a', { class: 'btn', href: '#/apply', text: 'Подать заявку' }));
    }
    UI.append(body, [a ? pill(a.status) : isPlayer() ? roleBadge(me.role) : h('span', { class: 'pill', text: 'Заявки ещё нет' }), h('h2', { class: 'hero-card__title', text: title }), h('p', { class: 'hero-card__text', text }), a && miniProgress(a), actions]);
    return h('section', { class: 'hero-card card hero-card--' + state, 'aria-label': 'Заявка на сервер' }, body, art);
  }

  function miniProgress(a) {
    const decided = a.status === 'approved' || a.status === 'rejected' || a.status === 'withdrawn';
    const steps = [
      ['Отправлена', 'done'],
      ['Рассмотрение', decided ? 'done' : 'current'],
      [a.status === 'pending' ? 'Решение' : STATUS[a.status], a.status === 'approved' ? 'done' : a.status === 'pending' ? 'todo' : 'fail'],
    ];
    return h(
      'ol',
      { class: 'mini-progress', 'aria-label': 'Этапы заявки' },
      steps.map(([label, st]) => h('li', { class: 'mini-progress__step is-' + st }, h('span', { class: 'mini-progress__bar' }), h('span', { class: 'mini-progress__label', text: label })))
    );
  }

  function renderAdminHome() {
    const p = page({ title: 'Панель администратора', sub: 'Заявки игроков и обращения в поддержку.', key: 'home' });
    const stat = (href, label, img, key) =>
      h(
        'a',
        { class: 'tile tile--stat tile--art card', href },
        h('span', { class: 'tile__muted', text: label }),
        h('span', { class: 'stat__num', dataset: { stat: key }, text: '—' }),
        h('span', { class: 'tile__meta' }, 'Открыть', icon('arrowRight')),
        h('img', { class: 'tile__art', src: img, alt: '', width: '255', height: '223' })
      );
    const apps = h('div', {}, skeleton(3));
    const tickets = h('div', {}, skeleton(3));
    p.body.append(
      h('div', { class: 'grid-2' }, stat('#/admin/applications', 'Новые заявки', 'assets/img/lk-progress.webp', 'apps'), stat('#/admin/tickets', 'Непрочитанные обращения', 'assets/img/lk-support.webp', 'tickets')),
      h(
        'div',
        { class: 'grid-2' },
        h('section', { class: 'card list-card' }, h('header', { class: 'list-card__head' }, h('h2', { text: 'Ждут решения' }), h('a', { class: 'link-btn', href: '#/admin/applications', text: 'Все заявки' })), apps),
        h('section', { class: 'card list-card' }, h('header', { class: 'list-card__head' }, h('h2', { text: 'Последние обращения' }), h('a', { class: 'link-btn', href: '#/admin/tickets', text: 'Все обращения' })), tickets)
      )
    );

    const load = async () => {
      try {
        const [s, a, t] = await Promise.all([Api.summary(), Api.applications.list({ status: 'pending' }), Api.chats.list({ status: 'open' })]);
        p.body.querySelector('[data-stat=apps]').textContent = s.pendingApplications;
        p.body.querySelector('[data-stat=tickets]').textContent = s.unreadConversations;
        clear(apps).append(a.items.length ? h('ul', { class: 'list' }, a.items.slice(0, 5).map(applicationRow)) : stateBlock({ compact: true, iconName: 'check', title: 'Новых заявок нет', text: 'Как только игрок подаст анкету, она появится здесь.' }));
        clear(tickets).append(t.length ? h('ul', { class: 'list' }, t.slice(0, 5).map((c) => ticketRow(c))) : stateBlock({ compact: true, iconName: 'check', title: 'Все обращения разобраны', text: 'Новые вопросы игроков появятся здесь.' }));
      } catch (err) {
        clear(apps).append(errorState(err, load));
        clear(tickets);
      }
    };
    load();
    const offs = [Api.applications.onChange(load), Api.chats.onListChange(load)];
    cleanup = () => offs.forEach((off) => off());
  }

  /* ============================================================ заявка */

  async function renderApplication() {
    const p = page({ title: 'Моя заявка', key: 'application' });
    const load = async () => {
      clear(p.body).append(skeleton(2, 'skeleton-list--tall'));
      let a;
      try {
        a = await Api.applications.mine();
      } catch (err) {
        return clear(p.body).append(h('div', { class: 'card' }, errorState(err, load)));
      }
      if (!a) return renderApply({ embedded: p });
      clear(p.body).append(
        h(
          'section',
          { class: 'card card--pad card--art' },
          h('img', { class: 'card__art', src: 'assets/img/lk-progress.webp', alt: '', width: '255', height: '223' }),
          h('div', { class: 'card-head' }, h('div', {}, h('div', { class: 'card-title-row' }, h('h2', { class: 'card-title', text: 'Статус' }), pill(a.status)), h('p', { class: 'card-sub', text: `Отправлена ${UI.fullDate(a.createdAt)}` }))),
          steps(a),
          statusCallout(a),
          progressActions(a)
        ),
        h('section', { class: 'card card--pad' }, h('h2', { class: 'card-title', text: 'Анкета' }), detailsList(a))
      );
    };
    await load();
    cleanup = Api.applications.onChange(() => {
      if (!document.querySelector('form.form')) load();
    });
  }

  function steps(a) {
    const decided = a.status === 'approved' || a.status === 'rejected';
    const last = a.history[a.history.length - 1];
    const step = (cls, num, title, date) => h('li', { class: 'step ' + cls }, h('span', { class: 'step__num' }, num), h('span', {}, h('span', { class: 'step__title', text: title }), date && h('span', { class: 'step__date', text: date })));
    const failed = a.status === 'rejected' || a.status === 'withdrawn';
    return h(
      'ol',
      { class: 'steps', 'aria-label': 'Этапы заявки' },
      step('step--done', icon('check'), 'Отправлена', UI.shortTime(a.createdAt)),
      step(decided ? 'step--done' : a.status === 'pending' ? 'step--current' : 'step--done', decided ? icon('check') : '2', 'Рассмотрение', a.status === 'pending' ? 'сейчас' : ''),
      step(a.status === 'approved' ? 'step--done' : failed ? 'step--fail' : '', a.status === 'approved' ? icon('check') : failed ? icon('close') : '3', a.status === 'pending' ? 'Решение' : STATUS[a.status], a.status !== 'pending' ? UI.shortTime(last.at) : '')
    );
  }

  function statusCallout(a) {
    if (a.status === 'pending') return callout('info', 'clock', 'Заявка на рассмотрении', 'Администраторы прочитают анкету и примут решение — оно появится на этой странице.');
    if (a.status === 'approved') {
      return callout(
        'success',
        'check',
        'Заявка одобрена! Добро пожаловать на LWL',
        a.comment,
        h(
          'p',
          {},
          'Адрес сервера и сборки — во вкладке ',
          h('a', { class: 'link', href: '#/server', text: '«Сервер»' }),
          telegramUrl() ? [', новости — в ', h('a', { class: 'link', href: telegramUrl(), target: '_blank', rel: 'noopener noreferrer', text: 'нашем Telegram' })] : '',
          '.'
        )
      );
    }
    if (a.status === 'rejected') return callout('danger', 'alert', 'Заявка отклонена', a.comment, h('p', { text: 'Учтите комментарий и подайте анкету заново.' }));
    return callout('info', 'info', 'Вы отозвали заявку', null, h('p', { text: 'Подайте новую, когда будете готовы.' }));
  }

  function callout(kind, iconName, title, quoteOrText, extra) {
    const isQuote = kind !== 'info' || extra;
    return h(
      'div',
      { class: 'callout callout--' + kind, role: 'status' },
      icon(iconName),
      h('div', {}, h('p', { class: 'callout__title', text: title }), quoteOrText && h('p', { class: isQuote ? 'callout__quote' : '', text: quoteOrText }), extra)
    );
  }

  function detailsList(a) {
    const row = (k, v) => [h('dt', { text: k }), h('dd', { text: v || '—' })];
    return h('dl', { class: 'details' }, row('Никнейм', a.nickname), row('Возраст', String(a.age)), row('Лицензия', Api.LICENSES[a.license] || 'Не указано'), row('Откуда узнали', a.source), row('Контакт', a.contact), row('О себе', a.about));
  }

  /** Выбор «есть лицензия / нет лицензии» — от него зависит, как игрока добавят на сервер. */
  function licenseChoice(value) {
    const option = (key, title, text) =>
      h(
        'label',
        { class: 'choice' },
        h('input', { type: 'radio', name: 'license', value: key, checked: value === key }),
        h('span', { class: 'choice__body' }, h('span', { class: 'choice__title', text: title }), h('span', { class: 'choice__text', text }))
      );
    const wrap = h(
      'fieldset',
      { class: 'field choices' },
      h('legend', { class: 'field__label', text: 'Лицензия Minecraft' }),
      h(
        'div',
        { class: 'choices__row' },
        option('premium', 'Есть лицензия', 'Куплена у Mojang или Microsoft. На сервер будете заходить без пароля.'),
        option('cracked', 'Нет лицензии', 'Играете с пиратского лаунчера. При первом входе на сервер придумаете пароль.')
      ),
      h('div', { class: 'field__error', 'aria-live': 'polite' })
    );
    wrap.addEventListener('change', () => {
      wrap.classList.remove('has-error');
      wrap.querySelector('.field__error').textContent = '';
    });
    return wrap;
  }

  /** Команда для консоли сервера (мод LWL Auth): добавить игрока в вайтлист. */
  function serverCommand(a) {
    return '/wl add ' + a.nickname + (a.license === 'cracked' ? ' cracked' : '');
  }

  function commandBox(a) {
    const cmd = serverCommand(a);
    const why =
      a.license === 'cracked'
        ? 'Без лицензии: команда добавит ник в вайтлист и разрешит вход по паролю, даже если такой ник есть у чьей-то лицензии.'
        : a.license === 'premium'
          ? 'С лицензией: игрок будет заходить без пароля — сервер проверит его через Mojang.'
          : 'Игрок не указал, есть ли лицензия. Если он с пиратки, добавьте в конце «cracked».';
    return h(
      'div',
      { class: 'cmd' },
      h('p', { class: 'cmd__title', text: 'Добавить на сервер' }),
      h('div', { class: 'cmd__row' }, h('code', { class: 'cmd__code', text: cmd }), copyButton(cmd, 'Команда скопирована — вставьте её в консоль сервера.')),
      h('p', { class: 'field__hint', text: why + ' Команду можно ввести в игре или в консоли сервера.' })
    );
  }

  function progressActions(a) {
    const box = h('div', { class: 'actions-row' });
    if (a.status === 'rejected' || a.status === 'withdrawn') box.append(h('a', { class: 'btn', href: '#/apply', text: 'Подать новую заявку' }));
    box.append(h('a', { class: 'btn btn--secondary', href: '#/support' }, icon('chat'), 'Вопрос по заявке'));
    if (a.status === 'pending') {
      box.append(
        h('button', {
          class: 'btn btn--ghost',
          type: 'button',
          text: 'Отозвать заявку',
          onclick: async (e) => {
            const btn = e.currentTarget;
            const ok = await UI.confirm({ title: 'Отозвать заявку?', text: 'Администраторы её больше не увидят. Потом можно подать новую.', confirmText: 'Отозвать', danger: true });
            if (!ok) return;
            UI.setLoading(btn, true);
            try {
              await Api.applications.withdraw(a.id);
              UI.toast('Заявка отозвана.');
            } catch (err) {
              UI.toast(err.message, { type: 'error' });
              UI.setLoading(btn, false);
            }
          },
        })
      );
    }
    return box;
  }

  /* ------------------------------------------------------------ анкета */

  async function renderApply({ embedded } = {}) {
    const p = embedded || page({ title: 'Анкета игрока', sub: 'Администраторы прочитают её и примут решение. Ответ появится в разделе «Заявка».', key: 'application' });
    if (embedded) {
      p.titleEl.textContent = 'Подать заявку';
      document.title = 'Подать заявку — LWL';
    }
    clear(p.body).append(skeleton(3, 'skeleton-list--tall'));
    let existing;
    try {
      existing = await Api.applications.mine();
    } catch (err) {
      return clear(p.body).append(h('div', { class: 'card' }, errorState(err, () => renderApply({ embedded }))));
    }
    if (existing && (existing.status === 'pending' || existing.status === 'approved')) {
      clear(p.body).append(
        h(
          'div',
          { class: 'card' },
          stateBlock({
            iconName: existing.status === 'approved' ? 'check' : 'clock',
            title: existing.status === 'approved' ? 'Вы уже на сервере' : 'Заявка уже отправлена',
            text: existing.status === 'approved' ? 'Ваша заявка одобрена — новая не нужна.' : 'Дождитесь решения администраторов.',
            action: h('a', { class: 'btn', href: '#/application', text: 'Моя заявка' }),
          })
        )
      );
      return;
    }

    const DRAFT = 'lwl.apply.draft.' + me.id;
    const draft = safeJSON(safe(() => sessionStorage.getItem(DRAFT))) || {};
    const about = field({ label: 'Расскажите о себе', name: 'about', textarea: true, value: draft.about || '', placeholder: 'Во что любите играть, что хотите строить, был ли опыт на других серверах…', maxlength: Api.LIMITS.about.max + 100 });
    const aboutControl = about.querySelector('textarea');
    about.querySelector('.field__control').after(h('div', { class: 'field__row' }, h('span', { class: 'field__hint', text: `Минимум ${Api.LIMITS.about.min} символов` }), UI.counter(aboutControl, Api.LIMITS.about.max)));

    const form = h(
      'form',
      { class: 'form', novalidate: true },
      h('div', { class: 'form-alert', role: 'alert', hidden: true }),
      h(
        'div',
        { class: 'form__grid' },
        field({ label: 'Никнейм в Minecraft', name: 'nickname', value: me.nickname, hint: 'Из профиля — поменять можно там же.', attrs: { readonly: true } }),
        field({ label: 'Возраст', name: 'age', type: 'number', value: draft.age || '', inputmode: 'numeric', attrs: { min: Api.LIMITS.age.min, max: Api.LIMITS.age.max } })
      ),
      licenseChoice(draft.license),
      h(
        'div',
        { class: 'form__grid' },
        field({ label: 'Откуда узнали о сервере', name: 'source', options: Api.APPLICATION_SOURCES, value: draft.source || '' }),
        field({ label: 'Telegram или Discord', name: 'contact', value: draft.contact || '', placeholder: 'Необязательно', maxlength: Api.LIMITS.contact.max, autocomplete: 'off' })
      ),
      about,
      h('div', { class: 'field' }, h('label', { class: 'checkbox' }, h('input', { type: 'checkbox', name: 'agree' }), h('span', { text: 'Я прочитал(а) и принимаю правила сервера' })), h('div', { class: 'field__error', 'aria-live': 'polite' })),
      h('div', { class: 'actions-row' }, h('button', { class: 'btn btn--lg', type: 'submit', text: 'Отправить заявку' }), h('a', { class: 'btn btn--ghost', href: '#/', text: 'Отмена' }))
    );
    form.agree.checked = !!draft.agree;
    form.source.value = draft.source || '';
    form.agree.addEventListener('change', () => form.agree.checked && UI.setFieldError(form, 'agree', ''));

    const saveDraft = UI.debounce(() => {
      safe(() => sessionStorage.setItem(DRAFT, JSON.stringify({ age: form.age.value, license: form.license.value, source: form.source.value, contact: form.contact.value, about: form.about.value, agree: form.agree.checked })));
    }, 300);
    form.addEventListener('input', saveDraft);
    form.addEventListener('change', saveDraft);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      UI.clearErrors(form);
      const data = { age: form.age.value, license: form.license.value, source: form.source.value, contact: form.contact.value, about: form.about.value, agree: form.agree.checked };
      const errors = Api.validate.application(data);
      if (Object.keys(errors).length) return UI.showFormError(form, new Api.ApiError('VALIDATION', null, { fields: errors }));
      const btn = form.querySelector('[type=submit]');
      UI.setLoading(btn, true);
      try {
        await Api.applications.submit(data);
        safe(() => sessionStorage.removeItem(DRAFT));
        UI.toast('Заявка отправлена! Статус — в разделе «Заявка».', { type: 'success' });
        go('#/application');
      } catch (err) {
        UI.showFormError(form, err);
        UI.setLoading(btn, false);
      }
    });

    UI.append(clear(p.body), [existing && existing.status === 'rejected' && h('div', { class: 'card card--pad card--flush' }, callout('danger', 'alert', 'Прошлая заявка отклонена', existing.comment, h('p', { text: 'Учтите комментарий — и попробуйте ещё раз.' }))), h('section', { class: 'card card--pad' }, form)]);
  }

  /* ============================================================ поддержка */

  async function renderSupport() {
    const p = page({ title: 'Тех поддержка', fill: true, key: 'support' });
    p.head.classList.add('page-head--compact-mobile');
    document.body.classList.add('lk--chat');
    const chatEl = h('section', { class: 'card chat-card' }, skeleton(4));
    p.body.append(h('div', { class: 'chat-wrap chat-wrap--art' }, h('img', { class: 'chat-wrap__art', src: 'assets/img/lk-support.webp', alt: '', width: '281', height: '224' }), chatEl));
    try {
      const conv = await Api.chats.support();
      if (!document.contains(chatEl)) return;
      cleanup = Chat.mount(chatEl, { conversationId: conv.id, me, onBack: () => go('#/') });
    } catch (err) {
      clear(chatEl).append(errorState(err, renderSupport));
    }
  }

  /* ============================================================ админ: списки */

  function applicationRow(a, selected) {
    return h(
      'li',
      {},
      h(
        'a',
        { class: 'row', href: '#/admin/applications/' + encodeURIComponent(a.id) + (selected !== undefined ? location.hash.replace(/^[^?]*/, '') : ''), 'aria-current': selected ? 'true' : null, dataset: { id: a.id } },
        UI.avatar(a.applicant || { nickname: a.nickname }, 44),
        h('span', { class: 'row__main' }, h('span', { class: 'row__title' }, h('span', { class: 'row__name', text: a.nickname })), h('span', { class: 'row__text', text: `${a.age} лет · ${a.license === 'premium' ? 'лицензия' : a.license === 'cracked' ? 'без лицензии' : a.source} · ${a.about}` })),
        h('span', { class: 'row__side' }, h('span', { text: UI.shortTime(a.createdAt), title: UI.fullDate(a.createdAt) }), a.status !== 'pending' ? pill(a.status) : h('span', { class: 'dot dot--new', title: 'Новая' }))
      )
    );
  }

  function ticketRow(c, selected) {
    const last = c.lastMessage;
    const prefix = last && last.authorId === me.id ? 'Вы: ' : '';
    return h(
      'li',
      {},
      h(
        'a',
        { class: 'row' + (c.unread ? ' row--unread' : ''), href: '#/admin/tickets/' + encodeURIComponent(c.id) + (selected !== undefined ? location.hash.replace(/^[^?]*/, '') : ''), 'aria-current': selected ? 'true' : null, dataset: { id: c.id } },
        h('span', { class: 'row__avatar' }, UI.avatar(c.player, 44), c.player && c.player.online && h('span', { class: 'online-dot', title: 'В сети' })),
        h(
          'span',
          { class: 'row__main' },
          h('span', { class: 'row__title' }, h('span', { class: 'row__name', text: c.player ? c.player.nickname : 'Удалённый аккаунт' }), c.status === 'closed' && h('span', { class: 'pill pill--closed', text: 'Закрыто' })),
          h('span', { class: 'row__text', text: last ? prefix + last.text : 'Нет сообщений' })
        ),
        h('span', { class: 'row__side' }, last && h('span', { text: UI.shortTime(last.createdAt), title: UI.fullDate(last.createdAt) }), c.unread ? h('span', { class: 'nav-badge', text: String(c.unread), 'aria-label': `${c.unread} непрочитанных` }) : null)
      )
    );
  }

  /** Экран «список | карточка». */
  function splitScreen({ name, title, sub, query, tabs, statusKey, defaultStatus, loadItems, renderRow, emptyFor, renderDetail, placeholder, selectedId, searchLabel }) {
    const status = tabs.some(([k]) => k === query.get('status')) ? query.get('status') : defaultStatus;
    const q = query.get('q') || '';
    const base = `#/admin/${name}`;
    const qs = () => {
      const s = new URLSearchParams();
      if (status !== defaultStatus) s.set('status', status);
      const term = searchInput.value.trim();
      if (term) s.set('q', term);
      const str = s.toString();
      return str ? '?' + str : '';
    };

    const p = page({ title, sub, fill: true, key: name });
    const tabsEl = h(
      'div',
      { class: 'tabs', role: 'tablist', 'aria-label': 'Фильтр' },
      tabs.map(([key, label]) => h('a', { class: 'tabs__tab', role: 'tab', href: `${base}${key === defaultStatus ? '' : '?status=' + key}`, 'aria-selected': String(key === status), dataset: { key } }, label, h('span', { class: 'tabs__count', hidden: true })))
    );
    const searchInput = h('input', { class: 'input', type: 'search', placeholder: searchLabel || 'Поиск по нику', 'aria-label': searchLabel || 'Поиск по нику', value: q });
    searchInput.value = q;
    const listBox = h('div', { class: 'split__scroll' });
    const detail = h('section', { class: 'split__detail card' });
    const listPane = h('section', { class: 'split__list card', 'aria-label': title }, h('div', { class: 'split__tools' }, tabsEl, h('div', { class: 'search', role: 'search' }, icon('search'), searchInput)), listBox);
    const root = h('div', { class: 'split' }, listPane, detail);
    p.body.append(root);

    let items = [];
    let current = null;
    let detailCleanup = null;
    let seq = 0;

    async function load() {
      const my = ++seq;
      if (!listBox.firstChild) listBox.append(skeleton(5));
      try {
        const res = await loadItems({ status, query: searchInput.value.trim() });
        if (my !== seq) return;
        items = res.items;
        if (res.counts) {
          tabsEl.querySelectorAll('.tabs__tab').forEach((t) => {
            const key = t.dataset.key;
            const n = key in res.counts ? res.counts[key] : key === 'all' ? Object.values(res.counts).reduce((s, x) => s + x, 0) : 0;
            const c = t.querySelector('.tabs__count');
            c.hidden = !n;
            c.textContent = n;
          });
        }
        const term = searchInput.value.trim();
        clear(listBox).append(
          items.length
            ? h('ul', { class: 'list list--flush' }, items.map((it) => renderRow(it, it.id === current)))
            : term
              ? stateBlock({ compact: true, iconName: 'search', title: 'Ничего не нашлось', text: `По запросу «${term}» ничего нет.` })
              : stateBlock(Object.assign({ compact: true, logo: true }, emptyFor(status)))
        );
      } catch (err) {
        if (my === seq) clear(listBox).append(errorState(err, load));
      }
    }

    function select(id) {
      current = id;
      root.classList.toggle('has-detail', !!id);
      document.body.classList.toggle('lk--detail', !!id);
      listBox.querySelectorAll('.row').forEach((r) => (r.dataset.id === id ? r.setAttribute('aria-current', 'true') : r.removeAttribute('aria-current')));
      if (detailCleanup) detailCleanup();
      detailCleanup = null;
      detail.className = 'split__detail card';
      if (!id) {
        clear(detail).append(stateBlock(placeholder));
        return;
      }
      detailCleanup = renderDetail(detail, id, () => go(base + qs())) || null;
    }

    searchInput.addEventListener(
      'input',
      UI.debounce(() => {
        history.replaceState(null, '', (current ? `${base}/${encodeURIComponent(current)}` : base) + qs());
        screen.key = parseHash().query.toString();
        load();
      }, 300)
    );

    load();
    select(selectedId ? decodeURIComponent(selectedId) : null);
    const offList = statusKey === 'applications' ? Api.applications.onChange(load) : statusKey === 'users' ? Api.admin.users.onChange(load) : Api.chats.onListChange(load);
    const timer = setInterval(() => document.visibilityState === 'visible' && load(), Api.config.pollIntervalMs);

    screen = { name, key: query.toString(), select };
    cleanup = () => {
      offList();
      clearInterval(timer);
      if (detailCleanup) detailCleanup();
      document.body.classList.remove('lk--detail', 'lk--chat');
    };
  }

  function renderTickets(query, id) {
    splitScreen({
      name: 'tickets',
      title: 'Обращения',
      sub: 'Вопросы игроков в поддержку.',
      query,
      statusKey: 'tickets',
      defaultStatus: 'open',
      tabs: [
        ['open', 'Открытые'],
        ['closed', 'Закрытые'],
        ['all', 'Все'],
      ],
      loadItems: async (params) => ({ items: await Api.chats.list(params) }),
      renderRow: ticketRow,
      emptyFor: (st) => (st === 'closed' ? { title: 'Закрытых обращений нет' } : { title: 'Все обращения разобраны', text: 'Новые вопросы игроков появятся здесь.' }),
      placeholder: { iconName: 'chat', title: 'Выберите обращение', text: 'Переписка откроется здесь.' },
      selectedId: id,
      renderDetail(el, ticketId, back) {
        document.body.classList.add('lk--chat');
        const destroy = Chat.mount(el, { conversationId: ticketId, me, onBack: back });
        return () => {
          destroy();
          el.classList.remove('chat');
          document.body.classList.remove('lk--chat');
        };
      },
    });
  }

  function renderApplications(query, id) {
    splitScreen({
      name: 'applications',
      title: 'Заявки',
      sub: 'Анкеты игроков на вступление.',
      query,
      statusKey: 'applications',
      defaultStatus: 'pending',
      tabs: [
        ['pending', 'Новые'],
        ['approved', 'Одобренные'],
        ['rejected', 'Отклонённые'],
        ['all', 'Все'],
      ],
      loadItems: (params) => Api.applications.list(params),
      renderRow: applicationRow,
      emptyFor: (st) =>
        ({
          pending: { title: 'Новых заявок нет', text: 'Как только игрок подаст анкету, она появится здесь.' },
          approved: { title: 'Одобренных пока нет' },
          rejected: { title: 'Отклонённых нет' },
          all: { title: 'Заявок пока нет', text: 'Игроки подают их из личного кабинета.' },
        })[st],
      placeholder: { iconName: 'file', title: 'Выберите заявку', text: 'Анкета и кнопки решения откроются здесь.' },
      selectedId: id,
      renderDetail: applicationDetail,
    });
  }

  function applicationDetail(el, id, back) {
    let alive = true;
    const off = Api.applications.onChange(() => alive && load());
    const load = async () => {
      if (!el.firstChild || !el.querySelector('.detail')) clear(el).append(h('div', { class: 'detail' }, skeleton(3, 'skeleton-list--tall')));
      let a;
      try {
        a = await Api.applications.get(id);
      } catch (err) {
        if (!alive) return;
        return clear(el).append(
          err.code === 'NOT_FOUND' ? stateBlock({ iconName: 'search', title: 'Заявка не найдена', text: 'Возможно, игрок удалил аккаунт.', action: h('button', { class: 'btn', type: 'button', text: 'К списку', onclick: back }) }) : errorState(err, load)
        );
      }
      if (!alive) return;
      const keepComment = el.querySelector('textarea[name=comment]');
      const comment = keepComment ? keepComment.value : '';
      clear(el).append(
        h(
          'div',
          { class: 'detail' },
          h(
            'header',
            { class: 'detail__head' },
            h('button', { class: 'icon-btn detail__back', type: 'button', 'aria-label': 'К списку', onclick: back }, icon('back')),
            UI.avatar(a.applicant || { nickname: a.nickname }, 56),
            h('div', { class: 'detail__who' }, h('h2', { class: 'detail__name', text: a.nickname }), h('p', { class: 'detail__meta', text: a.applicant ? `${UI.presenceText(a.applicant)} · подана ${UI.shortTime(a.createdAt)}` : 'Аккаунт удалён', title: UI.fullDate(a.createdAt) })),
            pill(a.status)
          ),
          detailsList(a),
          a.status === 'pending' ? reviewForm(a, comment) : decisionInfo(a),
          a.status === 'approved' && commandBox(a)
        )
      );
    };
    load();
    return () => {
      alive = false;
      off();
    };
  }

  function decisionInfo(a) {
    const who = a.reviewer ? a.reviewer.nickname : 'администратор';
    const text = a.status === 'withdrawn' ? 'Игрок отозвал заявку.' : `${STATUS[a.status]} — ${who}, ${UI.fullDate(a.updatedAt)}.`;
    return callout(a.status === 'approved' ? 'success' : a.status === 'rejected' ? 'danger' : 'info', a.status === 'approved' ? 'check' : 'info', text, a.comment);
  }

  function reviewForm(a, comment) {
    const commentField = field({ label: 'Комментарий игроку', name: 'comment', textarea: true, value: comment, placeholder: 'Обязателен при отказе: что исправить в анкете', maxlength: Api.LIMITS.reviewComment.max + 50 });
    const form = h(
      'form',
      { class: 'review', novalidate: true },
      h('h3', { class: 'review__title', text: 'Решение' }),
      h('div', { class: 'form-alert', role: 'alert', hidden: true }),
      commentField,
      h('div', { class: 'actions-row' }, h('button', { class: 'btn btn--lg', type: 'submit', value: 'approved' }, icon('check'), 'Одобрить'), h('button', { class: 'btn btn--lg btn--danger', type: 'submit', value: 'rejected' }, icon('close'), 'Отклонить'))
    );
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      UI.clearErrors(form);
      const btn = e.submitter;
      const decision = btn && btn.value;
      if (decision === 'rejected' && form.comment.value.trim().length < Api.LIMITS.reviewComment.min) {
        return UI.showFormError(form, new Api.ApiError('VALIDATION', null, { fields: { comment: 'Напишите причину отказа — игрок её увидит.' } }));
      }
      form.querySelectorAll('button').forEach((b) => (b.disabled = true));
      UI.setLoading(btn, true);
      try {
        await Api.applications.review(a.id, { status: decision, comment: form.comment.value });
        UI.toast(decision === 'approved' ? `Заявка ${a.nickname} одобрена.` : `Заявка ${a.nickname} отклонена.`, { type: 'success' });
      } catch (err) {
        UI.showFormError(form, err);
        form.querySelectorAll('button').forEach((b) => (b.disabled = false));
        UI.setLoading(btn, false);
      }
    });
    return form;
  }

  /* ============================================================ общие помощники */

  function copyButton(text, done) {
    const btn = h('button', { class: 'btn btn--sm btn--secondary', type: 'button' }, icon('copy'), 'Скопировать');
    btn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text);
        UI.toast(done || 'Скопировано.', { type: 'success' });
      } catch {
        // Без HTTPS браузер не даёт писать в буфер — выделяем текст, чтобы скопировать вручную.
        const code = btn.parentElement && btn.parentElement.querySelector('code');
        if (code) {
          const range = document.createRange();
          range.selectNodeContents(code);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
        }
        UI.toast('Выделил текст — скопируйте его (Ctrl+C).');
      }
    });
    return btn;
  }

  function extLink(href, label) {
    return h('a', { class: 'btn btn--secondary', href, target: '_blank', rel: 'noopener noreferrer' }, label, icon('external'));
  }

  const formatSize = (b) => (!b ? '' : b < 1024 * 1024 ? Math.max(1, Math.round(b / 1024)) + ' КБ' : (b / 1024 / 1024).toFixed(b < 100 * 1024 * 1024 ? 1 : 0).replace('.', ',') + ' МБ');
  const extOf = (name) => (name && /\.mrpack$/i.test(name) ? '.mrpack' : '.zip');

  /* ============================================================ сервер (игрок) */

  // Инструкции по импорту. Названия кнопок — как в русском интерфейсе лаунчеров, в скобках — в английском.
  const LAUNCHER_HELP = {
    prism: ['Установите Prism Launcher (prismlauncher.org), если его ещё нет.', 'Нажмите «Добавить экземпляр» (Add Instance) → «Импорт» (Import).', 'Выберите скачанный .zip и нажмите «ОК». Запускайте появившийся экземпляр.'],
    curseforge: ['Откройте приложение CurseForge → Minecraft.', 'Нажмите «Создать профиль» (Create Custom Profile) → «Импорт» (Import).', 'Выберите скачанный .zip — сборка появится в «Мои модпаки» (My Modpacks).'],
    modrinth: ['Установите Modrinth App (modrinth.com/app), если его ещё нет.', 'Нажмите «+» (Add instance) → «Импорт из файла» (Import from file) и выберите .mrpack.', 'Или просто откройте .mrpack двойным кликом — Modrinth App предложит установить сборку.'],
    other: ['Следуйте описанию сборки выше.'],
  };

  function renderServerLocked() {
    const p = page({ title: 'Сервер', key: 'home' });
    p.body.append(
      h(
        'div',
        { class: 'card' },
        stateBlock({
          iconName: 'lock',
          title: 'Вкладка откроется после одобрения заявки',
          text: 'Когда администраторы одобрят анкету, вы станете игроком — здесь появятся адрес сервера и сборки.',
          action: h('a', { class: 'btn', href: '#/application', text: 'Моя заявка' }),
        })
      )
    );
  }

  async function renderServer() {
    const preview = me.role === 'admin';
    const p = page({ title: 'Сервер', sub: 'Адрес, как зайти и сборки для лаунчеров.', key: 'server', actions: preview && h('a', { class: 'btn btn--secondary', href: '#/server' }, icon('back'), 'К управлению') });
    const load = async () => {
      clear(p.body).append(skeleton(3, 'skeleton-list--tall'));
      let data;
      try {
        data = await Api.server.info();
      } catch (err) {
        return clear(p.body).append(h('div', { class: 'card' }, errorState(err, load)));
      }
      UI.append(clear(p.body), [
        preview && h('div', { class: 'card card--pad card--flush' }, callout('info', 'eyeView', 'Так эту вкладку видят игроки', 'Ник, лицензия и подсказки «как зайти» — у каждого игрока свои.')),
        serverCard(data.server, data.me),
        packsSection(data.packs),
      ]);
    };
    await load();
  }

  function serverCard(server, mine) {
    const nick = mine.nickname;
    const login =
      mine.license === 'premium'
        ? ['Заходите с лицензии', `Под ником ${nick}. Пароль не нужен — сервер сам проверит лицензию.`]
        : mine.license === 'cracked'
          ? ['Придумайте пароль на сервере', `Заходите под ником ${nick}. При первом входе напишите в чат /register <пароль> <пароль>, дальше каждый раз — /login <пароль>.`]
          : ['Заходите под своим ником', `Ник — ${nick}. С лицензией пароль не нужен; без неё при первом входе напишите /register <пароль> <пароль>.`];
    const how = [
      ['Установите сборку', 'Скачайте её ниже и импортируйте в свой лаунчер.'],
      ['Добавьте сервер', `«Сетевая игра» → «Добавить сервер» → адрес ${server.address || 'выше'}.`],
      login,
    ];
    return h(
      'section',
      { class: 'card card--pad card--art server-card' },
      h('img', { class: 'card__art', src: 'assets/img/lk-progress.webp', alt: '', width: '255', height: '223' }),
      h(
        'div',
        { class: 'card-head' },
        h('div', {}, h('div', { class: 'card-title-row' }, h('h2', { class: 'card-title', text: 'Адрес сервера' }), server.version && h('span', { class: 'pill', text: 'Minecraft ' + server.version })), h('p', { class: 'card-sub', text: 'Скопируйте и вставьте в игре: «Сетевая игра» → «Добавить сервер».' }))
      ),
      server.address
        ? h('div', { class: 'cmd__row server-address' }, h('code', { class: 'cmd__code cmd__code--big', text: server.address }), copyButton(server.address, 'Адрес сервера скопирован.'))
        : callout('info', 'clock', 'Адрес скоро появится', 'Администрация ещё не указала адрес сервера.'),
      h(
        'ol',
        { class: 'how-list' },
        how.map(([title, text], i) => h('li', { class: 'how-list__item' }, h('span', { class: 'how-list__num', text: String(i + 1) }), h('span', {}, h('span', { class: 'how-list__title', text: title }), h('span', { class: 'how-list__text', text }))))
      ),
      server.note && h('p', { class: 'server-note', text: server.note }),
      (server.telegramUrl || server.discordUrl) && h('div', { class: 'actions-row' }, server.telegramUrl && extLink(server.telegramUrl, 'Telegram'), server.discordUrl && extLink(server.discordUrl, 'Discord'))
    );
  }

  function packsSection(packs) {
    const body = packs.length
      ? h('div', { class: 'packs' }, packs.map(packCard))
      : stateBlock({ compact: true, iconName: 'download', title: 'Сборки пока не загружены', text: 'Как только администрация выложит сборку, она появится здесь.' });
    return h(
      'section',
      { class: 'card card--pad' },
      h('h2', { class: 'card-title', text: 'Сборки' }),
      h('p', { class: 'card-sub', text: 'Выберите сборку под свой лаунчер — в ней уже всё нужное для игры на сервере.' }),
      h('div', { class: 'card-content' }, body)
    );
  }

  function packCard(pk) {
    const meta = [pk.version && 'версия ' + pk.version, formatSize(pk.fileSize), 'обновлена ' + UI.fullDate(pk.updatedAt)].filter(Boolean).join(' · ');
    return h(
      'article',
      { class: 'pack' },
      h('div', { class: 'pack__head' }, h('span', { class: 'pack__launcher pack__launcher--' + pk.launcher, text: Api.LAUNCHERS[pk.launcher] || pk.launcher }), h('h3', { class: 'pack__title', text: pk.title })),
      h('p', { class: 'pack__meta', text: meta }),
      pk.description && h('p', { class: 'pack__desc', text: pk.description }),
      h('div', { class: 'actions-row' }, h('a', { class: 'btn', href: pk.downloadUrl, download: pk.fileName }, icon('download'), 'Скачать ' + extOf(pk.fileName))),
      h('details', { class: 'pack__help' }, h('summary', { text: 'Как установить' }), h('ol', {}, (LAUNCHER_HELP[pk.launcher] || LAUNCHER_HELP.other).map((t) => h('li', { text: t }))))
    );
  }

  /* ============================================================ сервер (админ) */

  function renderServerAdmin() {
    const p = page({
      title: 'Сервер',
      sub: 'Адрес, подсказки и сборки — это видят игроки во вкладке «Сервер».',
      key: 'server',
      actions: h('a', { class: 'btn btn--secondary', href: '#/server?preview=1' }, icon('eyeView'), 'Как видят игроки'),
    });
    const settingsBox = h('div', {}, skeleton(2));
    const packsBox = h('div', {}, skeleton(2));
    p.body.append(
      h(
        'div',
        { class: 'stack' },
        section('Настройки сервера', 'Адрес для подключения, версия и подсказка, которую увидят игроки.', settingsBox),
        h(
          'section',
          { class: 'card card--pad' },
          h(
            'div',
            { class: 'card-head card-head--actions' },
            h('div', {}, h('h2', { class: 'card-title', text: 'Сборки' }), h('p', { class: 'card-sub', text: 'Prism Launcher и CurseForge — архив .zip, Modrinth — .mrpack. Игроки видят только опубликованные.' })),
            h('button', { class: 'btn', type: 'button', onclick: () => packForm() }, icon('upload'), 'Добавить сборку')
          ),
          h('div', { class: 'card-content' }, packsBox)
        )
      )
    );

    async function loadSettings() {
      let st;
      try {
        st = await Api.admin.settings.get();
      } catch (err) {
        return clear(settingsBox).append(errorState(err, loadSettings));
      }
      const form = h(
        'form',
        { class: 'form', novalidate: true },
        h('div', { class: 'form-alert', role: 'alert', hidden: true }),
        h(
          'div',
          { class: 'form__grid' },
          field({ label: 'Адрес сервера', name: 'serverAddress', value: st.serverAddress, placeholder: 'play.lwl.ru или 203.0.113.5:25565', hint: 'IP или домен; порт — если он не 25565.', attrs: { autocapitalize: 'off', spellcheck: 'false' } }),
          field({ label: 'Версия Minecraft', name: 'serverVersion', value: st.serverVersion, placeholder: '26.3' })
        ),
        field({ label: 'Подсказка для игроков', name: 'serverNote', textarea: true, value: st.serverNote, placeholder: 'Например: сначала установите сборку; правила — в Telegram; ивенты по субботам…' }),
        h(
          'div',
          { class: 'form__grid' },
          field({ label: 'Telegram', name: 'telegramUrl', value: st.telegramUrl, placeholder: 'https://t.me/…', hint: 'Кнопки «Подписаться» на главной и во вкладке «Сервер».', attrs: { autocapitalize: 'off', spellcheck: 'false' } }),
          field({ label: 'Discord', name: 'discordUrl', value: st.discordUrl, placeholder: 'https://discord.gg/…', attrs: { autocapitalize: 'off', spellcheck: 'false' } })
        ),
        h('div', { class: 'actions-row' }, h('button', { class: 'btn', type: 'submit', text: 'Сохранить' }))
      );
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        UI.clearErrors(form);
        const btn = form.querySelector('[type=submit]');
        UI.setLoading(btn, true);
        try {
          await Api.admin.settings.save({ serverAddress: form.serverAddress.value, serverVersion: form.serverVersion.value, serverNote: form.serverNote.value, telegramUrl: form.telegramUrl.value, discordUrl: form.discordUrl.value });
          links = await Api.settings.public();
          UI.toast('Настройки сервера сохранены.', { type: 'success' });
        } catch (err) {
          UI.showFormError(form, err);
        } finally {
          UI.setLoading(btn, false);
        }
      });
      clear(settingsBox).append(form);
    }

    async function loadPacks() {
      let items;
      try {
        items = await Api.admin.packs.list();
      } catch (err) {
        return clear(packsBox).append(errorState(err, loadPacks));
      }
      clear(packsBox).append(
        items.length
          ? h('div', { class: 'packs' }, items.map(adminPackCard))
          : stateBlock({ compact: true, iconName: 'upload', title: 'Сборок пока нет', text: 'Нажмите «Добавить сборку», укажите название и лаунчер, потом загрузите файл.' })
      );
    }

    loadSettings();
    loadPacks();
    cleanup = Api.admin.packs.onChange(loadPacks);
  }

  function adminPackCard(pk) {
    const bar = h('div', { class: 'progress__bar' });
    const barText = h('span', { class: 'progress__text' });
    const progress = h('div', { class: 'progress', hidden: true, role: 'progressbar', 'aria-label': 'Загрузка файла' }, h('div', { class: 'progress__track' }, bar), barText);
    const fileInput = h('input', { type: 'file', accept: pk.launcher === 'modrinth' ? '.mrpack' : '.zip,.mrpack', hidden: true });
    const uploadBtn = h('button', { class: 'btn btn--sm btn--secondary', type: 'button', onclick: () => fileInput.click() }, icon('upload'), pk.fileName ? 'Заменить файл' : 'Загрузить файл');
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0];
      fileInput.value = '';
      if (!file) return;
      const need = pk.launcher === 'modrinth' ? '.mrpack' : pk.launcher === 'other' ? null : '.zip';
      if (need && !file.name.toLowerCase().endsWith(need)) return UI.toast(`Для ${Api.LAUNCHERS[pk.launcher]} нужен файл ${need}.`, { type: 'error' });
      progress.hidden = false;
      uploadBtn.disabled = true;
      const show = (f) => {
        bar.style.width = Math.round(f * 100) + '%';
        progress.setAttribute('aria-valuenow', String(Math.round(f * 100)));
        barText.textContent = `${Math.round(f * 100)}% из ${formatSize(file.size)}`;
      };
      show(0);
      try {
        await Api.admin.packs.upload(pk.id, file, show);
        UI.toast(pk.published ? 'Файл заменён — игроки уже скачивают новый.' : 'Файл загружен. Теперь сборку можно опубликовать.', { type: 'success' });
      } catch (err) {
        UI.toast(err.message, { type: 'error' });
        progress.hidden = true;
        uploadBtn.disabled = false;
      }
    });
    const publishBtn = h('button', { class: 'btn btn--sm' + (pk.published ? ' btn--ghost' : ''), type: 'button', disabled: !pk.fileName, title: pk.fileName ? null : 'Сначала загрузите файл' }, pk.published ? 'Скрыть от игроков' : 'Опубликовать');
    publishBtn.addEventListener('click', async () => {
      UI.setLoading(publishBtn, true);
      try {
        await Api.admin.packs.update(pk.id, { published: !pk.published });
        UI.toast(pk.published ? 'Сборка скрыта.' : 'Сборка опубликована — игроки её видят.', { type: 'success' });
      } catch (err) {
        UI.toast(err.message, { type: 'error' });
        UI.setLoading(publishBtn, false);
      }
    });
    const editBtn = h('button', { class: 'btn btn--sm btn--ghost', type: 'button', onclick: () => packForm(pk) }, icon('edit'), 'Изменить');
    const delBtn = h('button', { class: 'btn btn--sm btn--ghost', type: 'button', 'aria-label': 'Удалить сборку ' + pk.title }, icon('trash'));
    delBtn.addEventListener('click', async () => {
      const ok = await UI.confirm({ title: `Удалить «${pk.title}»?`, text: 'Файл удалится с сервера, игроки больше не смогут его скачать.', confirmText: 'Удалить', danger: true });
      if (!ok) return;
      try {
        await Api.admin.packs.remove(pk.id);
        UI.toast('Сборка удалена.');
      } catch (err) {
        UI.toast(err.message, { type: 'error' });
      }
    });
    const meta = pk.fileName ? [pk.fileName, formatSize(pk.fileSize), pk.version && 'версия ' + pk.version, 'скачиваний: ' + pk.downloads].filter(Boolean).join(' · ') : 'Файл ещё не загружен' + (pk.version ? ' · версия ' + pk.version : '');
    return h(
      'article',
      { class: 'pack pack--admin', dataset: { id: pk.id } },
      h('div', { class: 'pack__head' }, h('span', { class: 'pack__launcher pack__launcher--' + pk.launcher, text: Api.LAUNCHERS[pk.launcher] }), h('h3', { class: 'pack__title', text: pk.title }), h('span', { class: 'pill ' + (pk.published ? 'pill--approved' : 'pill--withdrawn'), text: pk.published ? 'Опубликована' : 'Черновик' })),
      h('p', { class: 'pack__meta', text: meta }),
      pk.description && h('p', { class: 'pack__desc', text: pk.description }),
      progress,
      h('div', { class: 'actions-row' }, uploadBtn, publishBtn, editBtn, delBtn),
      fileInput
    );
  }

  function packForm(pk) {
    const launcher = h(
      'select',
      { class: 'select', id: 'pack-launcher', name: 'launcher', 'aria-describedby': 'pack-launcher-hint' },
      Object.entries(Api.LAUNCHERS).map(([value, label]) => h('option', { value, text: label }))
    );
    launcher.value = pk ? pk.launcher : 'prism';
    const form = h(
      'form',
      { class: 'auth__form', novalidate: true },
      h('div', { class: 'form-alert', role: 'alert', hidden: true }),
      field({ label: 'Название', name: 'title', value: pk ? pk.title : '', placeholder: 'LWL для Prism Launcher', maxlength: Api.LIMITS.packTitle.max }),
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'field__label', for: 'pack-launcher', text: 'Лаунчер' }),
        h('div', { class: 'field__control' }, launcher),
        h('div', { class: 'field__hint', id: 'pack-launcher-hint', text: 'Prism и CurseForge — архив .zip (экспорт из лаунчера), Modrinth — .mrpack.' }),
        h('div', { class: 'field__error', 'aria-live': 'polite' })
      ),
      h('div', { class: 'form__grid' }, field({ label: 'Версия', name: 'version', value: pk ? pk.version : '', placeholder: '1.0', maxlength: Api.LIMITS.packVersion.max }), field({ label: 'Порядок', name: 'sort', type: 'number', value: pk ? String(pk.sort) : '0', hint: 'Меньше — выше в списке.' })),
      field({ label: 'Подпись для игроков', name: 'description', textarea: true, value: pk ? pk.description : '', placeholder: 'Что внутри, для кого эта сборка, сколько нужно памяти…', maxlength: Api.LIMITS.packDescription.max + 50 }),
      h('div', { class: 'modal__actions' }, h('button', { class: 'btn btn--secondary', type: 'button', text: 'Отмена', onclick: () => m.close() }), h('button', { class: 'btn', type: 'submit', text: pk ? 'Сохранить' : 'Создать' }))
    );
    const m = UI.modal({ title: pk ? 'Сборка' : 'Новая сборка', content: form });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      UI.clearErrors(form);
      const btn = form.querySelector('[type=submit]');
      UI.setLoading(btn, true);
      const data = { title: form.title.value, launcher: form.launcher.value, version: form.version.value, sort: Number(form.sort.value || 0), description: form.description.value };
      try {
        if (pk) await Api.admin.packs.update(pk.id, data);
        else await Api.admin.packs.create(data);
        m.close();
        UI.toast(pk ? 'Сборка сохранена.' : 'Сборка создана — теперь загрузите файл.', { type: 'success' });
      } catch (err) {
        UI.showFormError(form, err);
        UI.setLoading(btn, false);
      }
    });
  }

  /* ============================================================ админ: люди */

  function renderUsers(query, id) {
    splitScreen({
      name: 'users',
      title: 'Люди',
      sub: 'Аккаунты сайта, роли и сброс пароля.',
      query,
      statusKey: 'users',
      defaultStatus: 'all',
      searchLabel: 'Ник или почта',
      tabs: [
        ['all', 'Все'],
        ['reset', 'Сброс пароля'],
        ['user', 'Пользователи'],
        ['player', 'Игроки'],
        ['admin', 'Админы'],
      ],
      async loadItems({ status, query: q }) {
        const res = await Api.admin.users.list({ role: status, query: q });
        res.counts.all = res.counts.user + res.counts.player + res.counts.admin;
        return res;
      },
      renderRow: userRow,
      emptyFor: (st) => (st === 'reset' ? { iconName: 'check', title: 'Запросов на сброс пароля нет' } : { title: 'Здесь пока никого' }),
      placeholder: { iconName: 'users', title: 'Выберите человека', text: 'Здесь можно поменять роль и выдать ссылку для сброса пароля.' },
      selectedId: id,
      renderDetail: userDetail,
    });
  }

  function userRow(u, selected) {
    return h(
      'li',
      {},
      h(
        'a',
        { class: 'row', href: '#/admin/users/' + encodeURIComponent(u.id) + (selected !== undefined ? location.hash.replace(/^[^?]*/, '') : ''), 'aria-current': selected ? 'true' : null, dataset: { id: u.id } },
        h('span', { class: 'row__avatar' }, UI.avatar(u, 44), u.online && h('span', { class: 'online-dot', title: 'В сети' })),
        h('span', { class: 'row__main' }, h('span', { class: 'row__title' }, h('span', { class: 'row__name', text: u.nickname }), roleBadge(u.role)), h('span', { class: 'row__text', text: u.email })),
        h('span', { class: 'row__side' }, h('span', { text: UI.shortTime(u.createdAt), title: 'Регистрация: ' + UI.fullDate(u.createdAt) }), u.resetRequestedAt && h('span', { class: 'pill pill--pending', text: 'Сброс' }))
      )
    );
  }

  function userDetail(el, id, back) {
    let alive = true;
    const off = Api.admin.users.onChange(() => alive && load());
    const load = async () => {
      if (!el.querySelector('.detail')) clear(el).append(h('div', { class: 'detail' }, skeleton(3, 'skeleton-list--tall')));
      let data;
      try {
        data = await Api.admin.users.get(id);
      } catch (err) {
        if (!alive) return;
        return clear(el).append(
          err.code === 'NOT_FOUND' ? stateBlock({ iconName: 'search', title: 'Пользователь не найден', text: 'Возможно, аккаунт удалили.', action: h('button', { class: 'btn', type: 'button', text: 'К списку', onclick: back }) }) : errorState(err, load)
        );
      }
      if (!alive) return;
      const u = data.user;
      const last = data.applications[0];
      const row = (k, v) => [h('dt', { text: k }), h('dd', {}, v || '—')];
      clear(el).append(
        h(
          'div',
          { class: 'detail' },
          h(
            'header',
            { class: 'detail__head' },
            h('button', { class: 'icon-btn detail__back', type: 'button', 'aria-label': 'К списку', onclick: back }, icon('back')),
            UI.avatar(u, 56),
            h('div', { class: 'detail__who' }, h('h2', { class: 'detail__name', text: u.nickname }), h('p', { class: 'detail__meta', text: `${UI.presenceText(u)} · с нами с ${UI.fullDate(u.createdAt)}` })),
            roleBadge(u.role)
          ),
          u.resetRequestedAt && callout('info', 'lock', 'Просит сбросить пароль', `Запрос от ${UI.fullDate(u.resetRequestedAt)}. Создайте ссылку ниже и отправьте её игроку.`),
          h(
            'dl',
            { class: 'details' },
            row('Почта', u.email),
            row('Заявка', last && [pill(last.status), ' ', h('a', { class: 'link', href: '#/admin/applications/' + encodeURIComponent(last.id) + '?status=all', text: 'открыть' })]),
            row('Лицензия', last && Api.LICENSES[last.license])
          ),
          roleEditor(u),
          resetLinkBox(u),
          u.id !== me.id && !u.owner && h('div', { class: 'actions-row' }, h('button', { class: 'btn btn--ghost', type: 'button', onclick: () => removeUser(u) }, icon('trash'), 'Удалить аккаунт'))
        )
      );
    };
    load();
    return () => {
      alive = false;
      off();
    };
  }

  function roleEditor(u) {
    const box = h(
      'section',
      { class: 'review' },
      h('h3', { class: 'review__title', text: 'Роль' }),
      h('p', { class: 'field__hint', text: 'Пользователь — заявка и поддержка. Игрок — плюс вкладка «Сервер» с адресом и сборками (выдаётся сама при одобрении заявки). Админ — всё, включая эту панель.' })
    );
    if (u.owner) {
      box.append(h('p', { class: 'field__hint', text: 'Это владелец сайта (задан в LWL_ADMINS на сервере) — он всегда админ.' }));
      return box;
    }
    box.append(
      h(
        'div',
        { class: 'segmented', role: 'group', 'aria-label': 'Роль' },
        Object.entries(ROLE).map(([role, label]) =>
          h('button', {
            type: 'button',
            'aria-pressed': String(u.role === role),
            text: label,
            dataset: { role },
            onclick: async (e) => {
              if (u.role === role) return;
              const btn = e.currentTarget;
              if (role === 'admin' && !(await UI.confirm({ title: `Сделать ${u.nickname} админом?`, text: 'Админ видит все заявки и обращения и может менять роли.', confirmText: 'Сделать админом' }))) return;
              if (u.id === me.id && !(await UI.confirm({ title: 'Снять с себя админа?', text: 'Вы потеряете доступ к этой панели.', confirmText: 'Снять', danger: true }))) return;
              UI.setLoading(btn, true);
              try {
                await Api.admin.users.setRole(u.id, role);
                UI.toast(`${u.nickname} теперь: ${label.toLowerCase()}.`, { type: 'success' });
                if (u.id === me.id) location.reload();
              } catch (err) {
                UI.toast(err.message, { type: 'error' });
                UI.setLoading(btn, false);
              }
            },
          })
        )
      )
    );
    return box;
  }

  // Выданные ссылки помним до перезагрузки страницы: карточка перерисовывается, а ссылка должна остаться на экране.
  const issuedLinks = new Map();

  function resetLinkBox(u) {
    const out = h('div', { class: 'cmd', hidden: true });
    const showLink = ({ url, expiresAt }) => {
      clear(out).append(
        h('p', { class: 'cmd__title', text: 'Ссылка для ' + u.nickname }),
        h('div', { class: 'cmd__row' }, h('code', { class: 'cmd__code', text: url }), copyButton(url, 'Ссылка скопирована — отправьте её игроку.')),
        h('p', { class: 'field__hint', text: `Сработает один раз, до ${UI.fullDate(expiresAt)}. Когда игрок задаст новый пароль, все его старые входы завершатся.` })
      );
      out.hidden = false;
    };
    const btn = h('button', { class: 'btn btn--secondary', type: 'button' }, icon('link'), 'Ссылка для сброса пароля');
    btn.addEventListener('click', async () => {
      UI.setLoading(btn, true);
      try {
        const link = await Api.admin.users.resetLink(u.id);
        issuedLinks.set(u.id, link);
        showLink(link);
      } catch (err) {
        UI.toast(err.message, { type: 'error' });
      } finally {
        UI.setLoading(btn, false);
      }
    });
    const known = issuedLinks.get(u.id);
    if (known && known.expiresAt > Date.now()) showLink(known);
    return h(
      'section',
      { class: 'review' },
      h('h3', { class: 'review__title', text: 'Пароль' }),
      h('p', { class: 'field__hint', text: 'Писем сайт не отправляет: если человек забыл пароль, создайте ссылку и пришлите её ему (Telegram, Discord).' }),
      h('div', { class: 'actions-row' }, btn),
      out
    );
  }

  async function removeUser(u) {
    const ok = await UI.confirm({
      title: `Удалить аккаунт ${u.nickname}?`,
      text: `Удалятся профиль, заявки и переписка — отменить нельзя. Из вайтлиста сервера убирайте отдельно: /wl remove ${u.nickname}`,
      confirmText: 'Удалить',
      danger: true,
    });
    if (!ok) return;
    try {
      await Api.admin.users.remove(u.id);
      UI.toast('Аккаунт удалён.');
      go('#/admin/users');
    } catch (err) {
      UI.toast(err.message, { type: 'error' });
    }
  }

  /* ============================================================ новый пароль по ссылке */

  async function renderReset(token) {
    UI.closeModals();
    if (cleanup) cleanup();
    cleanup = null;
    screen = null;
    me = null;
    hideShell();
    document.title = 'Новый пароль — LWL';
    const box = h('div', { class: 'gate card' }, h('img', { class: 'gate__logo', src: 'assets/img/logo-3d.svg', alt: '', width: '140', height: '140' }), h('h1', { class: 'gate__title', text: 'Новый пароль' }));
    const slot = h('div', { class: 'gate__slot' }, skeleton(2));
    box.append(slot);
    clear(app).append(h('div', { class: 'lk-center' }, box));
    let info;
    try {
      info = await Api.auth.resetInfo(token);
    } catch (err) {
      clear(slot).append(h('p', { class: 'gate__text', text: err.code === 'NOT_FOUND' ? err.message : 'Не удалось проверить ссылку: ' + err.message }), h('div', { class: 'gate__actions' }, h('a', { class: 'btn btn--lg', href: 'lk.html', text: 'Ко входу' })));
      return;
    }
    const strength = h('div', { class: 'strength', 'data-level': '0', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span'));
    const pw = field({ label: 'Новый пароль', name: 'password', type: 'password', autocomplete: 'new-password', hint: 'Минимум 8 символов, буквы и цифры.' });
    pw.insertBefore(strength, pw.querySelector('.field__hint'));
    const form = h(
      'form',
      { class: 'auth__form gate__form', novalidate: true },
      h('div', { class: 'form-alert', role: 'alert', hidden: true }),
      h('input', { type: 'text', name: 'username', autocomplete: 'username', value: info.nickname, hidden: true }),
      pw,
      field({ label: 'Повторите пароль', name: 'password2', type: 'password', autocomplete: 'new-password' }),
      h('button', { class: 'btn btn--lg btn--block', type: 'submit', text: 'Сохранить и войти' })
    );
    form.password.addEventListener('input', () => strength.setAttribute('data-level', UI.passwordStrength(form.password.value)));
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      UI.clearErrors(form);
      const fields = {};
      const err = Api.validate.password(form.password.value);
      if (err) fields.password = err;
      if (form.password2.value !== form.password.value) fields.password2 = 'Пароли не совпадают.';
      if (Object.keys(fields).length) return UI.showFormError(form, new Api.ApiError('VALIDATION', null, { fields }));
      const btn = form.querySelector('[type=submit]');
      UI.setLoading(btn, true);
      try {
        await Api.auth.resetPassword(token, form.password.value);
        history.replaceState(null, '', location.pathname + '#/');
        UI.toast('Пароль изменён. Добро пожаловать!', { type: 'success' });
        boot();
      } catch (error) {
        UI.showFormError(form, error);
        UI.setLoading(btn, false);
      }
    });
    clear(slot).append(h('p', { class: 'gate__text', text: `Аккаунт ${info.nickname}. Придумайте новый пароль — после этого вы сразу войдёте.` }), form);
    form.password.focus();
  }

  /* ============================================================ профиль */

  function renderProfile() {
    const p = page({ title: 'Профиль', sub: 'Фото, никнейм и пароль.', key: 'profile' });

    /* --- фото --- */
    const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true });
    const avatarBox = h('div', { class: 'avatar-edit' });
    function drawAvatar() {
      clear(avatarBox).append(
        UI.avatar(me, 112),
        h(
          'div',
          { class: 'avatar-edit__side' },
          h(
            'div',
            { class: 'actions-row' },
            h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, icon('upload'), me.avatar ? 'Заменить фото' : 'Загрузить фото'),
            me.avatar && h('button', { class: 'btn btn--ghost', type: 'button', onclick: removeAvatar }, icon('trash'), 'Удалить')
          ),
          h('p', { class: 'field__hint', text: 'JPG, PNG, WebP или GIF до 8 МБ — обрежем до квадрата. Можно перетащить файл сюда.' })
        ),
        fileInput
      );
    }
    async function setAvatar(file) {
      const btn = avatarBox.querySelector('.btn');
      UI.setLoading(btn, true);
      try {
        const data = await UI.resizeImage(file, 400);
        me = await Api.profile.update({ avatar: data });
        UI.toast('Фото обновлено.', { type: 'success' });
      } catch (err) {
        UI.toast(err.message, { type: 'error' });
      } finally {
        drawAvatar();
      }
    }
    async function removeAvatar(e) {
      UI.setLoading(e.currentTarget, true);
      try {
        me = await Api.profile.update({ avatar: null });
        UI.toast('Фото удалено.');
      } catch (err) {
        UI.toast(err.message, { type: 'error' });
      } finally {
        drawAvatar();
      }
    }
    fileInput.addEventListener('change', () => fileInput.files[0] && setAvatar(fileInput.files[0]));
    ['dragenter', 'dragover'].forEach((t) =>
      avatarBox.addEventListener(t, (e) => {
        e.preventDefault();
        avatarBox.classList.add('is-dragover');
      })
    );
    ['dragleave', 'drop'].forEach((t) => avatarBox.addEventListener(t, () => avatarBox.classList.remove('is-dragover')));
    avatarBox.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) setAvatar(file);
    });
    drawAvatar();

    /* --- ник и почта --- */
    const nickForm = h(
      'form',
      { class: 'form', novalidate: true },
      h('div', { class: 'form-alert', role: 'alert', hidden: true }),
      h(
        'div',
        { class: 'form__grid' },
        me.role === 'player'
          ? field({ label: 'Никнейм в Minecraft', name: 'nickname', value: me.nickname, hint: 'Ник уже в вайтлисте сервера. Чтобы сменить его, напишите в поддержку.', attrs: { readonly: true } })
          : field({ label: 'Никнейм в Minecraft', name: 'nickname', value: me.nickname, maxlength: 16, autocomplete: 'nickname', hint: '3–16 символов: латиница, цифры, «_».', attrs: { autocapitalize: 'off', spellcheck: 'false' } }),
        field({ label: 'Почта', name: 'email', type: 'email', value: me.email, hint: 'Почту пока нельзя изменить.', attrs: { readonly: true } })
      ),
      me.role !== 'player' && h('div', { class: 'actions-row' }, h('button', { class: 'btn', type: 'submit', text: 'Сохранить', disabled: true }))
    );
    const nickBtn = nickForm.querySelector('[type=submit]');
    if (nickBtn) nickForm.nickname.addEventListener('input', () => (nickBtn.disabled = nickForm.nickname.value.trim() === me.nickname));
    nickForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      if (!nickBtn) return;
      UI.clearErrors(nickForm);
      const err = Api.validate.nickname(nickForm.nickname.value);
      if (err) return UI.showFormError(nickForm, new Api.ApiError('VALIDATION', null, { fields: { nickname: err } }));
      UI.setLoading(nickBtn, true);
      try {
        me = await Api.profile.update({ nickname: nickForm.nickname.value });
        UI.toast('Никнейм сохранён.', { type: 'success' });
        UI.setLoading(nickBtn, false);
        nickBtn.disabled = true;
      } catch (error) {
        UI.showFormError(nickForm, error);
        UI.setLoading(nickBtn, false);
      }
    });

    /* --- пароль --- */
    const strength = h('div', { class: 'strength', 'data-level': '0', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span'));
    const newPw = field({ label: 'Новый пароль', name: 'newPassword', type: 'password', autocomplete: 'new-password', hint: 'Минимум 8 символов, буквы и цифры.' });
    newPw.insertBefore(strength, newPw.querySelector('.field__hint'));
    const pwForm = h(
      'form',
      { class: 'form', novalidate: true },
      h('div', { class: 'form-alert', role: 'alert', hidden: true }),
      h('input', { type: 'text', name: 'username', autocomplete: 'username', value: me.nickname, hidden: true }),
      h('div', { class: 'form__grid' }, field({ label: 'Текущий пароль', name: 'currentPassword', type: 'password', autocomplete: 'current-password' }), h('div')),
      h('div', { class: 'form__grid' }, newPw, field({ label: 'Повторите новый пароль', name: 'newPassword2', type: 'password', autocomplete: 'new-password' })),
      h('div', { class: 'actions-row' }, h('button', { class: 'btn', type: 'submit', text: 'Сменить пароль' }))
    );
    pwForm.newPassword.addEventListener('input', () => strength.setAttribute('data-level', UI.passwordStrength(pwForm.newPassword.value)));
    pwForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      UI.clearErrors(pwForm);
      const fields = {};
      if (!pwForm.currentPassword.value) fields.currentPassword = 'Введите текущий пароль.';
      const pwErr = Api.validate.password(pwForm.newPassword.value);
      if (pwErr) fields.newPassword = pwErr;
      if (pwForm.newPassword2.value !== pwForm.newPassword.value) fields.newPassword2 = 'Пароли не совпадают.';
      if (Object.keys(fields).length) return UI.showFormError(pwForm, new Api.ApiError('VALIDATION', null, { fields }));
      const btn = pwForm.querySelector('[type=submit]');
      UI.setLoading(btn, true);
      try {
        await Api.profile.changePassword({ currentPassword: pwForm.currentPassword.value, newPassword: pwForm.newPassword.value });
        pwForm.reset();
        strength.setAttribute('data-level', '0');
        UI.toast('Пароль изменён. На других устройствах нужно войти заново.', { type: 'success' });
      } catch (error) {
        UI.showFormError(pwForm, error);
      } finally {
        UI.setLoading(btn, false);
      }
    });

    UI.append(p.body, [
      h('div', { class: 'stack' }, [
        section('Фото профиля', null, avatarBox),
        section('Никнейм и почта', null, nickForm),
        section('Пароль', null, pwForm),
        section('Удалить аккаунт', 'Удалятся профиль, заявки и переписка с поддержкой. Отменить это нельзя.', h('button', { class: 'btn btn--danger', type: 'button', text: 'Удалить аккаунт', onclick: deleteAccount }), 'card--danger'),
      ]),
    ]);
  }

  function section(title, text, content, extra) {
    return h('section', { class: 'card card--pad ' + (extra || '') }, h('h2', { class: 'card-title', text: title }), text && h('p', { class: 'card-sub', text }), h('div', { class: 'card-content' }, content));
  }

  function deleteAccount() {
    const form = h(
      'form',
      { class: 'auth__form', novalidate: true },
      h('p', { class: 'modal__text', text: 'Введите пароль, чтобы подтвердить удаление. Все ваши данные будут стёрты.' }),
      h('div', { class: 'form-alert', role: 'alert', hidden: true }),
      h('input', { type: 'text', name: 'username', autocomplete: 'username', value: me.nickname, hidden: true }),
      field({ label: 'Пароль', name: 'password', type: 'password', autocomplete: 'current-password' }),
      h('div', { class: 'modal__actions' }, h('button', { class: 'btn btn--secondary', type: 'button', text: 'Отмена', onclick: () => m.close() }), h('button', { class: 'btn btn--danger', type: 'submit', text: 'Удалить навсегда' }))
    );
    const m = UI.modal({ title: 'Удалить аккаунт?', content: form, size: 'sm' });
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      UI.clearErrors(form);
      const btn = form.querySelector('[type=submit]');
      UI.setLoading(btn, true);
      try {
        await Api.profile.deleteAccount({ password: form.password.value });
        location.href = 'index.html';
      } catch (err) {
        UI.showFormError(form, err);
        UI.setLoading(btn, false);
      }
    });
  }

  function safe(fn) {
    try {
      return fn();
    } catch (e) {
      return null;
    }
  }

  function safeJSON(s) {
    try {
      return JSON.parse(s);
    } catch (e) {
      return null;
    }
  }

  boot();
})();
