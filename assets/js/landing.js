(function () {
  'use strict';

  /* --------------------------------------------------------- мобильное меню */
  const burger = document.querySelector('.burger');
  const menu = document.getElementById('mobile-menu');

  function setMenu(open) {
    burger.setAttribute('aria-expanded', String(open));
    burger.setAttribute('aria-label', open ? 'Закрыть меню' : 'Открыть меню');
    menu.hidden = !open;
  }

  burger.addEventListener('click', () => setMenu(menu.hidden));
  menu.addEventListener('click', (e) => e.target.closest('a') && setMenu(false));
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !menu.hidden) {
      setMenu(false);
      burger.focus();
    }
  });
  document.addEventListener('click', (e) => !menu.hidden && !e.target.closest('.site-header') && setMenu(false));
  window.matchMedia('(min-width: 861px)').addEventListener('change', (e) => e.matches && setMenu(false));

  /* ----------------------------------------------- ссылки, которым нужен вход */
  let user = null;
  let checked = false;
  const ready = Api.auth
    .me()
    .then((u) => (user = u))
    .catch(() => null)
    .finally(() => (checked = true));

  // событие может прийти из другой вкладки — перечитываем пользователя этой вкладки
  Api.auth.onChange(() =>
    Api.auth
      .me()
      .then((u) => (user = u))
      .catch(() => null)
  );

  document.addEventListener('click', async (e) => {
    const link = e.target.closest('[data-auth-link]');
    if (!link || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    if (!checked) await ready;
    if (user) {
      location.href = link.href;
      return;
    }
    const apply = link.dataset.authLink === 'apply';
    Auth.open({
      mode: apply ? 'register' : 'login',
      reason: apply ? 'Чтобы подать заявку на сервер, создайте аккаунт или войдите.' : '',
      onSuccess: () => (location.href = link.href),
    });
  });

  // lk.html может отправить сюда с #login / #register
  const hash = location.hash.slice(1);
  if (hash === 'login' || hash === 'register') {
    history.replaceState(null, '', location.pathname + location.search);
    ready.then(() => !user && Auth.open({ mode: hash, onSuccess: () => (location.href = 'lk.html') }));
  }

  /* ------------------------------------------------------------- Telegram */
  const tg = (window.LWL_CONFIG && window.LWL_CONFIG.telegramUrl) || '';
  document.querySelectorAll('[data-telegram-link]').forEach((a) => {
    if (/^https:\/\//.test(tg)) a.href = tg;
  });
})();
