/*
 * Карточки игроков на публичных страницах (без кабинета):
 *   [data-players]           — players.html: весь список с поиском (вкладки сортировки — только игрокам);
 *   [data-players-showcase]  — главная: несколько карточек вперемешку, секция [data-showcase-section] скрыта, пока пусто;
 *   [data-online]            — «Сейчас на сервере: N» (GET /api/online, без входа), скрыт, когда никого.
 */
(function () {
  'use strict';

  // Админ с правом «Люди» может убрать чужую картинку фона прямо из окна игрока (как в кабинете).
  let canModerate = false;
  if (document.querySelector('[data-players], [data-players-showcase]')) {
    Players.allowModeration(() => canModerate);
    Api.auth
      .me()
      .then((user) => {
        canModerate = !!(user && Array.isArray(user.permissions) && user.permissions.includes('users'));
      })
      .catch(() => null);
  }

  const list = document.querySelector('[data-players]');
  if (list) {
    const note = document.querySelector('[data-players-note]');
    Players.mount(list, {
      onLoad: (d) => {
        if (note) note.hidden = d.full;
      },
    });
  }

  const showcase = document.querySelector('[data-players-showcase]');
  if (showcase) {
    const section = document.querySelector('[data-showcase-section]');
    Players.showcase(showcase, { limit: 6 }).then((shown) => {
      if (section) section.hidden = !shown;
    });
  }

  const pills = document.querySelectorAll('[data-online]');
  if (pills.length) {
    const update = () =>
      Api.players
        .online()
        .then(({ count }) => {
          pills.forEach((pill) => {
            pill.hidden = !(count > 0);
            pill.querySelector('[data-online-text]').textContent = `Сейчас на сервере: ${count}`;
          });
        })
        .catch(() => null);
    update();
    // Раз в минуту, пока вкладку видно.
    setInterval(() => document.visibilityState === 'visible' && update(), 60000);
  }
})();
