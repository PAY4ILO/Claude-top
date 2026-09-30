/*
 * Окно входа и регистрации. Используется на лендинге и в личном кабинете.
 *   Auth.open({ mode: 'login' | 'register', reason, onSuccess(user), closable })
 */
(function () {
  'use strict';
  const { h, icon, field } = UI;

  function open({ mode = 'login', reason = '', onSuccess, closable = true } = {}) {
    let current = mode;
    const titleId = 'auth-title';
    const title = h('h2', { class: 'modal__title', id: titleId });
    const lead = h('p', { class: 'auth__lead' });
    const tabs = h('div', { class: 'auth__tabs', role: 'tablist', 'aria-label': 'Вход или регистрация' });
    const body = h('div', { class: 'auth__body' });
    const tabLogin = h('button', { class: 'auth__tab', type: 'button', role: 'tab', id: 'auth-tab-login', 'aria-controls': 'auth-panel', text: 'Вход', onclick: () => show('login') });
    const tabRegister = h('button', { class: 'auth__tab', type: 'button', role: 'tab', id: 'auth-tab-register', 'aria-controls': 'auth-panel', text: 'Регистрация', onclick: () => show('register') });
    tabs.append(tabLogin, tabRegister);
    tabs.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const next = current === 'login' ? tabRegister : tabLogin;
        show(current === 'login' ? 'register' : 'login');
        next.focus();
      }
    });
    const panel = h('div', { id: 'auth-panel', role: 'tabpanel' }, body);

    const m = UI.modal({
      labelledBy: titleId,
      closable,
      content: h('div', { class: 'auth' }, title, lead, tabs, panel),
    });
    m.dialog.classList.add('auth-dialog');

    function show(next) {
      current = next;
      const isAuthTab = next === 'login' || next === 'register';
      tabs.hidden = !isAuthTab;
      tabLogin.setAttribute('aria-selected', String(next === 'login'));
      tabRegister.setAttribute('aria-selected', String(next === 'register'));
      tabLogin.tabIndex = next === 'login' ? 0 : -1;
      tabRegister.tabIndex = next === 'register' ? 0 : -1;
      panel.setAttribute('aria-labelledby', next === 'register' ? 'auth-tab-register' : 'auth-tab-login');
      title.textContent = { login: 'Вход', register: 'Регистрация', reset: 'Восстановление пароля' }[next];
      lead.textContent = reason && isAuthTab ? reason : next === 'reset' ? 'Укажите почту аккаунта — пришлём ссылку для смены пароля.' : '';
      lead.hidden = !lead.textContent;
      UI.clear(body).append(next === 'login' ? loginForm() : next === 'register' ? registerForm() : resetForm());
      const first = body.querySelector('input');
      if (first) first.focus();
    }

    function done(user) {
      m.close();
      UI.toast(current === 'register' ? `Добро пожаловать, ${user.nickname}!` : `С возвращением, ${user.nickname}!`, { type: 'success' });
      if (onSuccess) onSuccess(user);
    }

    function demoNote() {
      if (Api.mode !== 'demo') return null;
      return h('p', { class: 'auth__note' }, icon('info'), h('span', { text: 'Демо-режим: аккаунт хранится только в этом браузере, пароль — в виде хеша.' }));
    }

    function loginForm() {
      const form = h(
        'form',
        { class: 'auth__form', novalidate: true },
        h('div', { class: 'form-alert', role: 'alert', hidden: true }),
        field({ label: 'Никнейм или почта', name: 'login', autocomplete: 'username', required: true, attrs: { autocapitalize: 'off', spellcheck: 'false' } }),
        field({ label: 'Пароль', name: 'password', type: 'password', autocomplete: 'current-password', required: true }),
        h(
          'div',
          { class: 'auth__row' },
          h('label', { class: 'checkbox' }, h('input', { type: 'checkbox', name: 'remember' }), h('span', { text: 'Запомнить меня' })),
          h('button', { class: 'link-btn', type: 'button', text: 'Забыли пароль?', onclick: () => show('reset') })
        ),
        h('button', { class: 'btn btn--lg btn--block', type: 'submit', text: 'Войти' }),
        demoNote()
      );
      form.addEventListener('submit', (e) => submit(e, form, () => Api.auth.login({ login: form.login.value, password: form.password.value, remember: form.remember.checked })));
      return form;
    }

    function registerForm() {
      const strength = h('div', { class: 'strength', 'data-level': '0', 'aria-hidden': 'true' }, h('span'), h('span'), h('span'), h('span'));
      const pw = field({ label: 'Пароль', name: 'password', type: 'password', autocomplete: 'new-password', required: true, hint: 'Минимум 8 символов, буквы и цифры.' });
      pw.insertBefore(strength, pw.querySelector('.field__hint'));
      const form = h(
        'form',
        { class: 'auth__form', novalidate: true },
        h('div', { class: 'form-alert', role: 'alert', hidden: true }),
        field({ label: 'Никнейм в Minecraft', name: 'nickname', autocomplete: 'nickname', required: true, maxlength: 16, hint: '3–16 символов: латиница, цифры, «_».', attrs: { autocapitalize: 'off', spellcheck: 'false' } }),
        field({ label: 'Почта', name: 'email', type: 'email', autocomplete: 'email', required: true, inputmode: 'email' }),
        pw,
        field({ label: 'Повторите пароль', name: 'password2', type: 'password', autocomplete: 'new-password', required: true }),
        h('label', { class: 'checkbox' }, h('input', { type: 'checkbox', name: 'remember', checked: true }), h('span', { text: 'Запомнить меня на этом устройстве' })),
        h('button', { class: 'btn btn--lg btn--block', type: 'submit', text: 'Создать аккаунт' }),
        demoNote()
      );
      form.password.addEventListener('input', () => strength.setAttribute('data-level', UI.passwordStrength(form.password.value)));
      form.addEventListener('submit', (e) => {
        submit(e, form, () => {
          const errors = {
            nickname: Api.validate.nickname(form.nickname.value),
            email: Api.validate.email(form.email.value),
            password: Api.validate.password(form.password.value),
            password2: form.password2.value !== form.password.value ? 'Пароли не совпадают.' : '',
          };
          const fields = Object.fromEntries(Object.entries(errors).filter(([, v]) => v));
          if (Object.keys(fields).length) return Promise.reject(new Api.ApiError('VALIDATION', null, { fields }));
          return Api.auth.register({ nickname: form.nickname.value, email: form.email.value, password: form.password.value, remember: form.remember.checked });
        });
      });
      return form;
    }

    function resetForm() {
      const form = h(
        'form',
        { class: 'auth__form', novalidate: true },
        h('div', { class: 'form-alert', role: 'alert', hidden: true }),
        field({ label: 'Почта', name: 'email', type: 'email', autocomplete: 'email', required: true, inputmode: 'email' }),
        h('button', { class: 'btn btn--lg btn--block', type: 'submit', text: 'Отправить ссылку' }),
        h('button', { class: 'link-btn auth__back', type: 'button', text: '← Вернуться ко входу', onclick: () => show('login') })
      );
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        UI.clearErrors(form);
        const err = Api.validate.email(form.email.value);
        if (err) return UI.setFieldError(form, 'email', err), form.email.focus();
        const btn = form.querySelector('[type=submit]');
        UI.setLoading(btn, true);
        try {
          await Api.auth.requestPasswordReset({ email: form.email.value.trim() });
          const ok = form.querySelector('.form-alert');
          ok.hidden = false;
          ok.classList.add('form-alert--info');
          UI.clear(ok).append(icon('check'), h('span', { text: 'Если такой аккаунт есть, письмо уже в пути. Проверьте «Спам».' }));
        } catch (error) {
          UI.showFormError(form, error);
        } finally {
          UI.setLoading(btn, false);
        }
      });
      return form;
    }

    async function submit(e, form, action) {
      e.preventDefault();
      UI.clearErrors(form);
      const btn = form.querySelector('[type=submit]');
      UI.setLoading(btn, true);
      try {
        const user = await action();
        done(user);
      } catch (err) {
        UI.showFormError(form, err);
        if (err && err.code === 'RATE_LIMITED' && err.retryAfter) lockButton(btn, err.retryAfter);
      } finally {
        if (!btn.dataset.locked) UI.setLoading(btn, false);
      }
    }

    function lockButton(btn, seconds) {
      const label = btn.textContent;
      btn.dataset.locked = '1';
      btn.classList.remove('is-loading');
      btn.disabled = true;
      let left = seconds;
      const tick = () => {
        if (!document.contains(btn)) return;
        if (left <= 0) {
          delete btn.dataset.locked;
          btn.disabled = false;
          btn.textContent = label;
          return;
        }
        btn.textContent = `Повторите через ${left--} с`;
        setTimeout(tick, 1000);
      };
      tick();
    }

    show(mode);
    return m;
  }

  window.Auth = { open };
})();
