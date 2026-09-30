/*
 * Чат (Frame 5 / Frame 6). Монтируется в .panel__main.
 *   const destroy = Chat.mount(mainEl, { conversationId, me, onBack });
 */
(function () {
  'use strict';
  const { h, icon, clear } = UI;
  const PAGE = 40;
  const GROUP_GAP = 5 * 60 * 1000;
  const coarse = window.matchMedia('(pointer: coarse)').matches;

  function mount(main, { conversationId, me, onBack }) {
    let conversation = null;
    let messages = []; // с сервера, по возрастанию времени
    let local = []; // отправляемые / неотправленные
    let hasMore = false;
    let loadingOlder = false;
    let destroyed = false;
    let unseen = 0;
    const isAdmin = me.role === 'admin';
    const draftKey = 'lwl.draft.' + conversationId;

    /* ------------------------------------------------------------- разметка */
    const title = h('h1', { class: 'panel__title', text: ' ' });
    const subtitle = h('p', { class: 'panel__subtitle', text: ' ' });
    const actions = h('div', { class: 'panel__head-actions' });
    const head = h(
      'header',
      { class: 'panel__head' },
      h('button', { class: 'icon-btn panel__head-back', type: 'button', 'aria-label': 'Назад', onclick: onBack }, icon('back')),
      h('div', { class: 'panel__head-text' }, title, subtitle),
      actions
    );
    const list = h('div', { class: 'chat__list', role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-label': 'Сообщения' });
    const scroller = h('div', { class: 'chat__scroller', tabindex: '0' }, list);
    const jump = h('button', { class: 'chat__jump', type: 'button', hidden: true, onclick: () => scrollToBottom(true) }, icon('arrowDown'), h('span'));
    const banner = h('div', { class: 'chat__banner', hidden: true });
    const input = h('textarea', {
      class: 'composer__input',
      rows: '1',
      placeholder: 'Сообщение',
      'aria-label': 'Сообщение',
      maxlength: String(Api.LIMITS.message.max + 200),
    });
    const counter = h('span', { class: 'composer__counter', hidden: true, 'aria-live': 'polite' });
    const sendBtn = h('button', { class: 'btn composer__send', type: 'submit', 'aria-label': 'Отправить' }, h('span', { text: 'Отправить' }), icon('send'));
    const composer = h('form', { class: 'composer', novalidate: true }, input, counter, sendBtn);

    clear(main).append(head, banner, scroller, jump, composer);
    main.style.position = 'relative';

    input.value = safe(() => sessionStorage.getItem(draftKey)) || '';
    autosize();
    updateComposer();

    /* ---------------------------------------------------------- загрузка */
    showSkeleton();
    load();

    async function load() {
      try {
        const [conv, page] = await Promise.all([Api.chats.get(conversationId), Api.chats.messages(conversationId, { limit: PAGE })]);
        if (destroyed) return;
        conversation = conv;
        messages = page.items;
        hasMore = page.hasMore;
        renderHead();
        render({ stick: true });
        markRead();
        if (!coarse) input.focus({ preventScroll: true });
      } catch (err) {
        if (destroyed) return;
        showError(err);
      }
    }

    async function refresh() {
      if (destroyed || !conversation) return;
      try {
        const [conv, page] = await Promise.all([Api.chats.get(conversationId), Api.chats.messages(conversationId, { limit: PAGE })]);
        if (destroyed) return;
        conversation = conv;
        renderHead();
        const known = new Set(messages.map((m) => m.id));
        const fresh = page.items.filter((m) => !known.has(m.id));
        if (!fresh.length) return;
        const atBottom = isAtBottom();
        messages = messages.concat(fresh).sort((a, b) => a.createdAt - b.createdAt);
        // пришедшие с сервера копии наших «отправляемых» сообщений
        const confirmed = new Set(fresh.map((m) => m.clientId).filter(Boolean));
        local = local.filter((m) => !confirmed.has(m.clientId));
        const incoming = fresh.filter((m) => m.authorId !== me.id).length;
        render({ stick: atBottom });
        if (atBottom) markRead();
        else if (incoming) {
          unseen += incoming;
          showJump();
        }
      } catch (e) {
        /* тихо: следующий опрос попробует снова */
      }
    }

    async function loadOlder() {
      if (loadingOlder || !hasMore || !messages.length) return;
      loadingOlder = true;
      const btn = list.querySelector('.chat__more');
      if (btn) btn.textContent = 'Загружаем…';
      try {
        const page = await Api.chats.messages(conversationId, { before: messages[0].createdAt, limit: PAGE });
        if (destroyed) return;
        const fromBottom = scroller.scrollHeight - scroller.scrollTop;
        const known = new Set(messages.map((m) => m.id));
        messages = page.items.filter((m) => !known.has(m.id)).concat(messages);
        hasMore = page.hasMore;
        render({ stick: false });
        scroller.scrollTop = scroller.scrollHeight - fromBottom;
      } catch (err) {
        UI.toast(err.message, { type: 'error' });
        if (btn) btn.textContent = 'Показать более ранние';
      } finally {
        loadingOlder = false;
      }
    }

    const unsubscribe = Api.chats.subscribe(conversationId, refresh);

    /* ------------------------------------------------------------ шапка */
    function renderHead() {
      const partner = conversation.partner;
      if (partner) {
        title.textContent = partner.nickname;
        subtitle.textContent = UI.presenceText(partner);
      } else if (isAdmin) {
        title.textContent = 'Удалённый аккаунт';
        subtitle.textContent = '';
      } else {
        title.textContent = 'Тех поддержка';
        subtitle.textContent = 'Администраторы ответят здесь';
      }
      document.title = `${title.textContent} — LWL`;

      clear(actions);
      if (isAdmin && conversation.player && conversation.player.id !== me.id) {
        const closed = conversation.status === 'closed';
        actions.append(
          h('button', {
            class: 'btn btn--ghost',
            type: 'button',
            text: closed ? 'Открыть снова' : 'Закрыть обращение',
            onclick: (e) => toggleStatus(e.currentTarget, closed),
          })
        );
      }
      const closed = conversation.status === 'closed';
      banner.hidden = !closed;
      if (closed) {
        clear(banner).append(
          h('span', { text: isAdmin ? 'Обращение закрыто. Игрок может написать снова — тогда оно откроется.' : 'Обращение закрыто. Если вопрос остался — просто напишите, и мы откроем его снова.' })
        );
      }
    }

    async function toggleStatus(btn, reopen) {
      UI.setLoading(btn, true);
      try {
        await (reopen ? Api.chats.reopen(conversationId) : Api.chats.close(conversationId));
        UI.toast(reopen ? 'Обращение снова открыто.' : 'Обращение закрыто.', { type: 'success' });
        await refresh();
        conversation.status = reopen ? 'open' : 'closed';
        renderHead();
      } catch (err) {
        UI.toast(err.message, { type: 'error' });
        UI.setLoading(btn, false);
      }
    }

    /* ---------------------------------------------------------- отрисовка */
    function showSkeleton() {
      clear(list).append(h('div', { class: 'skeleton-chat', 'aria-hidden': 'true' }, [1, 2, 3, 4, 5].map(() => h('div', { class: 'skeleton' }))));
      list.setAttribute('aria-busy', 'true');
    }

    function showError(err) {
      list.removeAttribute('aria-busy');
      clear(list).append(
        h(
          'div',
          { class: 'state state--error' },
          h('div', { class: 'state__icon' }, icon('alert')),
          h('p', { class: 'state__title', text: 'Не удалось открыть чат' }),
          h('p', { class: 'state__text', text: err.message }),
          h('button', {
            class: 'btn',
            type: 'button',
            text: 'Повторить',
            onclick: () => {
              showSkeleton();
              load();
            },
          })
        )
      );
      title.textContent = 'Чат';
      subtitle.textContent = '';
    }

    function render({ stick }) {
      list.removeAttribute('aria-busy');
      const all = messages.concat(local).sort((a, b) => a.createdAt - b.createdAt);
      const frag = document.createDocumentFragment();

      if (!all.length) {
        frag.append(emptyState());
        clear(list).append(frag);
        return;
      }
      if (hasMore) frag.append(h('button', { class: 'chat__more', type: 'button', text: 'Показать более ранние', onclick: loadOlder }));

      let lastDay = '';
      all.forEach((m, i) => {
        const day = UI.dayLabel(m.createdAt);
        if (day !== lastDay) {
          frag.append(h('div', { class: 'chat__day', text: day }));
          lastDay = day;
        }
        if (m.system) {
          frag.append(h('div', { class: 'msg--system', role: 'note', text: m.text }));
          return;
        }
        const prev = all[i - 1];
        const next = all[i + 1];
        const same = (a, b) => a && b && !a.system && !b.system && a.authorId === b.authorId && Math.abs(a.createdAt - b.createdAt) < GROUP_GAP && UI.dayLabel(a.createdAt) === UI.dayLabel(b.createdAt);
        frag.append(message(m, !same(prev, m), !same(m, next)));
      });
      clear(list).append(frag);
      if (stick) scrollToBottom(false);
    }

    function emptyState() {
      return h(
        'div',
        { class: 'state' },
        h('div', { class: 'state__icon' }, h('img', { src: 'assets/img/logo.svg', alt: '', width: '72', height: '72' })),
        h('p', { class: 'state__title', text: isAdmin ? 'Сообщений пока нет' : 'Здесь пока пусто' }),
        h('p', {
          class: 'state__text',
          text: isAdmin ? 'Напишите игроку первым — он увидит сообщение в кабинете.' : 'Опишите вопрос или проблему: ник, что случилось и когда. Администратор ответит прямо в этом чате.',
        })
      );
    }

    function message(m, first, last) {
      const mine = m.authorId === me.id;
      const cls = ['msg', mine && 'msg--mine', first && 'msg--first', last && 'msg--last', m.pending && 'msg--pending', m.failed && 'msg--failed'].filter(Boolean).join(' ');
      const status = mine ? (m.failed ? icon('alert') : m.pending ? icon('clock') : icon('check')) : null;
      const meta = h('span', { class: 'msg__meta', title: UI.fullDate(m.createdAt) }, UI.time(m.createdAt), status);
      const bubble = h('div', { class: 'msg__bubble' }, UI.linkify(m.text), meta);
      const authorName = m.author ? m.author.nickname : 'Удалённый аккаунт';
      const body = h(
        'div',
        { class: 'msg__body' },
        !mine && first && h('div', { class: 'msg__author', text: authorName + (m.author && m.author.role === 'admin' && !isAdmin ? ' · администратор' : '') }),
        h('span', { class: 'visually-hidden', text: mine ? 'Вы: ' : authorName + ': ' }),
        bubble
      );
      if (m.failed) {
        body.append(
          h(
            'div',
            { class: 'msg__retry' },
            h('span', { text: 'Не отправлено' }),
            h('button', { type: 'button', text: 'Повторить', onclick: () => retry(m) }),
            h('button', { type: 'button', text: 'Удалить', onclick: () => discard(m) })
          )
        );
      }
      return h('div', { class: cls, dataset: { id: m.id || m.clientId } }, !mine && h('div', { class: 'msg__avatar' }, UI.avatar(m.author, 36)), body);
    }

    /* ---------------------------------------------------------- прокрутка */
    function isAtBottom() {
      return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
    }

    function scrollToBottom(smooth) {
      requestAnimationFrame(() => {
        scroller.scrollTo({ top: scroller.scrollHeight, behavior: smooth ? 'smooth' : 'auto' });
      });
      unseen = 0;
      jump.hidden = true;
      markRead();
    }

    function showJump() {
      jump.hidden = false;
      jump.querySelector('span').textContent = unseen > 0 ? `${unseen} ${UI.plural(unseen, 'новое сообщение', 'новых сообщения', 'новых сообщений')}` : 'Вниз';
    }

    scroller.addEventListener(
      'scroll',
      () => {
        if (scroller.scrollTop < 60) loadOlder();
        if (isAtBottom()) {
          if (unseen) markRead();
          unseen = 0;
          jump.hidden = true;
        } else if (scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight > 400) {
          showJump();
        }
      },
      { passive: true }
    );

    let readTimer = null;
    function markRead() {
      clearTimeout(readTimer);
      readTimer = setTimeout(() => document.visibilityState === 'visible' && Api.chats.markRead(conversationId), 300);
    }
    const onVisible = () => document.visibilityState === 'visible' && isAtBottom() && markRead();
    document.addEventListener('visibilitychange', onVisible);

    /* ------------------------------------------------------------ отправка */
    function autosize() {
      input.style.height = 'auto';
      const max = parseInt(getComputedStyle(input).maxHeight, 10) || 220;
      const min = parseInt(getComputedStyle(input).minHeight, 10) || 0;
      input.style.height = Math.max(min, Math.min(max, input.scrollHeight)) + 'px';
    }

    function updateComposer() {
      const max = Api.LIMITS.message.max;
      // Пустое поле кнопку не гасит (как в макете) — отправка просто ничего не делает.
      sendBtn.disabled = input.value.length > max;
      counter.hidden = input.value.length < max * 0.8;
      counter.textContent = `${input.value.length} / ${max}`;
      counter.classList.toggle('is-over', input.value.length > max);
    }

    input.addEventListener('input', () => {
      autosize();
      updateComposer();
      safe(() => (input.value ? sessionStorage.setItem(draftKey, input.value) : sessionStorage.removeItem(draftKey)));
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !coarse) {
        e.preventDefault();
        composer.requestSubmit();
      }
    });

    composer.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = input.value.trim();
      const err = Api.validate.message(text);
      if (err) {
        if (text) UI.toast(err, { type: 'error' });
        return;
      }
      input.value = '';
      safe(() => sessionStorage.removeItem(draftKey));
      autosize();
      updateComposer();
      input.focus();
      const m = { clientId: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7), text, createdAt: Date.now(), authorId: me.id, author: me, pending: true };
      local.push(m);
      render({ stick: true });
      deliver(m);
    });

    async function deliver(m) {
      m.pending = true;
      m.failed = false;
      try {
        const saved = await Api.chats.send(conversationId, { text: m.text, clientId: m.clientId });
        if (destroyed) return;
        local = local.filter((x) => x !== m);
        if (!messages.some((x) => x.id === saved.id)) messages.push(saved);
        messages.sort((a, b) => a.createdAt - b.createdAt);
        await refresh(); // подтянуть ответ системы и статус обращения
        render({ stick: true });
      } catch (err) {
        if (destroyed) return;
        m.pending = false;
        m.failed = true;
        render({ stick: isAtBottom() });
        UI.toast(err.message || 'Сообщение не отправлено.', { type: 'error' });
      }
    }

    function retry(m) {
      render({ stick: true });
      deliver(m);
    }

    function discard(m) {
      local = local.filter((x) => x !== m);
      if (!input.value) {
        input.value = m.text;
        autosize();
        updateComposer();
      }
      render({ stick: false });
    }

    return function destroy() {
      destroyed = true;
      unsubscribe();
      clearTimeout(readTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }

  function safe(fn) {
    try {
      return fn();
    } catch (e) {
      return null;
    }
  }

  window.Chat = { mount };
})();
