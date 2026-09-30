/*
 * Общие помощники интерфейса. Пользовательские данные вставляются только как текст
 * (textContent), поэтому HTML из имён и сообщений не выполнится.
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------- DOM */

  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'text') el.textContent = v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    append(el, children);
    return el;
  }

  function append(el, children) {
    for (const c of children.flat(Infinity)) {
      if (c === undefined || c === null || c === false) continue;
      el.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return el;
  }

  function clear(el) {
    while (el.firstChild) el.removeChild(el.firstChild);
    return el;
  }

  /* ------------------------------------------------------------ иконки */

  const ICONS = {
    close: 'M6 6l12 12M18 6L6 18',
    copy: 'M9 9h11v11H9z|M15 5V4H4v11h1',
    eye: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z|C12 12 3',
    eyeOff: 'M3 3l18 18|M10.6 5.1A10.8 10.8 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.2M6.6 6.6C3.8 8.4 2 12 2 12s3.6 7 10 7a10 10 0 0 0 5.4-1.6|M9.9 9.9a3 3 0 0 0 4.2 4.2',
    alert: 'M12 8v5|M12 16.5v.5|C12 12 10',
    info: 'M12 11v6|M12 7.5v.5|C12 12 10',
    back: 'M15 5l-7 7 7 7',
    send: 'M4 12l16-8-6 16-3-7-7-1z',
    check: 'M5 12.5l4.5 4.5L19 7',
    checks: 'M2 12.5l4.5 4.5L16 7|M9 16.5l.5.5L22 7',
    clock: 'C12 12 9|M12 7v5l3 2',
    retry: 'M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5',
    search: 'C11 11 7|M16.5 16.5L21 21',
    user: 'C12 8 4|M4 21c1.5-4 4.5-6 8-6s6.5 2 8 6',
    upload: 'M12 16V4M7 9l5-5 5 5|M4 16v4h16v-4',
    trash: 'M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13',
    chat: 'M4 5h16v11H9l-5 4z',
    arrowDown: 'M12 5v14M6 13l6 6 6-6',
    arrowRight: 'M5 12h14M13 6l6 6-6 6',
    lock: 'M6 11h12v10H6z|M8 11V8a4 4 0 0 1 8 0v3',
    home: 'M3 11l9-7 9 7|M5 9.5V20h5v-6h4v6h5V9.5',
    file: 'M6 3h8l4 4v14H6z|M14 3v4h4|M9 12h6M9 16h6',
    logout: 'M14 4h5v16h-5|M10 12h10|M7 8l-4 4 4 4',
    external: 'M14 4h6v6|M20 4l-9 9|M18 14v6H4V6h6',
    chevronDown: 'M6 9l6 6 6-6',
    chevronRight: 'M9 6l6 6-6 6',
    inbox: 'M3 13l3-8h12l3 8v6H3z|M3 13h5l1 3h6l1-3h5',
    users: 'C9 8 3.5|M2.5 20c1-3.6 3.5-5.5 6.5-5.5s5.5 1.9 6.5 5.5|M16 4.6a3.5 3.5 0 0 1 0 6.8|M18.5 14.9c1.5.8 2.5 2.5 3 5.1',
    server: 'M4 4h16v6H4z|M4 14h16v6H4z|M8 7h.01|M8 17h.01',
    download: 'M12 4v12M7 11l5 5 5-5|M4 20h16',
    link: 'M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1|M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1',
    edit: 'M4 20h4L19 9l-4-4L4 16z|M13.5 6.5l4 4',
    eyeView: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z|C12 12 3',
  };

  function icon(name, size) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2.2');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('focusable', 'false');
    if (size) {
      svg.setAttribute('width', size);
      svg.setAttribute('height', size);
    }
    for (const part of (ICONS[name] || '').split('|')) {
      if (part.startsWith('C')) {
        const [cx, cy, r] = part.slice(1).trim().split(/\s+/);
        const c = document.createElementNS(NS, 'circle');
        c.setAttribute('cx', cx);
        c.setAttribute('cy', cy);
        c.setAttribute('r', r);
        svg.append(c);
      } else {
        const p = document.createElementNS(NS, 'path');
        p.setAttribute('d', part);
        svg.append(p);
      }
    }
    return svg;
  }

  /* --------------------------------------------------------- уведомления */

  function toast(message, opts = {}) {
    let box = document.querySelector('.toasts');
    if (!box) {
      box = h('div', { class: 'toasts', 'aria-live': 'polite' });
      document.body.append(box);
    }
    const type = opts.type || 'info';
    const el = h(
      'div',
      { class: `toast toast--${type}`, role: type === 'error' ? 'alert' : 'status' },
      h('div', { class: 'toast__body', text: message }),
      opts.action && h('button', { class: 'toast__action', type: 'button', text: opts.action.label, onclick: () => (opts.action.onClick(), close()) })
    );
    box.append(el);
    const timer = setTimeout(close, opts.timeout || (type === 'error' ? 7000 : 4000));
    function close() {
      clearTimeout(timer);
      el.classList.add('is-leaving');
      setTimeout(() => el.remove(), 200);
    }
    return close;
  }

  /* ----------------------------------------------------- модальные окна */

  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const openModals = [];
  const modalClosers = new Map();

  /** Закрыть все открытые окна (например, при переходе по ссылке сброса пароля). */
  function closeModals() {
    [...modalClosers.values()].forEach((close) => close());
  }

  /**
   * Открывает модальное окно. content — узел; возвращает { close, dialog }.
   * onClose вызывается при любом закрытии (крестик, Esc, фон, close()).
   */
  function modal({ title, content, size, onClose, labelledBy, closable = true }) {
    const previous = document.activeElement;
    const titleId = labelledBy || 'modal-title-' + Math.random().toString(36).slice(2, 8);
    const dialog = h(
      'div',
      { class: 'modal__dialog' + (size === 'sm' ? ' modal__dialog--sm' : ''), role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': titleId },
      closable && h('button', { class: 'modal__close', type: 'button', 'aria-label': 'Закрыть', onclick: () => close() }, icon('close')),
      title && h('h2', { class: 'modal__title', id: titleId, text: title }),
      content
    );
    const backdrop = h('div', { class: 'modal__backdrop' });
    const root = h('div', { class: 'modal' }, backdrop, dialog);
    if (closable) backdrop.addEventListener('click', () => close());
    document.body.append(root);
    document.body.classList.add('has-modal');
    openModals.push(root);
    modalClosers.set(root, () => close());

    let closed = false;
    function close(result) {
      if (closed) return;
      closed = true;
      modalClosers.delete(root);
      root.remove();
      openModals.splice(openModals.indexOf(root), 1);
      if (!openModals.length) document.body.classList.remove('has-modal');
      document.removeEventListener('keydown', onKey, true);
      if (previous && previous.focus && document.contains(previous)) previous.focus();
      if (onClose) onClose(result);
    }

    function onKey(e) {
      if (openModals[openModals.length - 1] !== root) return;
      if (e.key === 'Escape' && closable) {
        e.stopPropagation();
        close();
      } else if (e.key === 'Tab') {
        const items = Array.from(dialog.querySelectorAll(FOCUSABLE)).filter((x) => x.offsetParent !== null);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    }
    document.addEventListener('keydown', onKey, true);

    requestAnimationFrame(() => {
      const target = dialog.querySelector('[autofocus]') || dialog.querySelector('input, textarea, select') || dialog.querySelector(FOCUSABLE);
      if (target) target.focus();
    });
    return { close, dialog, root };
  }

  /** Подтверждение действия. Возвращает Promise<boolean>. */
  function confirmDialog({ title, text, confirmText = 'Подтвердить', cancelText = 'Отмена', danger = false }) {
    return new Promise((resolve) => {
      let result = false;
      const ok = h('button', { class: 'btn' + (danger ? ' btn--danger' : ''), type: 'button', text: confirmText, onclick: () => ((result = true), m.close()) });
      const content = h(
        'div',
        {},
        text && h('p', { class: 'modal__text', text }),
        h('div', { class: 'modal__actions' }, h('button', { class: 'btn btn--ghost', type: 'button', text: cancelText, autofocus: true, onclick: () => m.close() }), ok)
      );
      const m = modal({ title, content, size: 'sm', onClose: () => resolve(result) });
    });
  }

  /* --------------------------------------------------------------- формы */

  function fieldOf(form, name) {
    const input = form.elements[name];
    const el = input && (input.length && !input.tagName ? input[0] : input);
    return el ? el.closest('.field') : null;
  }

  function setFieldError(form, name, message) {
    const field = fieldOf(form, name);
    if (!field) return false;
    field.classList.toggle('has-error', !!message);
    const err = field.querySelector('.field__error');
    if (err) err.textContent = message || '';
    const input = form.elements[name];
    const control = input && (input.length && !input.tagName ? input[0] : input);
    if (control) control.setAttribute('aria-invalid', message ? 'true' : 'false');
    return true;
  }

  function clearErrors(form) {
    form.querySelectorAll('.field.has-error').forEach((f) => f.classList.remove('has-error'));
    form.querySelectorAll('.field__error').forEach((e) => (e.textContent = ''));
    form.querySelectorAll('[aria-invalid]').forEach((e) => e.setAttribute('aria-invalid', 'false'));
    const alert = form.querySelector('.form-alert');
    if (alert) alert.hidden = true;
  }

  /** Раскладывает ошибку API по полям формы; остальное — в общий блок .form-alert. */
  function showFormError(form, err) {
    let placed = false;
    let firstInvalid = null;
    if (err && err.fields) {
      for (const [name, msg] of Object.entries(err.fields)) {
        if (setFieldError(form, name, msg)) {
          placed = true;
          const c = form.elements[name];
          if (!firstInvalid && c) firstInvalid = c.length && !c.tagName ? c[0] : c;
        }
      }
    }
    const alert = form.querySelector('.form-alert');
    if (alert && (!placed || (err && err.code !== 'VALIDATION'))) {
      alert.hidden = false;
      clear(alert).append(icon('alert'), h('span', { text: (err && err.message) || 'Что-то пошло не так.' }));
    }
    if (firstInvalid) firstInvalid.focus();
    else if (alert && !alert.hidden) alert.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function field({ label, name, type = 'text', value = '', placeholder, autocomplete, hint, required, maxlength, textarea, options, inputmode, attrs }) {
    const id = 'f-' + name + '-' + Math.random().toString(36).slice(2, 7);
    const errId = id + '-err';
    let control;
    const common = { id, name, 'aria-describedby': errId + (hint ? ' ' + id + '-hint' : ''), autocomplete, required, maxlength, placeholder, inputmode };
    if (textarea) control = h('textarea', Object.assign({ class: 'textarea' }, common, attrs));
    else if (options) {
      control = h('select', Object.assign({ class: 'select' }, common, attrs), h('option', { value: '', text: 'Выберите…' }), options.map((o) => h('option', { value: o, text: o })));
    } else control = h('input', Object.assign({ class: 'input', type }, common, attrs));
    if (value !== undefined && value !== null) control.value = value;

    const controlWrap = h('div', { class: 'field__control' }, control);
    if (type === 'password') {
      control.classList.add('input--with-toggle');
      const toggle = h('button', { class: 'password-toggle', type: 'button', 'aria-label': 'Показать пароль', 'aria-pressed': 'false' }, icon('eye'));
      toggle.addEventListener('click', () => {
        const show = control.type === 'password';
        control.type = show ? 'text' : 'password';
        toggle.setAttribute('aria-pressed', String(show));
        toggle.setAttribute('aria-label', show ? 'Скрыть пароль' : 'Показать пароль');
        clear(toggle).append(icon(show ? 'eyeOff' : 'eye'));
        control.focus();
      });
      controlWrap.append(toggle);
    }
    const wrap = h(
      'div',
      { class: 'field' },
      h('label', { class: 'field__label', for: id, text: label }),
      controlWrap,
      hint && h('div', { class: 'field__hint', id: id + '-hint', text: hint }),
      h('div', { class: 'field__error', id: errId, 'aria-live': 'polite' })
    );
    control.addEventListener('input', () => {
      if (wrap.classList.contains('has-error')) {
        wrap.classList.remove('has-error');
        wrap.querySelector('.field__error').textContent = '';
        control.setAttribute('aria-invalid', 'false');
      }
    });
    return wrap;
  }

  function counter(control, max) {
    const el = h('span', { class: 'field__counter', 'aria-live': 'off' });
    const update = () => {
      const n = control.value.length;
      el.textContent = `${n} / ${max}`;
      el.classList.toggle('is-over', n > max);
    };
    control.addEventListener('input', update);
    update();
    return el;
  }

  function passwordStrength(pw) {
    if (!pw) return 0;
    let score = 0;
    if (pw.length >= 8) score++;
    if (pw.length >= 12) score++;
    if (/[a-zа-яё]/.test(pw) && /[A-ZА-ЯЁ]/.test(pw)) score++;
    if (/\d/.test(pw) && /[^A-Za-zА-Яа-яЁё0-9]/.test(pw)) score++;
    return Math.max(1, Math.min(4, score));
  }

  function setLoading(btn, loading) {
    if (!btn) return;
    btn.classList.toggle('is-loading', loading);
    btn.disabled = loading;
    btn.setAttribute('aria-busy', String(loading));
  }

  /* ------------------------------------------------------- форматирование */

  function plural(n, one, few, many) {
    const m10 = n % 10;
    const m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }

  const timeFmt = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
  const dateFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long' });
  const dateYearFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  const fullFmt = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });

  function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function dayLabel(ts) {
    const today = startOfDay(Date.now());
    const day = startOfDay(ts);
    if (day === today) return 'Сегодня';
    if (day === today - 86400000) return 'Вчера';
    return new Date(ts).getFullYear() === new Date().getFullYear() ? dateFmt.format(ts) : dateYearFmt.format(ts);
  }

  function shortTime(ts) {
    const day = startOfDay(ts);
    const today = startOfDay(Date.now());
    if (day === today) return timeFmt.format(ts);
    if (day === today - 86400000) return 'вчера';
    return dateFmt.format(ts);
  }

  function relative(ts) {
    const diff = Math.max(0, Date.now() - ts);
    const min = Math.floor(diff / 60000);
    if (min < 1) return 'только что';
    if (min < 60) return `${min} ${plural(min, 'минуту', 'минуты', 'минут')} назад`;
    const hrs = Math.floor(min / 60);
    if (hrs < 24) return `${hrs} ${plural(hrs, 'час', 'часа', 'часов')} назад`;
    return dayLabel(ts).toLowerCase() + ' в ' + timeFmt.format(ts);
  }

  function presenceText(user) {
    if (!user) return '';
    if (user.online) return 'в сети';
    if (!user.lastSeenAt) return 'не в сети';
    return 'был(а) в сети ' + relative(user.lastSeenAt);
  }

  /** Текст → фрагмент со ссылками (только http/https), без HTML. */
  function linkify(text) {
    const frag = document.createDocumentFragment();
    const re = /\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi;
    let last = 0;
    let m;
    while ((m = re.exec(text))) {
      if (m.index > last) frag.append(text.slice(last, m.index));
      let url = null;
      try {
        url = new URL(m[0]);
      } catch (e) {
        /* не ссылка */
      }
      if (url && (url.protocol === 'http:' || url.protocol === 'https:')) {
        frag.append(h('a', { href: url.href, target: '_blank', rel: 'noopener noreferrer nofollow ugc', text: m[0] }));
      } else frag.append(m[0]);
      last = m.index + m[0].length;
    }
    if (last < text.length) frag.append(text.slice(last));
    return frag;
  }

  function avatar(user, size) {
    const el = h('div', { class: 'avatar', 'aria-hidden': 'true' });
    if (size) {
      el.style.width = size + 'px';
      el.style.height = size + 'px';
      el.style.fontSize = size + 'px';
    }
    if (user && user.avatar) el.append(h('img', { src: user.avatar, alt: '', decoding: 'async' }));
    else el.append(h('span', { class: 'avatar__initial', text: user && user.nickname ? user.nickname[0] : '?' }));
    return el;
  }

  /** Сжимает выбранную картинку в квадрат size×size (обрезка по центру). */
  function resizeImage(file, size = 400) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return reject(new Error('Поддерживаются JPG, PNG, WebP и GIF.'));
      if (file.size > 8 * 1024 * 1024) return reject(new Error('Файл больше 8 МБ.'));
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        const s = Math.min(img.naturalWidth, img.naturalHeight);
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = size;
        const ctx = canvas.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(img, (img.naturalWidth - s) / 2, (img.naturalHeight - s) / 2, s, s, 0, 0, size, size);
        URL.revokeObjectURL(url);
        let data = canvas.toDataURL('image/webp', 0.86);
        if (!data.startsWith('data:image/webp')) data = canvas.toDataURL('image/jpeg', 0.86);
        resolve(data);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Не получилось открыть картинку.'));
      };
      img.src = url;
    });
  }

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  window.UI = {
    h,
    append,
    clear,
    icon,
    toast,
    modal,
    closeModals,
    confirm: confirmDialog,
    field,
    counter,
    setFieldError,
    clearErrors,
    showFormError,
    passwordStrength,
    setLoading,
    plural,
    dayLabel,
    shortTime,
    relative,
    presenceText,
    fullDate: (ts) => fullFmt.format(ts),
    time: (ts) => timeFmt.format(ts),
    linkify,
    avatar,
    resizeImage,
    debounce,
  };
})();
