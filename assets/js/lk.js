/*
 * Личный кабинет: роутер и экраны.
 *   #/                        — главная кабинета (Frame 2 — игрок, Frame 4 — админ)
 *   #/apply                   — подать заявку
 *   #/application             — прогресс заявки
 *   #/support                 — чат с тех поддержкой (Frame 5)
 *   #/profile                 — редактировать профиль
 *   #/admin/applications[/id] — просмотр заявок
 *   #/admin/tickets[/id]      — просмотр обращений и чат с игроком (Frame 6)
 */
(function () {
  'use strict';
  const { h, icon, clear, field } = UI;
  const app = document.getElementById('app');

  let me = null;
  let cleanup = null;

  const STATUS = {
    pending: 'На рассмотрении',
    approved: 'Одобрена',
    rejected: 'Отклонена',
    withdrawn: 'Отозвана',
  };
  const ROLE = { player: 'Игрок', admin: 'Админ' };

  /* ============================================================ запуск */

  async function boot() {
    showLoading();
    try {
      me = await Api.auth.me();
    } catch (err) {
      return renderFatal(err, boot);
    }
    if (!me) return renderGate();
    Api.profile.startPresence();
    route();
  }

  // Событие может прийти из другой вкладки (там может быть другой аккаунт),
  // поэтому всегда перечитываем текущего пользователя этой вкладки.
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
    if (changed) route();
    else if (updated) document.querySelectorAll('[data-me]').forEach((el) => el.replaceWith(meBlock()));
  });

  window.addEventListener('hashchange', () => me && route());

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
    if (cleanup) cleanup();
    cleanup = null;
    document.body.classList.remove('lk--fullscreen');
    window.scrollTo(0, 0);
    const { parts, query } = parseHash();
    const [a, b, c] = parts;
    const needAdmin = () => me.role !== 'admin' && (renderForbidden(), true);

    if (!a) return renderDashboard();
    if (a === 'apply') return renderApply();
    if (a === 'application') return renderProgress();
    if (a === 'support') return renderSupport();
    if (a === 'profile') return renderProfile();
    if (a === 'admin' && b === 'applications') return needAdmin() || (c ? renderApplication(c) : renderApplications(query));
    if (a === 'admin' && b === 'tickets') return needAdmin() || (c ? renderTicket(c) : renderTickets(query));
    renderNotFound();
  }

  /* ============================================================ общие блоки */

  function showLoading() {
    clear(app).append(h('div', { class: 'lk-loading', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('span', { class: 'visually-hidden', text: 'Загрузка…' })));
  }

  function meBlock() {
    return h(
      'div',
      { class: 'me', 'data-me': '' },
      UI.avatar(me),
      h(
        'div',
        { class: 'me__text' },
        h('p', { class: 'me__name', text: me.nickname, title: me.nickname }),
        h('p', { class: 'me__status' }, 'Статус : ', h('span', { class: 'me__role', text: ROLE[me.role] || me.role }))
      )
    );
  }

  /** Экран «панель» (Frame 5/6): слева профиль и «Назад», справа содержимое. */
  function panel({ title, subtitle, back = '#/', actions, auto = true }) {
    const titleEl = h('h1', { class: 'panel__title', tabindex: '-1', text: title });
    const head = h(
      'header',
      { class: 'panel__head' },
      h('a', { class: 'icon-btn panel__head-back', href: back, 'aria-label': 'Назад' }, icon('back')),
      h('div', { class: 'panel__head-text' }, titleEl, subtitle && h('p', { class: 'panel__subtitle panel__subtitle--muted', text: subtitle })),
      actions && h('div', { class: 'panel__head-actions' }, actions)
    );
    const body = h('div', { class: 'panel__body' });
    const main = h('section', { class: 'panel__main', 'aria-label': title }, head, body);
    const root = h(
      'div',
      { class: 'panel' + (auto ? ' panel--auto' : '') },
      h('aside', { class: 'panel__side', 'aria-label': 'Мой профиль' }, meBlock(), h('a', { class: 'btn panel__back', href: back, text: 'Назад' })),
      main
    );
    clear(app).append(root);
    document.title = `${title} — LWL`;
    requestAnimationFrame(() => titleEl.focus({ preventScroll: true }));
    return { root, main, body, head, titleEl };
  }

  function stateBlock({ iconName, logo, title, text, action, error }) {
    return h(
      'div',
      { class: 'state' + (error ? ' state--error' : '') },
      h('div', { class: 'state__icon' }, logo ? h('img', { src: 'assets/img/logo.svg', alt: '', width: '72', height: '72' }) : icon(iconName || 'info')),
      h('p', { class: 'state__title', text: title }),
      text && h('p', { class: 'state__text', text }),
      action
    );
  }

  function errorState(err, retry) {
    return stateBlock({ iconName: 'alert', error: true, title: 'Не удалось загрузить', text: err.message, action: h('button', { class: 'btn', type: 'button', text: 'Повторить', onclick: retry }) });
  }

  function skeletonList(n = 4) {
    return h('div', { class: 'skeleton-list', 'aria-hidden': 'true' }, Array.from({ length: n }, () => h('div', { class: 'skeleton' })));
  }

  function renderFatal(err, retry) {
    clear(app).append(h('div', { class: 'lk-loading' }, errorState(err, retry)));
  }

  function renderForbidden() {
    const p = panel({ title: 'Нет доступа' });
    p.body.append(stateBlock({ iconName: 'lock', title: 'Раздел только для администраторов', text: 'Если вы админ, попросите выдать права.', action: h('a', { class: 'btn', href: '#/', text: 'В кабинет' }) }));
  }

  function renderNotFound() {
    const p = panel({ title: 'Страница не найдена' });
    p.body.append(stateBlock({ logo: true, title: 'Такой страницы нет', text: 'Возможно, ссылка устарела.', action: h('a', { class: 'btn', href: '#/', text: 'В кабинет' }) }));
  }

  /* ============================================================ вход */

  function renderGate() {
    if (cleanup) cleanup();
    cleanup = null;
    document.title = 'Вход — LWL';
    const openAuth = (mode) => Auth.open({ mode, onSuccess: () => boot() });
    clear(app).append(
      h(
        'div',
        { class: 'lk-loading' },
        stateBlock({
          logo: true,
          title: 'Личный кабинет',
          text: 'Войдите или создайте аккаунт, чтобы подать заявку на сервер и написать в тех поддержку.',
          action: h(
            'div',
            { class: 'modal__actions' },
            h('button', { class: 'btn', type: 'button', text: 'Войти', onclick: () => openAuth('login') }),
            h('button', { class: 'btn btn--ghost', type: 'button', text: 'Регистрация', onclick: () => openAuth('register') })
          ),
        })
      )
    );
    if (!document.querySelector('.auth-dialog')) openAuth('login');
  }

  /* ============================================================ главная кабинета */

  function renderDashboard() {
    document.title = 'Личный кабинет — LWL';
    const admin = me.role === 'admin';
    const stroke = () => h('img', { class: 'lk-card__stroke', src: 'assets/img/lk-stroke.svg', width: '13.2844', height: '5.58342', alt: '' });
    const card = (href, lines, img, withStroke, extraClass) =>
      h(
        'a',
        { class: 'lk-card' + (extraClass ? ' ' + extraClass : ''), href },
        h('span', { class: 'lk-card__title' }, lines[0], h('br'), lines[1]),
        img,
        withStroke && stroke(),
        h('span', { class: 'lk-card__badge', hidden: true })
      );
    const progressImg = h('img', { class: 'lk-card__img lk-card__img--progress', src: 'assets/img/lk-progress.webp', width: '255', height: '223', alt: '' });
    const supportImg = h('img', { class: 'lk-card__img lk-card__img--support', src: 'assets/img/lk-support.webp', width: '281', height: '224', alt: '' });

    const card1 = admin ? card('#/admin/applications', ['Просмотр', 'Заявок'], progressImg, true, 'lk-card--shift') : card('#/application', ['Прогресс', 'заявки'], progressImg, false);
    const card2 = admin ? card('#/admin/tickets', ['Просмотр', 'Обращений'], supportImg, false) : card('#/support', ['Тех', 'поддержка'], supportImg, true);

    const logout = h('button', { class: 'btn btn--lg dash__logout', type: 'button', text: 'Выход с аккаунта', onclick: onLogout });
    clear(app).append(
      h(
        'div',
        { class: 'dash' },
        h('h1', { class: 'visually-hidden', text: 'Личный кабинет' }),
        h('section', { class: 'dash__profile', 'aria-label': 'Мой профиль' }, meBlock()),
        h('nav', { class: 'dash__cards', 'aria-label': 'Разделы' }, card1, card2),
        h(
          'div',
          { class: 'dash__actions' },
          h('a', { class: 'btn btn--lg', href: '#/apply', text: 'Подать заявку' }),
          h('a', { class: 'btn btn--lg', href: '#/profile', text: 'Редактировать профиль' })
        ),
        logout
      )
    );

    const badge = (cardEl, text, alert) => {
      const b = cardEl.querySelector('.lk-card__badge');
      b.hidden = !text;
      b.textContent = text || '';
      b.classList.toggle('lk-card__badge--alert', !!alert);
    };
    async function updateBadges() {
      try {
        const s = await Api.summary();
        if (admin) {
          badge(card1, s.pendingApplications ? `${s.pendingApplications} ${UI.plural(s.pendingApplications, 'новая', 'новые', 'новых')}` : '');
          badge(card2, s.unreadConversations ? `${s.unreadConversations} ${UI.plural(s.unreadConversations, 'непрочитанное', 'непрочитанных', 'непрочитанных')}` : '', true);
        } else {
          badge(card1, s.applicationStatus ? STATUS[s.applicationStatus] : '', s.applicationStatus === 'rejected');
          badge(card2, s.unreadMessages ? `${s.unreadMessages} ${UI.plural(s.unreadMessages, 'новое сообщение', 'новых сообщения', 'новых сообщений')}` : '', true);
        }
      } catch (e) {
        /* бейджи — не критично */
      }
    }
    updateBadges();
    const offs = [Api.on('conversations', updateBadges), Api.on('applications', updateBadges)];
    const timer = setInterval(updateBadges, 20000);
    cleanup = () => {
      offs.forEach((off) => off());
      clearInterval(timer);
    };
  }

  async function onLogout(e) {
    const ok = await UI.confirm({ title: 'Выйти из аккаунта?', text: 'Чтобы вернуться, понадобится снова ввести пароль.', confirmText: 'Выйти' });
    if (!ok) return;
    UI.setLoading(e.target, true);
    await Api.auth.logout().catch(() => null);
    location.href = 'index.html';
  }

  /* ============================================================ заявка: форма */

  async function renderApply() {
    const p = panel({ title: 'Подать заявку', subtitle: 'Анкета для вступления на сервер' });
    p.body.append(skeletonList(3));
    let existing;
    try {
      existing = await Api.applications.mine();
    } catch (err) {
      return clear(p.body).append(errorState(err, renderApply));
    }
    if (existing && (existing.status === 'pending' || existing.status === 'approved')) {
      clear(p.body).append(
        stateBlock({
          iconName: existing.status === 'approved' ? 'check' : 'clock',
          title: existing.status === 'approved' ? 'Вы уже на сервере' : 'Заявка уже отправлена',
          text: existing.status === 'approved' ? 'Ваша заявка одобрена — новая не нужна.' : 'Дождитесь решения администраторов. Статус — на странице прогресса.',
          action: h('a', { class: 'btn', href: '#/application', text: 'Прогресс заявки' }),
        })
      );
      return;
    }

    const DRAFT = 'lwl.apply.draft.' + me.id;
    const draft = safeJSON(sessionStorage.getItem(DRAFT)) || {};
    const about = field({ label: 'Расскажите о себе', name: 'about', textarea: true, value: draft.about || '', placeholder: 'Во что любите играть, что хотите строить, был ли опыт на других серверах…', maxlength: Api.LIMITS.about.max + 100 });
    const aboutControl = about.querySelector('textarea');
    about.querySelector('.field__label').after(h('div', { class: 'field__row' }, h('span', { class: 'field__hint', text: `От ${Api.LIMITS.about.min} символов` }), UI.counter(aboutControl, Api.LIMITS.about.max)));
    about.querySelector('.field__label').remove();
    about.prepend(h('label', { class: 'field__label', for: aboutControl.id, text: 'Расскажите о себе' }));

    const nick = field({ label: 'Никнейм в Minecraft', name: 'nickname', value: me.nickname, hint: 'Берём из профиля. Изменить можно в «Редактировать профиль».', attrs: { readonly: true } });
    const form = h(
      'form',
      { class: 'form', novalidate: true },
      h('div', { class: 'form-alert', role: 'alert', hidden: true }),
      h(
        'div',
        { class: 'form__grid' },
        nick,
        field({ label: 'Возраст', name: 'age', type: 'number', value: draft.age || '', inputmode: 'numeric', attrs: { min: Api.LIMITS.age.min, max: Api.LIMITS.age.max } })
      ),
      h(
        'div',
        { class: 'form__grid' },
        field({ label: 'Откуда узнали о сервере', name: 'source', options: Api.APPLICATION_SOURCES, value: draft.source || '' }),
        field({ label: 'Telegram или Discord для связи', name: 'contact', value: draft.contact || '', placeholder: 'Необязательно', maxlength: Api.LIMITS.contact.max, autocomplete: 'off' })
      ),
      about,
      h(
        'div',
        { class: 'field' },
        h('label', { class: 'checkbox' }, h('input', { type: 'checkbox', name: 'agree' }), h('span', { text: 'Я прочитал(а) и принимаю правила сервера' })),
        h('div', { class: 'field__error', 'aria-live': 'polite' })
      ),
      h('div', { class: 'form__actions' }, h('button', { class: 'btn btn--lg', type: 'submit', text: 'Отправить заявку' }), h('a', { class: 'link-btn', href: '#/', text: 'Отмена' }))
    );
    form.agree.checked = !!draft.agree;
    form.source.value = draft.source || '';

    const saveDraft = UI.debounce(() => {
      try {
        sessionStorage.setItem(DRAFT, JSON.stringify({ age: form.age.value, source: form.source.value, contact: form.contact.value, about: form.about.value, agree: form.agree.checked }));
      } catch (e) {
        /* нет места — не страшно */
      }
    }, 300);
    form.addEventListener('input', saveDraft);
    form.addEventListener('change', saveDraft);

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      UI.clearErrors(form);
      const data = { age: form.age.value, source: form.source.value, contact: form.contact.value, about: form.about.value, agree: form.agree.checked };
      const errors = Api.validate.application(data);
      if (Object.keys(errors).length) return UI.showFormError(form, new Api.ApiError('VALIDATION', null, { fields: errors }));
      const btn = form.querySelector('[type=submit]');
      UI.setLoading(btn, true);
      try {
        await Api.applications.submit(data);
        sessionStorage.removeItem(DRAFT);
        UI.toast('Заявка отправлена! Следите за статусом здесь.', { type: 'success' });
        go('#/application');
      } catch (err) {
        UI.showFormError(form, err);
        UI.setLoading(btn, false);
      }
    });

    UI.append(clear(p.body), [
      h('p', { class: 'form__lead', text: 'Заполните анкету — администраторы прочитают её и примут решение. Ответ появится на странице «Прогресс заявки».' }),
      existing && existing.status === 'rejected' && rejectedCallout(existing),
      form,
    ]);
  }

  /* ============================================================ заявка: прогресс */

  async function renderProgress() {
    const p = panel({ title: 'Прогресс заявки' });
    const load = async () => {
      clear(p.body).append(skeletonList(3));
      let a;
      try {
        a = await Api.applications.mine();
      } catch (err) {
        return clear(p.body).append(errorState(err, load));
      }
      if (!a) {
        return clear(p.body).append(
          stateBlock({ logo: true, title: 'Вы ещё не подавали заявку', text: 'Заполните короткую анкету — и администраторы рассмотрят её.', action: h('a', { class: 'btn', href: '#/apply', text: 'Подать заявку' }) })
        );
      }
      clear(p.body).append(steps(a), statusCallout(a), detailsList(a), progressActions(a));
    };
    await load();
    const off = Api.applications.onChange(load);
    cleanup = off;
  }

  function steps(a) {
    const decided = a.status === 'approved' || a.status === 'rejected';
    const last = a.history[a.history.length - 1];
    const step = (cls, num, title, date) =>
      h('li', { class: 'step ' + cls }, h('div', { class: 'step__num' }, num), h('p', { class: 'step__title', text: title }), date && h('p', { class: 'step__date', text: date }));
    const decisionCls = a.status === 'approved' ? 'step--done' : a.status === 'rejected' || a.status === 'withdrawn' ? 'step--rejected' : '';
    const decisionIcon = a.status === 'approved' ? icon('check') : a.status === 'rejected' || a.status === 'withdrawn' ? icon('close') : '3';
    return h(
      'ol',
      { class: 'steps', 'aria-label': 'Этапы заявки' },
      step('step--done', icon('check'), 'Заявка отправлена', UI.fullDate(a.createdAt)),
      step(decided ? 'step--done' : a.status === 'pending' ? 'step--current' : '', decided ? icon('check') : '2', 'На рассмотрении', a.status === 'pending' ? 'Сейчас' : ''),
      step(decisionCls, decisionIcon, a.status === 'pending' ? 'Решение' : STATUS[a.status], a.status !== 'pending' ? UI.fullDate(last.at) : 'Ожидает')
    );
  }

  function rejectedCallout(a) {
    return h(
      'div',
      { class: 'callout callout--danger' },
      icon('alert'),
      h('div', {}, h('p', { class: 'callout__title', text: 'Прошлая заявка отклонена' }), a.comment && h('p', { class: 'callout__quote', text: a.comment }), h('p', { text: 'Учтите комментарий и попробуйте ещё раз.' }))
    );
  }

  function statusCallout(a) {
    const tg = (window.LWL_CONFIG && window.LWL_CONFIG.telegramUrl) || '';
    if (a.status === 'pending') {
      return h('div', { class: 'callout', role: 'status' }, icon('clock'), h('div', {}, h('p', { class: 'callout__title', text: 'Заявка на рассмотрении' }), h('p', { text: 'Администраторы прочитают анкету и примут решение — оно появится на этой странице.' })));
    }
    if (a.status === 'approved') {
      return h(
        'div',
        { class: 'callout callout--success', role: 'status' },
        icon('check'),
        h(
          'div',
          {},
          h('p', { class: 'callout__title', text: 'Заявка одобрена! Добро пожаловать на LWL' }),
          a.comment && h('p', { class: 'callout__quote', text: a.comment }),
          h('p', {}, 'Новости и обновления — в ', h('a', { class: 'link-btn', href: /^https:\/\//.test(tg) ? tg : 'https://t.me/', target: '_blank', rel: 'noopener noreferrer', text: 'нашем Telegram' }), '.')
        )
      );
    }
    if (a.status === 'rejected') {
      return h(
        'div',
        { class: 'callout callout--danger', role: 'status' },
        icon('alert'),
        h('div', {}, h('p', { class: 'callout__title', text: 'Заявка отклонена' }), a.comment && h('p', { class: 'callout__quote', text: a.comment }), h('p', { text: 'Можно исправить анкету и подать заново.' }))
      );
    }
    return h('div', { class: 'callout' }, icon('info'), h('div', {}, h('p', { class: 'callout__title', text: 'Вы отозвали заявку' }), h('p', { text: 'Подайте новую, когда будете готовы.' })));
  }

  function detailsList(a) {
    const row = (k, v) => [h('dt', { text: k }), h('dd', { text: v || '—' })];
    return h(
      'dl',
      { class: 'details' },
      row('Никнейм', a.nickname),
      row('Возраст', String(a.age)),
      row('Откуда узнали', a.source),
      row('Контакт', a.contact),
      row('О себе', a.about),
      row('Отправлена', UI.fullDate(a.createdAt))
    );
  }

  function progressActions(a) {
    const box = h('div', { class: 'form__actions' });
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
    if (a.status === 'rejected' || a.status === 'withdrawn') box.append(h('a', { class: 'btn', href: '#/apply', text: 'Подать новую заявку' }));
    box.append(h('a', { class: 'link-btn', href: '#/support', text: 'Вопрос по заявке? Написать в поддержку' }));
    return box;
  }

  /* ============================================================ чаты */

  async function renderSupport() {
    const p = panel({ title: 'Тех поддержка', auto: false });
    document.body.classList.add('lk--fullscreen');
    p.body.remove();
    const holder = h('div', { class: 'panel__body' }, skeletonList(4));
    p.main.append(holder);
    try {
      const conv = await Api.chats.support();
      if (!document.contains(p.main)) return;
      cleanup = Chat.mount(p.main, { conversationId: conv.id, me, onBack: () => go('#/') });
    } catch (err) {
      clear(holder).append(errorState(err, renderSupport));
    }
  }

  function renderTicket(id) {
    const p = panel({ title: 'Обращение', back: '#/admin/tickets', auto: false });
    document.body.classList.add('lk--fullscreen');
    cleanup = Chat.mount(p.main, { conversationId: id, me, onBack: () => go('#/admin/tickets') });
  }

  /* ============================================================ админ: заявки */

  function renderApplications(query) {
    const status = ['pending', 'approved', 'rejected', 'all'].includes(query.get('status')) ? query.get('status') : 'pending';
    const q = query.get('q') || '';
    const p = panel({ title: 'Просмотр заявок' });
    const tabsDef = [
      ['pending', 'Новые'],
      ['approved', 'Одобренные'],
      ['rejected', 'Отклонённые'],
      ['all', 'Все'],
    ];
    const tabs = h(
      'div',
      { class: 'tabs', role: 'tablist', 'aria-label': 'Фильтр заявок' },
      tabsDef.map(([key, label]) =>
        h('a', { class: 'tabs__tab', role: 'tab', href: `#/admin/applications?status=${key}${q ? '&q=' + encodeURIComponent(q) : ''}`, 'aria-selected': String(key === status), dataset: { key } }, label, h('span', { class: 'tabs__count', hidden: true }))
      )
    );
    const search = searchBox(q, (value) => {
      history.replaceState(null, '', `#/admin/applications?status=${status}${value ? '&q=' + encodeURIComponent(value) : ''}`);
      load(value);
    });
    const listBox = h('div');
    p.body.append(h('div', { class: 'toolbar' }, tabs, search), listBox);

    let seq = 0;
    async function load(term = q) {
      const my = ++seq;
      if (!listBox.firstChild) listBox.append(skeletonList());
      try {
        const { items, counts } = await Api.applications.list({ status, query: term });
        if (my !== seq) return;
        tabs.querySelectorAll('.tabs__tab').forEach((t) => {
          const n = t.dataset.key === 'all' ? Object.values(counts).reduce((s, x) => s + x, 0) : counts[t.dataset.key] || 0;
          const c = t.querySelector('.tabs__count');
          c.hidden = !n;
          c.textContent = n;
        });
        clear(listBox);
        if (!items.length) {
          const empty = {
            pending: ['Новых заявок нет', 'Как только игрок подаст анкету, она появится здесь.'],
            approved: ['Одобренных пока нет', ''],
            rejected: ['Отклонённых нет', ''],
            all: ['Заявок пока нет', 'Игроки подают их из личного кабинета.'],
          }[status];
          listBox.append(term ? stateBlock({ iconName: 'search', title: 'Ничего не нашлось', text: `По запросу «${term}» заявок нет.` }) : stateBlock({ logo: true, title: empty[0], text: empty[1] }));
          return;
        }
        listBox.append(
          h(
            'ul',
            { class: 'list' },
            items.map((a) =>
              h(
                'li',
                {},
                h(
                  'a',
                  { class: 'row', href: '#/admin/applications/' + encodeURIComponent(a.id) },
                  UI.avatar(a.applicant || { nickname: a.nickname }),
                  h('div', { class: 'row__main' }, h('div', { class: 'row__title' }, h('span', { text: a.nickname })), h('p', { class: 'row__text', text: `${a.age} лет · ${a.source} · ${a.about}` })),
                  h('div', { class: 'row__side' }, h('span', { class: 'pill pill--' + a.status, text: STATUS[a.status] }), h('span', { text: UI.shortTime(a.createdAt), title: UI.fullDate(a.createdAt) }))
                )
              )
            )
          )
        );
      } catch (err) {
        if (my === seq) clear(listBox).append(errorState(err, () => load(term)));
      }
    }
    load();
    cleanup = Api.applications.onChange(() => load(search.querySelector('input').value));
  }

  async function renderApplication(id) {
    const p = panel({ title: 'Заявка', back: '#/admin/applications' });
    const load = async () => {
      clear(p.body).append(skeletonList(3));
      let a;
      try {
        a = await Api.applications.get(id);
      } catch (err) {
        return clear(p.body).append(err.code === 'NOT_FOUND' ? stateBlock({ iconName: 'search', title: 'Заявка не найдена', text: 'Возможно, игрок удалил аккаунт.', action: h('a', { class: 'btn', href: '#/admin/applications', text: 'К списку заявок' }) }) : errorState(err, load));
      }
      p.titleEl.textContent = `Заявка ${a.nickname}`;
      document.title = `Заявка ${a.nickname} — LWL`;
      const header = h(
        'div',
        { class: 'avatar-edit' },
        UI.avatar(a.applicant || { nickname: a.nickname }, 88),
        h(
          'div',
          {},
          h('p', { class: 'section__title', text: a.nickname }),
          h('p', {}, h('span', { class: 'pill pill--' + a.status, text: STATUS[a.status] }), ' ', h('span', { class: 'field__hint', text: a.applicant ? UI.presenceText(a.applicant) : 'Аккаунт удалён' }))
        )
      );
      clear(p.body).append(h('div', { class: 'section' }, header), h('div', { class: 'section' }, detailsList(a)), a.status === 'pending' ? reviewForm(a) : decisionInfo(a));
    };

    function decisionInfo(a) {
      const who = a.reviewer ? a.reviewer.nickname : 'администратор';
      const text = a.status === 'withdrawn' ? 'Игрок отозвал заявку.' : `${STATUS[a.status]} — ${who}, ${UI.fullDate(a.updatedAt)}.`;
      return h('div', { class: 'section' }, h('div', { class: 'callout' + (a.status === 'approved' ? ' callout--success' : a.status === 'rejected' ? ' callout--danger' : '') }, icon(a.status === 'approved' ? 'check' : 'info'), h('div', {}, h('p', { text }), a.comment && h('p', { class: 'callout__quote', text: a.comment }))));
    }

    function reviewForm(a) {
      const comment = field({ label: 'Комментарий игроку', name: 'comment', textarea: true, placeholder: 'Обязателен при отказе: что исправить в анкете', maxlength: Api.LIMITS.reviewComment.max + 50 });
      const form = h(
        'form',
        { class: 'review', novalidate: true },
        h('p', { class: 'section__title', text: 'Решение' }),
        h('div', { class: 'form-alert', role: 'alert', hidden: true }),
        comment,
        h('div', { class: 'review__buttons' }, h('button', { class: 'btn btn--lg', type: 'submit', value: 'approved', text: 'Одобрить' }), h('button', { class: 'btn btn--lg btn--danger', type: 'submit', value: 'rejected', text: 'Отклонить' }))
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
      return h('div', { class: 'section' }, form);
    }

    await load();
    cleanup = Api.applications.onChange(load);
  }

  /* ============================================================ админ: обращения */

  function renderTickets(query) {
    const status = ['open', 'closed', 'all'].includes(query.get('status')) ? query.get('status') : 'open';
    const q = query.get('q') || '';
    const p = panel({ title: 'Просмотр обращений' });
    const tabs = h(
      'div',
      { class: 'tabs', role: 'tablist', 'aria-label': 'Фильтр обращений' },
      [
        ['open', 'Открытые'],
        ['closed', 'Закрытые'],
        ['all', 'Все'],
      ].map(([key, label]) => h('a', { class: 'tabs__tab', role: 'tab', href: `#/admin/tickets?status=${key}`, 'aria-selected': String(key === status), text: label }))
    );
    const search = searchBox(q, (value) => {
      history.replaceState(null, '', `#/admin/tickets?status=${status}${value ? '&q=' + encodeURIComponent(value) : ''}`);
      load(value);
    });
    const listBox = h('div');
    p.body.append(h('div', { class: 'toolbar' }, tabs, search), listBox);

    let seq = 0;
    async function load(term = search.querySelector('input').value) {
      const my = ++seq;
      if (!listBox.firstChild) listBox.append(skeletonList());
      try {
        const items = await Api.chats.list({ status, query: term });
        if (my !== seq) return;
        clear(listBox);
        if (!items.length) {
          listBox.append(
            term
              ? stateBlock({ iconName: 'search', title: 'Ничего не нашлось', text: `Нет обращений от «${term}».` })
              : stateBlock({ logo: true, title: status === 'closed' ? 'Закрытых обращений нет' : 'Все обращения разобраны', text: status === 'open' ? 'Новые вопросы игроков появятся здесь.' : '' })
          );
          return;
        }
        listBox.append(
          h(
            'ul',
            { class: 'list' },
            items.map((c) => {
              const last = c.lastMessage;
              const prefix = last ? (last.authorId === me.id ? 'Вы: ' : last.authorId === 'system' ? '' : '') : '';
              return h(
                'li',
                {},
                h(
                  'a',
                  { class: 'row', href: '#/admin/tickets/' + encodeURIComponent(c.id) },
                  UI.avatar(c.player),
                  h(
                    'div',
                    { class: 'row__main' },
                    h('div', { class: 'row__title' }, h('span', { text: c.player ? c.player.nickname : 'Удалённый аккаунт' }), c.player && c.player.online && h('span', { class: 'dot', title: 'В сети' }), c.status === 'closed' && h('span', { class: 'pill pill--closed', text: 'Закрыто' })),
                    h('p', { class: 'row__text' + (c.unread ? ' row__text--unread' : ''), text: last ? prefix + last.text : 'Нет сообщений' })
                  ),
                  h('div', { class: 'row__side' }, last && h('span', { text: UI.shortTime(last.createdAt), title: UI.fullDate(last.createdAt) }), c.unread ? h('span', { class: 'unread', text: c.unread, 'aria-label': `${c.unread} непрочитанных` }) : null)
                )
              );
            })
          )
        );
      } catch (err) {
        if (my === seq) clear(listBox).append(errorState(err, () => load(term)));
      }
    }
    load(q);
    const off = Api.chats.onListChange(() => load());
    const timer = setInterval(() => document.visibilityState === 'visible' && load(), Api.mode === 'server' ? Api.config.pollIntervalMs : 20000);
    cleanup = () => {
      off();
      clearInterval(timer);
    };
  }

  function searchBox(value, onSearch) {
    const input = h('input', { class: 'input', type: 'search', placeholder: 'Поиск по нику', 'aria-label': 'Поиск по нику', value });
    input.value = value;
    input.addEventListener('input', UI.debounce(() => onSearch(input.value.trim()), 300));
    return h('div', { class: 'search', role: 'search' }, icon('search'), input);
  }

  /* ============================================================ профиль */

  function renderProfile() {
    const p = panel({ title: 'Редактировать профиль' });

    /* --- аватар --- */
    const fileInput = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', hidden: true });
    const avatarBox = h('div', { class: 'avatar-edit' });
    function drawAvatar() {
      clear(avatarBox).append(
        UI.avatar(me),
        h(
          'div',
          { class: 'avatar-edit__buttons' },
          h('button', { class: 'btn', type: 'button', text: me.avatar ? 'Загрузить другое' : 'Загрузить фото', onclick: () => fileInput.click() }),
          me.avatar && h('button', { class: 'btn btn--ghost', type: 'button', text: 'Удалить фото', onclick: removeAvatar }),
          h('p', { class: 'drop-hint', text: 'JPG, PNG, WebP или GIF до 8 МБ. Можно перетащить файл сюда.' })
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
        field({ label: 'Никнейм в Minecraft', name: 'nickname', value: me.nickname, maxlength: 16, autocomplete: 'nickname', hint: '3–16 символов: латиница, цифры, «_».', attrs: { autocapitalize: 'off', spellcheck: 'false' } }),
        field({ label: 'Почта', name: 'email', type: 'email', value: me.email, hint: 'Почту пока нельзя изменить.', attrs: { readonly: true } })
      ),
      h('div', { class: 'form__actions' }, h('button', { class: 'btn', type: 'submit', text: 'Сохранить', disabled: true }))
    );
    const nickBtn = nickForm.querySelector('[type=submit]');
    nickForm.nickname.addEventListener('input', () => (nickBtn.disabled = nickForm.nickname.value.trim() === me.nickname));
    nickForm.addEventListener('submit', async (e) => {
      e.preventDefault();
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
      field({ label: 'Текущий пароль', name: 'currentPassword', type: 'password', autocomplete: 'current-password' }),
      h('div', { class: 'form__grid' }, newPw, field({ label: 'Повторите новый пароль', name: 'newPassword2', type: 'password', autocomplete: 'new-password' })),
      h('div', { class: 'form__actions' }, h('button', { class: 'btn', type: 'submit', text: 'Сменить пароль' }))
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

    /* --- демо-роль --- */
    let demoSection = null;
    if (Api.mode === 'demo') {
      const seg = h(
        'div',
        { class: 'segmented', role: 'group', 'aria-label': 'Роль' },
        ['player', 'admin'].map((role) =>
          h('button', {
            type: 'button',
            'aria-pressed': String(me.role === role),
            text: ROLE[role],
            onclick: async (e) => {
              if (me.role === role) return;
              const btn = e.currentTarget;
              UI.setLoading(btn, true);
              try {
                await Api.profile.setDemoRole(role);
                UI.toast(`Теперь вы ${role === 'admin' ? 'админ' : 'игрок'}.`, { type: 'success' });
              } catch (err) {
                UI.toast(err.message, { type: 'error' });
                UI.setLoading(btn, false);
              }
            },
          })
        )
      );
      demoSection = h(
        'section',
        { class: 'section' },
        h('h2', { class: 'section__title', text: 'Демо-режим' }),
        h('p', {
          class: 'section__text',
          text: 'Сервера пока нет: аккаунты, заявки и переписка хранятся только в этом браузере. Роль здесь можно переключить, чтобы посмотреть кабинет администратора. Чтобы проверить переписку с двух сторон, войдите вторым аккаунтом в соседней вкладке без галочки «Запомнить меня».',
        }),
        seg
      );
    }

    /* --- удаление --- */
    const danger = h(
      'section',
      { class: 'section section--danger' },
      h('h2', { class: 'section__title', text: 'Удалить аккаунт' }),
      h('p', { class: 'section__text', text: 'Удалятся профиль, заявки и переписка с поддержкой. Отменить это нельзя.' }),
      h('button', { class: 'btn btn--danger', type: 'button', text: 'Удалить аккаунт', onclick: deleteAccount })
    );

    UI.append(p.body, [
      h('section', { class: 'section' }, h('h2', { class: 'section__title', text: 'Фото профиля' }), avatarBox),
      h('section', { class: 'section' }, h('h2', { class: 'section__title', text: 'Никнейм и почта' }), nickForm),
      h('section', { class: 'section' }, h('h2', { class: 'section__title', text: 'Пароль' }), pwForm),
      demoSection,
      danger,
    ]);
  }

  function deleteAccount() {
    const form = h(
      'form',
      { class: 'auth__form', novalidate: true },
      h('p', { class: 'modal__text', text: 'Введите пароль, чтобы подтвердить удаление. Все ваши данные будут стёрты.' }),
      h('div', { class: 'form-alert', role: 'alert', hidden: true }),
      h('input', { type: 'text', name: 'username', autocomplete: 'username', value: me.nickname, hidden: true }),
      field({ label: 'Пароль', name: 'password', type: 'password', autocomplete: 'current-password' }),
      h('div', { class: 'modal__actions' }, h('button', { class: 'btn btn--ghost', type: 'button', text: 'Отмена', onclick: () => m.close() }), h('button', { class: 'btn btn--danger', type: 'submit', text: 'Удалить навсегда' }))
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

  function safeJSON(s) {
    try {
      return JSON.parse(s);
    } catch (e) {
      return null;
    }
  }

  boot();
})();
