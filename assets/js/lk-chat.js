/*
 * Чат с поддержкой. Монтируется в любой контейнер (он получает класс .chat).
 *   const destroy = Chat.mount(el, { conversationId, me, onBack });
 * Свои сообщения: часы — отправляется, одна галочка — доставлено, две — собеседник прочитал
 * (conversation.peerReadAt: для игрока — любой админ, для админа — игрок).
 *
 * Фото и файлы: скрепка, вставка из буфера (Ctrl+V) или перетаскивание в окно чата → полоска выбранных
 * файлов над полем ввода → каждый файл уходит отдельным сообщением (текст поля — подпись к первому),
 * по одному и по порядку, с прогрессом; не ушёл — «Повторить». Картинка в ленте — превью
 * (место под неё оставлено заранее, лента не прыгает), по клику — крупно; файл — карточка «Скачать».
 */
(function () {
  'use strict';
  const { h, icon, clear } = UI;
  const PAGE = 40;
  const GROUP_GAP = 5 * 60 * 1000;
  const MAX_FILES = 10; // за одну отправку
  const PREVIEW_TYPES = /^image\/(png|jpeg|gif|webp)$/; // у таких до отправки показываем превью
  const coarse = window.matchMedia('(pointer: coarse)').matches;

  function mount(main, { conversationId, me, onBack }) {
    let conversation = null;
    let messages = []; // с сервера, по возрастанию времени
    let local = []; // отправляемые / неотправленные — всегда внизу ленты, в порядке отправки
    let hasMore = false;
    let loadingOlder = false;
    let destroyed = false;
    let unseen = 0;
    let peerReadAt = 0;
    let maxFileBytes = 25 * 1024 * 1024; // точное значение приходит с обращением (LWL_CHAT_MAX_FILE_MB)
    let picked = []; // выбранные, ещё не отправленные файлы: { file, kind, url, width, height, ready }
    let sendChain = Promise.resolve(); // сообщения уходят по одному — в том порядке, в каком их отправили
    const ownPhotos = new Map(); // id вложения → blob:-ссылка своей картинки (после отправки не качаем её заново)
    const imgNodes = new Map(); // id вложения → <img>: при перерисовке ленты картинки не мигают
    // Сторона поддержки — админ в чужом обращении (своё обращение админ видит как игрок).
    const isAdmin = me.role === 'admin';
    const canDelete = isAdmin && (me.permissions || []).includes('delete');
    const draftKey = 'lwl.draft.' + conversationId;

    /* ------------------------------------------------------------- разметка */
    const headAvatar = h('div', { class: 'chat__avatar', 'aria-hidden': 'true' });
    const title = h('h2', { class: 'chat__title', text: ' ' });
    const subtitle = h('p', { class: 'chat__subtitle', text: ' ' });
    const actions = h('div', { class: 'chat__actions' });
    const head = h(
      'header',
      { class: 'chat__head' },
      h('button', { class: 'icon-btn chat__back', type: 'button', 'aria-label': 'Назад', onclick: onBack }, icon('back')),
      headAvatar,
      h('div', { class: 'chat__head-text' }, title, subtitle),
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
    const sendBtn = h('button', { class: 'btn composer__send', type: 'submit', 'aria-label': 'Отправить', title: 'Отправить' }, icon('send'));
    const fileInput = h('input', { class: 'composer__file', type: 'file', multiple: true, hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
    const attachBtn = h(
      'button',
      { class: 'icon-btn composer__attach', type: 'button', 'aria-label': 'Прикрепить фото или файл', title: 'Прикрепить фото или файл', onclick: () => fileInput.click() },
      icon('paperclip')
    );
    const tray = h('div', { class: 'composer__files', hidden: true, role: 'list', 'aria-label': 'Файлы к отправке' });
    const composer = h('form', { class: 'composer', novalidate: true }, tray, h('div', { class: 'composer__row' }, attachBtn, input, counter, sendBtn), fileInput);
    const dropText = h('p', { class: 'chat__drop-text' });
    const dropHint = h(
      'div',
      { class: 'chat__drop', hidden: true, 'aria-hidden': 'true' },
      h('div', { class: 'chat__drop-box' }, icon('paperclip'), h('p', { class: 'chat__drop-title', text: 'Отпустите, чтобы прикрепить' }), dropText)
    );

    main.classList.add('chat');
    clear(main).append(head, banner, scroller, jump, composer, dropHint);

    input.value = safe(() => sessionStorage.getItem(draftKey)) || '';
    autosize();
    updateComposer();
    updateLimitText();

    /* ---------------------------------------------------------- загрузка */
    showSkeleton();
    load();

    async function load() {
      try {
        const [conv, page] = await Promise.all([Api.chats.get(conversationId), Api.chats.messages(conversationId, { limit: PAGE })]);
        if (destroyed) return;
        conversation = conv;
        peerReadAt = conv.peerReadAt || 0;
        if (conv.maxFileBytes) maxFileBytes = conv.maxFileBytes;
        updateLimitText();
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
        const readChanged = (conv.peerReadAt || 0) !== peerReadAt;
        peerReadAt = conv.peerReadAt || 0;
        const known = new Set(messages.map((m) => m.id));
        const fresh = page.items.filter((m) => !known.has(m.id));
        if (!fresh.length) {
          // Собеседник прочитал — перерисовываем галочки, не сдвигая ленту.
          if (readChanged) render({ stick: isAtBottom() });
          return;
        }
        const atBottom = isAtBottom();
        messages = messages.concat(fresh).sort((a, b) => a.createdAt - b.createdAt);
        // пришедшие с сервера копии наших «отправляемых» сообщений
        const confirmed = new Map(fresh.filter((m) => m.clientId && m.authorId === me.id).map((m) => [m.clientId, m]));
        local.filter((m) => confirmed.has(m.clientId)).forEach((m) => adopt(m, confirmed.get(m.clientId)));
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
    let renderedStatus = null;
    function renderHead() {
      const partner = conversation.partner;
      clear(headAvatar).append(partner ? UI.avatar(partner, 44) : h('img', { src: 'assets/img/logo.svg', alt: '', width: '44', height: '44' }));
      headAvatar.classList.toggle('chat__avatar--brand', !partner);
      if (partner) {
        title.textContent = partner.nickname;
        subtitle.textContent = UI.presenceText(partner);
      } else if (isAdmin) {
        title.textContent = 'Удалённый аккаунт';
        subtitle.textContent = '';
      } else {
        title.textContent = 'Администрация LWL';
        subtitle.textContent = 'Ответим в этом чате';
      }
      subtitle.classList.toggle('is-online', !!(partner && partner.online));
      document.title = partner ? `${partner.nickname} — LWL` : 'Тех поддержка — LWL';

      if (renderedStatus === conversation.status) return;
      renderedStatus = conversation.status;
      clear(actions);
      if (isAdmin && conversation.player && conversation.player.id !== me.id) {
        const closed = conversation.status === 'closed';
        actions.append(
          h('button', {
            class: 'btn btn--sm btn--secondary',
            type: 'button',
            text: closed ? 'Открыть снова' : 'Закрыть обращение',
            onclick: (e) => toggleStatus(e.currentTarget, closed),
          })
        );
        if (canDelete) actions.append(h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Удалить обращение', title: 'Удалить обращение', onclick: removeConversation }, icon('trash')));
      } else if (isAdmin && !conversation.player && canDelete) {
        actions.append(h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Удалить обращение', title: 'Удалить обращение', onclick: removeConversation }, icon('trash')));
      }
      const closed = conversation.status === 'closed';
      banner.hidden = !closed;
      if (closed) {
        clear(banner).append(
          h('span', { text: isAdmin ? 'Обращение закрыто. Игрок может написать снова — тогда оно откроется.' : 'Обращение закрыто. Если вопрос остался — просто напишите, и мы откроем его снова.' })
        );
      }
    }

    async function removeConversation() {
      const who = conversation.player ? conversation.player.nickname : 'удалённого аккаунта';
      const ok = await UI.confirm({ title: `Удалить обращение ${who}?`, text: 'Переписка, фото и файлы удалятся насовсем. Если игрок напишет снова, начнётся новое обращение.', confirmText: 'Удалить', danger: true });
      if (!ok) return;
      try {
        await Api.chats.remove(conversationId);
        UI.toast('Обращение удалено.');
        onBack();
      } catch (err) {
        UI.toast(err.message, { type: 'error' });
      }
    }

    async function toggleStatus(btn, reopen) {
      UI.setLoading(btn, true);
      try {
        await (reopen ? Api.chats.reopen(conversationId) : Api.chats.close(conversationId));
        UI.toast(reopen ? 'Обращение снова открыто.' : 'Обращение закрыто.', { type: 'success' });
        await refresh();
        conversation.status = reopen ? 'open' : 'closed';
        renderedStatus = null;
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
      // Неотправленные — после всех пришедших с сервера: так файлы, уходящие по одному, не перемешиваются.
      const all = messages.concat(local);
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
          text: isAdmin
            ? 'Напишите игроку первым — он увидит сообщение в кабинете.'
            : 'Опишите вопрос или проблему: ник, что случилось и когда. Можно приложить скриншот — скрепкой, Ctrl+V или перетащив файл сюда.',
        })
      );
    }

    function message(m, first, last) {
      const mine = m.authorId === me.id;
      const read = mine && m.id && m.createdAt <= peerReadAt;
      const atts = m.attachments || [];
      const photoOnly = atts.length > 0 && !m.text && atts.every((a) => a.kind === 'image');
      const cls = ['msg', mine && 'msg--mine', first && 'msg--first', last && 'msg--last', m.pending && 'msg--pending', m.failed && 'msg--failed', read && 'msg--read'].filter(Boolean).join(' ');
      const status = mine ? (m.failed ? icon('alert') : m.pending ? icon('clock') : read ? icon('checks') : icon('check')) : null;
      const state = mine ? (m.failed ? 'не отправлено' : m.pending ? 'отправляется' : read ? 'прочитано' : 'доставлено') : '';
      const meta = h('span', { class: 'msg__meta', title: UI.fullDate(m.createdAt) + (state ? ' · ' + state : '') }, UI.time(m.createdAt), status, state && h('span', { class: 'visually-hidden', text: ', ' + state }));
      const bubble = atts.length
        ? h(
            'div',
            { class: 'msg__bubble msg__bubble--media' + (photoOnly ? ' msg__bubble--photo' : '') },
            atts.map((a) => (a.kind === 'image' ? photo(a, m) : fileCard(a, m))),
            photoOnly ? meta : h('div', { class: 'msg__caption' }, m.text && UI.linkify(m.text), meta)
          )
        : h('div', { class: 'msg__bubble' }, UI.linkify(m.text), meta);
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
            h('span', { text: m.upload ? 'Файл не отправлен' : 'Не отправлено' }),
            h('button', { type: 'button', text: 'Повторить', onclick: () => retry(m) }),
            h('button', { type: 'button', text: 'Удалить', onclick: () => discard(m) })
          )
        );
      }
      return h('div', { class: cls, dataset: { id: m.id || m.clientId } }, !mine && h('div', { class: 'msg__avatar' }, UI.avatar(m.author, 36)), body);
    }

    /** Картинка в ленте: место под неё оставлено по ширине и высоте, по клику — крупно. */
    function photo(a, m) {
      const key = a.id || 'local:' + m.clientId;
      let img = imgNodes.get(key);
      if (!img) {
        img = h('img', { class: 'att-photo__img', src: a.local ? a.url : ownPhotos.get(a.id) || a.url, alt: '', decoding: 'async', loading: a.local ? null : 'lazy' });
        imgNodes.set(key, img);
      }
      const frame = a.local
        ? h('div', { class: 'att-photo' }, img, progress(m))
        : h('a', { class: 'att-photo', href: a.url, target: '_blank', rel: 'noopener', 'aria-label': `Фото «${a.name}» — открыть крупно`, onclick: (e) => openPhoto(e, a) }, img);
      sizePhoto(frame, img, a.width, a.height);
      return frame;
    }

    function sizePhoto(frame, img, w, ht) {
      const set = (width, height) => {
        // Очень высокие и очень широкие картинки чуть обрезаются по краям — иначе превью вышло бы полоской.
        frame.style.setProperty('--ar', String(Math.min(Math.max(width / height, 0.6), 2.4)));
        frame.style.setProperty('--w', width + 'px');
      };
      if (w && ht) return set(w, ht);
      // Размер неизвестен (редкий JPEG): пока 4:3, а когда фото загрузится — подгоняем, не теряя низ ленты.
      if (img.complete && img.naturalWidth) return set(img.naturalWidth, img.naturalHeight);
      img.addEventListener(
        'load',
        () => {
          const stick = isAtBottom();
          set(img.naturalWidth, img.naturalHeight);
          if (stick) scrollToBottom(false);
        },
        { once: true }
      );
    }

    function openPhoto(e, a) {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return; // в новой вкладке — как обычно
      e.preventDefault();
      UI.lightbox({ src: ownPhotos.get(a.id) || a.url, name: a.name, href: a.url, meta: UI.fileSize(a.size) });
    }

    /** Файл в ленте: значок с расширением, имя, размер и «Скачать» (вся карточка — ссылка). */
    function fileCard(a, m) {
      const sending = a.local && m.pending;
      const text = h(
        'span',
        { class: 'att-file__text' },
        h('span', { class: 'att-file__name', text: a.name }),
        h('span', { class: 'att-file__size' }, UI.fileSize(a.size), sending ? ' · отправляется' : !a.local && [' · ', h('span', { class: 'att-file__dl', text: 'Скачать' })])
      );
      const badge = fileBadge(a.name, a.local && progress(m));
      if (a.local) return h('div', { class: 'att-file' }, badge, text);
      return h('a', { class: 'att-file', href: a.url, download: a.name, title: `Скачать «${a.name}»` }, badge, text, h('span', { class: 'att-file__icon' }, icon('download')));
    }

    /** Кружок прогресса поверх превью или значка файла; у неотправленного — значок ошибки. */
    function progress(m) {
      if (m.failed) return h('span', { class: 'att-progress att-progress--failed' }, icon('alert'));
      if (!m.pending) return null;
      const pct = Math.round((m.progress || 0) * 100);
      const label = h('span', { class: 'att-progress__text', text: pct + '%' });
      const ring = h('span', { class: 'att-progress', role: 'progressbar', 'aria-label': 'Отправка файла', 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': String(pct) }, label);
      ring.style.setProperty('--p', String(pct));
      m.progressEl = ring;
      m.progressText = label;
      return ring;
    }

    function setProgress(m, f) {
      m.progress = f;
      const pct = Math.round(f * 100);
      if (m.progressEl) {
        m.progressEl.style.setProperty('--p', String(pct));
        m.progressEl.setAttribute('aria-valuenow', String(pct));
      }
      if (m.progressText) m.progressText.textContent = pct + '%';
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

    /* ------------------------------------------------------------ поле ввода */
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
      input.placeholder = picked.length ? (picked.length > 1 ? 'Подпись к первому файлу' : 'Подпись') : 'Сообщение';
    }

    function updateLimitText() {
      dropText.textContent = `Фото и любые файлы до ${UI.fileSize(maxFileBytes)}`;
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

    /* ------------------------------------------------------- выбор файлов */
    fileInput.addEventListener('change', () => {
      const files = [...fileInput.files];
      fileInput.value = ''; // чтобы тот же файл можно было выбрать снова
      addFiles(files);
    });

    // Вставка из буфера: скриншот (Win+Shift+S, PrtSc) или скопированный файл.
    function onPaste(e) {
      const t = e.target;
      if (destroyed || !(t === document.body || t === document.documentElement || main.contains(t))) return;
      const files = filesFrom(e.clipboardData);
      if (!files.length) return;
      // Если в буфере только картинка, в поле ничего не вставляем; если и текст — пусть вставится.
      if (![...e.clipboardData.types].includes('text/plain')) e.preventDefault();
      addFiles(files.map(namePasted));
    }
    document.addEventListener('paste', onPaste);

    // Перетаскивание файлов в окно чата. Мимо чата файл тоже не откроется вместо страницы.
    let dragDepth = 0;
    const hasFiles = (e) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');
    const showDrop = (on) => {
      dropHint.hidden = !on;
      main.classList.toggle('is-dragover', on);
    };
    main.addEventListener('dragenter', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      showDrop(true);
    });
    main.addEventListener('dragover', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    main.addEventListener('dragleave', (e) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (!dragDepth) showDrop(false);
    });
    main.addEventListener('drop', (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      e.stopPropagation();
      dragDepth = 0;
      showDrop(false);
      addFiles([...e.dataTransfer.files]);
    });
    const blockStrayDrop = (e) => hasFiles(e) && e.preventDefault();
    document.addEventListener('dragover', blockStrayDrop);
    document.addEventListener('drop', blockStrayDrop);

    function filesFrom(dt) {
      if (!dt) return [];
      if (dt.files && dt.files.length) return [...dt.files];
      return [...(dt.items || [])]
        .filter((i) => i.kind === 'file')
        .map((i) => i.getAsFile())
        .filter(Boolean);
    }

    /** Скриншот из буфера называется «image.png» — даём имя с датой, чтобы в переписке их можно было различить. */
    function namePasted(file) {
      if (file.name && !/^image\.\w+$/i.test(file.name)) return file;
      const ext = (/^image\/(\w+)/.exec(file.type) || [])[1] || 'png';
      const d = new Date();
      const p2 = (n) => String(n).padStart(2, '0');
      const name = `Снимок ${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}.${p2(d.getMinutes())}.${p2(d.getSeconds())}.${ext === 'jpeg' ? 'jpg' : ext}`;
      try {
        return new File([file], name, { type: file.type, lastModified: file.lastModified });
      } catch (e) {
        return file;
      }
    }

    function addFiles(files) {
      if (!files.length) return;
      const room = MAX_FILES - picked.length;
      if (files.length > room) UI.toast(`За один раз — не больше ${MAX_FILES} файлов. ${room > 0 ? 'Лишние не добавлены.' : 'Сначала отправьте выбранные.'}`, { type: 'error' });
      let added = 0;
      for (const file of files.slice(0, Math.max(room, 0))) {
        const name = file.name || 'файл';
        if (!file.size) {
          UI.toast(`«${name}» — пустой файл или папка. Такой не отправить.`, { type: 'error' });
          continue;
        }
        if (file.size > maxFileBytes) {
          UI.toast(`«${name}» больше ${UI.fileSize(maxFileBytes)} — такой файл не отправить.`, { type: 'error' });
          continue;
        }
        const item = { file, kind: 'file', url: null, width: null, height: null, ready: null };
        item.ready = PREVIEW_TYPES.test(file.type) ? loadPreview(item) : Promise.resolve();
        picked.push(item);
        added++;
      }
      if (!added) return;
      renderTray();
      updateComposer();
      if (!coarse) input.focus({ preventScroll: true });
    }

    /** Превью картинки до отправки (и её размер — чтобы в ленте сразу оставить место). */
    function loadPreview(item) {
      return new Promise((resolve) => {
        const url = URL.createObjectURL(item.file);
        const img = new Image();
        img.onload = () => {
          Object.assign(item, { kind: 'image', url, width: img.naturalWidth, height: img.naturalHeight });
          if (picked.includes(item)) renderTray();
          resolve();
        };
        img.onerror = () => {
          URL.revokeObjectURL(url); // браузер не смог показать — отправим как файл
          resolve();
        };
        img.src = url;
      });
    }

    function unpick(item) {
      picked = picked.filter((x) => x !== item);
      if (item.url) URL.revokeObjectURL(item.url);
      renderTray();
      updateComposer();
      input.focus({ preventScroll: true });
    }

    function renderTray() {
      tray.hidden = !picked.length;
      main.classList.toggle('has-files', picked.length > 0);
      clear(tray).append(...picked.map(trayItem));
    }

    function trayItem(item) {
      const name = item.file.name || 'файл';
      const remove = h('button', { class: 'tray-item__remove', type: 'button', 'aria-label': `Убрать «${name}»`, title: 'Убрать', onclick: () => unpick(item) }, icon('close'));
      if (item.kind === 'image') {
        return h('div', { class: 'tray-item tray-item--image', role: 'listitem', title: `${name} · ${UI.fileSize(item.file.size)}` }, h('img', { class: 'tray-item__thumb', src: item.url, alt: name }), remove);
      }
      return h(
        'div',
        { class: 'tray-item', role: 'listitem', title: name },
        fileBadge(name),
        h('span', { class: 'tray-item__text' }, h('span', { class: 'tray-item__name', text: name }), h('span', { class: 'tray-item__size', text: UI.fileSize(item.file.size) })),
        remove
      );
    }

    /* ------------------------------------------------------------ отправка */
    const newClientId = () => 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

    function clearInput() {
      input.value = '';
      safe(() => sessionStorage.removeItem(draftKey));
      autosize();
      updateComposer();
      input.focus();
    }

    composer.addEventListener('submit', async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (picked.length) return sendFiles(text);
      const err = Api.validate.message(text);
      if (err) {
        if (text) UI.toast(err, { type: 'error' });
        return;
      }
      clearInput();
      queue({ clientId: newClientId(), text, createdAt: Date.now(), authorId: me.id, author: me });
      render({ stick: true });
    });

    async function sendFiles(text) {
      const err = Api.validate.caption(text);
      if (err) return UI.toast(err, { type: 'error' });
      const items = picked;
      picked = [];
      renderTray();
      clearInput();
      await Promise.all(items.map((it) => it.ready)); // превью картинок (обычно уже готовы)
      if (destroyed) return;
      let caption = text;
      // Подпись идёт заголовком запроса; очень длинную отправляем обычным сообщением перед файлами.
      if (caption && encodeURIComponent(caption).length > Api.chats.CAPTION_HEADER_MAX) {
        queue({ clientId: newClientId(), text: caption, createdAt: Date.now(), authorId: me.id, author: me });
        caption = '';
      }
      items.forEach((item, i) => {
        const name = item.file.name || 'файл';
        queue({
          clientId: newClientId(),
          text: i === 0 ? caption : '',
          createdAt: Date.now(),
          authorId: me.id,
          author: me,
          upload: item,
          progress: 0,
          attachments: [{ id: null, local: true, name, size: item.file.size, kind: item.kind, url: item.url, width: item.width, height: item.height }],
        });
      });
      render({ stick: true });
    }

    /** В очередь отправки: сообщения уходят по одному, в порядке отправки. */
    function queue(m) {
      m.pending = true;
      m.failed = false;
      local.push(m);
      sendChain = sendChain.then(() => deliver(m));
    }

    async function deliver(m) {
      m.pending = true;
      m.failed = false;
      if (m.upload) setProgress(m, 0);
      try {
        const saved = m.upload
          ? await Api.chats.attach(conversationId, m.upload.file, { clientId: m.clientId, caption: m.text, onProgress: (f) => setProgress(m, f) })
          : await Api.chats.send(conversationId, { text: m.text, clientId: m.clientId });
        adopt(m, saved);
        if (destroyed) return;
        if (!messages.some((x) => x.id === saved.id)) messages.push(saved);
        messages.sort((a, b) => a.createdAt - b.createdAt);
        await refresh(); // подтянуть ответ системы и статус обращения
        render({ stick: true });
      } catch (err) {
        if (destroyed) return;
        m.pending = false;
        m.failed = true;
        render({ stick: isAtBottom() });
        UI.toast(err.message || (m.upload ? 'Файл не отправлен.' : 'Сообщение не отправлено.'), { type: 'error' });
      }
    }

    /** Сервер принял наше сообщение: убрать «отправляемую» копию; своя картинка остаётся показанной из памяти. */
    function adopt(m, saved) {
      local = local.filter((x) => x !== m);
      if (!m.upload || !m.upload.url) return;
      const a = saved.attachments && saved.attachments[0];
      if (a && a.kind === 'image' && !destroyed) ownPhotos.set(a.id, m.upload.url);
      else URL.revokeObjectURL(m.upload.url);
    }

    function retry(m) {
      local = local.filter((x) => x !== m);
      queue(m);
      render({ stick: true });
    }

    function discard(m) {
      local = local.filter((x) => x !== m);
      if (m.upload && m.upload.url) URL.revokeObjectURL(m.upload.url);
      if (m.text && !input.value) {
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
      document.removeEventListener('paste', onPaste);
      document.removeEventListener('dragover', blockStrayDrop);
      document.removeEventListener('drop', blockStrayDrop);
      main.classList.remove('has-files', 'is-dragover');
      // Картинки, которые ещё отправляются, держат свой файл, а не ссылку — ссылки можно отпускать.
      picked.forEach((it) => it.url && URL.revokeObjectURL(it.url));
      ownPhotos.forEach((url) => URL.revokeObjectURL(url));
      local.forEach((m) => m.upload && m.upload.url && URL.revokeObjectURL(m.upload.url));
    };
  }

  /** Значок файла: расширение (ZIP, LOG, PDF…) или просто значок, если расширения нет. */
  function fileBadge(name, overlay) {
    const ext = (/\.([a-z0-9]{1,5})$/i.exec(name || '') || [])[1];
    if (overlay) return h('span', { class: 'file-badge' }, overlay); // во время отправки — только кружок прогресса
    return h('span', { class: 'file-badge', 'aria-hidden': 'true' }, ext ? h('span', { class: 'file-badge__ext', text: ext.toUpperCase() }) : icon('file'));
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
