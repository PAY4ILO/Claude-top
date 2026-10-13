/*
 * Карточки игроков: сетка, окно с подробностями и 3D-скином, редактор своей карточки.
 * Одно и то же на публичной странице players.html, на главной (витрина) и в кабинете (#/players, профиль).
 *
 * Сервер сам решает, что показать: гостям и «Пользователям» — ник, скин, поза, фон, «о себе», соцсети;
 * «Игрокам» и админам ещё статистика и «в сети» (поле full в ответе). Скрытое игроком сервер вырезает сам.
 */
(function () {
  'use strict';

  const { h, icon, clear } = UI;

  /* ------------------------------------------------------------ форматы */

  const nf = new Intl.NumberFormat('ru-RU');
  const num = (n) => nf.format(n);

  /** 59 мин, 12 ч, 1 234 ч */
  function hours(sec) {
    if (sec < 3600) return `${Math.floor(sec / 60)} мин`;
    return `${num(Math.floor(sec / 3600))} ч`;
  }

  /** 830 м, 3,4 км, 120 км */
  function distance(m) {
    if (m < 1000) return `${num(m)} м`;
    const k = m / 1000;
    return (k < 100 ? k.toFixed(1).replace(/\.0$/, '').replace('.', ',') : num(Math.round(k))) + ' км';
  }

  const STAT_ROWS = [
    { key: 'playtimeSec', label: 'Наиграно', format: hours, main: true },
    { key: 'deaths', label: 'Смерти', format: num, main: true },
    { key: 'mobKills', label: 'Убито мобов', format: num, main: true },
    { key: 'distanceM', label: 'Пройдено', format: distance, main: true },
    { key: 'playerKills', label: 'Убито игроков', format: num },
    { key: 'blocksMined', label: 'Добыто блоков', format: num },
    { key: 'advancements', label: 'Достижения', format: num },
  ];

  /** Звания по статистике. Скрытое поле — звания за него нет. */
  const RANKS = [
    { label: 'Старожил', hint: '100+ часов в игре', test: (s) => s.playtimeSec >= 100 * 3600 },
    { label: 'Шахтёр', hint: '10 000+ добытых блоков', test: (s) => s.blocksMined >= 10000 },
    { label: 'Путешественник', hint: '100+ км пройдено', test: (s) => s.distanceM >= 100000 },
    { label: 'Охотник', hint: '1 000+ убитых мобов', test: (s) => s.mobKills >= 1000 },
    { label: 'Знаток', hint: '50+ достижений', test: (s) => s.advancements >= 50 },
  ];
  const ranksOf = (p) => (p.stats ? RANKS.filter((r) => r.test(p.stats)) : []);

  const backgroundOf = (p) => (Object.hasOwn(Api.CARD_BACKGROUNDS, p.background) ? p.background : 'meadow');

  /** Как стоит персонаж: view — 'card' (маленькая карточка) или 'detail' (окно игрока). */
  const lookOf = (p, view) => (p.looks && p.looks[view]) || { pose: p.pose || 'stand', scale: 1, turn: 0 };

  /** Фон сцены: класс заготовки или своя картинка (через CSSOM: CSP не пускает style="…"). */
  function paintBackground(el, p) {
    for (const c of [...el.classList]) if (c.startsWith('bg--')) el.classList.remove(c);
    const custom = p.background === 'custom' && p.backgroundUrl;
    el.classList.add('bg--' + (custom ? 'custom' : backgroundOf(p)));
    el.style.backgroundImage = custom ? `url("${p.backgroundUrl}")` : '';
    return el;
  }

  // Убрать чужую картинку фона может админ с правом «Люди» — кабинет сообщает это через allowModeration.
  let canModerate = () => false;

  function lastSeenText(p) {
    if (p.online) return 'в сети';
    return p.lastSeen ? 'был(а) ' + UI.relative(p.lastSeen) : '';
  }

  function presence(p) {
    if (p.online) return h('span', { class: 'pcard__online' }, h('span', { class: 'pcard__dot', 'aria-hidden': 'true' }), 'в сети');
    const text = lastSeenText(p);
    return text && h('span', { class: 'pcard__seen', text });
  }

  function roleTag(p) {
    if (p.creator) return h('span', { class: 'role role--creator', text: Api.CREATOR_LABEL });
    if (p.role === 'admin') return h('span', { class: 'role role--admin', text: Api.ROLES.admin });
    return null;
  }

  /** Соцсети: ссылки собираются здесь из проверенных ников, Discord — копируется. */
  function socials(p, cls) {
    const items = Object.entries(Api.SOCIALS)
      .filter(([key]) => p.socials && p.socials[key])
      .map(([key, s]) => {
        const handle = p.socials[key];
        const shown = s.at ? '@' + handle : handle;
        if (!s.url) {
          return h('button', {
            class: `social social--${key}`,
            type: 'button',
            title: `${s.label}: ${handle} — нажмите, чтобы скопировать`,
            onclick: (e) => {
              e.stopPropagation();
              navigator.clipboard?.writeText(handle).then(
                () => UI.toast(`Ник в ${s.label} скопирован`),
                () => UI.toast(`${s.label}: ${handle}`)
              );
            },
          }, h('span', { class: 'social__name', text: s.label }), h('span', { class: 'social__handle', text: shown }));
        }
        return h('a', { class: `social social--${key}`, href: s.url + encodeURIComponent(handle), target: '_blank', rel: 'noopener noreferrer nofollow', title: `${s.label}: ${shown}` },
          h('span', { class: 'social__name', text: s.label }), h('span', { class: 'social__handle', text: shown }));
      });
    return items.length ? h('div', { class: 'socials ' + (cls || '') }, items) : null;
  }

  /* ------------------------------------------------------------ карточка */

  function card(p, { onOpen } = {}) {
    const figure = Skin3D.figure({ url: p.skinUrl, slim: p.skinSlim, look: lookOf(p, 'card'), label: `Скин игрока ${p.nickname}` });
    const ranks = ranksOf(p).slice(0, 2);
    const main = p.stats ? STAT_ROWS.filter((r) => r.main && typeof p.stats[r.key] === 'number') : [];
    const el = h(
      'article',
      { class: 'pcard card', dataset: { nick: p.nickname } },
      paintBackground(h('div', { class: 'pcard__scene' }, h('div', { class: 'pcard__figure' }, figure)), p),
      h(
        'div',
        { class: 'pcard__body' },
        h(
          'div',
          { class: 'pcard__head' },
          h('h3', { class: 'pcard__nick' }, h('button', { class: 'pcard__open', type: 'button', text: p.nickname, 'aria-label': `${p.nickname} — открыть карточку` })),
          roleTag(p)
        ),
        (p.online !== undefined || ranks.length > 0) && h('div', { class: 'pcard__meta' }, presence(p), ranks.map((r) => h('span', { class: 'rank', title: r.hint, text: r.label }))),
        p.bio ? h('p', { class: 'pcard__bio', text: p.bio }) : h('p', { class: 'pcard__bio pcard__bio--empty', text: 'Пока ничего о себе не написал(а).' }),
        main.length > 0 &&
          h(
            'dl',
            { class: 'pcard__stats' },
            main.map((r) => h('div', { class: 'pcard__stat' }, h('dt', { text: r.label }), h('dd', { text: r.format(p.stats[r.key]) })))
          ),
        socials(p, 'socials--compact')
      )
    );
    el.querySelector('.pcard__open').addEventListener('click', () => (onOpen || openDetails)(p));
    // Клик по любому месту карточки (кроме ссылок) — тоже открыть.
    el.addEventListener('click', (e) => {
      if (e.target.closest('a, button')) return;
      (onOpen || openDetails)(p);
    });
    return el;
  }

  /* ------------------------------------------------------------ подробности */

  function openDetails(p) {
    const look = lookOf(p, 'detail');
    const viewer = Skin3D.viewer({ url: p.skinUrl, slim: p.skinSlim, look, label: `Скин игрока ${p.nickname}` });
    // Своя поза игрока — первой кнопкой, чтобы к ней можно было вернуться.
    const options = [...(look.pose === 'custom' ? [['custom', 'Как у игрока']] : []), ...Object.entries(Api.CARD_POSES)];
    const poses = h(
      'div',
      { class: 'chips', role: 'radiogroup', 'aria-label': 'Поза' },
      options.map(([key, label]) =>
        h('button', {
          class: 'chip',
          type: 'button',
          role: 'radio',
          'aria-checked': String(key === look.pose),
          text: label,
          onclick: (e) => {
            poses.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', String(c === e.currentTarget)));
            viewer.set({ look: key === 'custom' ? look : { pose: key, scale: look.scale, turn: look.turn } });
          },
        })
      )
    );
    const stage = paintBackground(
      h('div', { class: 'pdetail__stage' }, viewer.el, h('a', { class: 'pdetail__download link', href: p.skinUrl, download: `${p.nickname}.png`, text: 'Скачать скин' })),
      p
    );
    // Модерация: картинку фона видят все, даже гости.
    const moderate =
      p.background === 'custom' &&
      canModerate() &&
      h('button', {
        class: 'btn btn--sm btn--ghost pdetail__moderate',
        type: 'button',
        text: 'Убрать картинку фона',
        onclick: async (e) => {
          const btn = e.currentTarget;
          const ok = await UI.confirm({ title: 'Убрать картинку?', text: `Фон ${p.nickname} станет обычным «Лугом», файл удалится с сервера. Игрок сможет загрузить другую.`, confirmText: 'Убрать' });
          if (!ok) return;
          try {
            const next = await Api.players.removePlayerBackground(p.nickname);
            paintBackground(stage, next);
            btn.remove();
            UI.toast('Картинка фона убрана');
          } catch (err) {
            UI.toast(err.message, { type: 'error' });
          }
        },
      });
    const stats = p.stats ? STAT_ROWS.filter((r) => typeof p.stats[r.key] === 'number') : [];
    const ranks = ranksOf(p);
    const dates = [
      p.firstSeen && ['Первый вход', UI.fullDate(p.firstSeen)],
      p.lastSeen && !p.online && ['Последний раз в игре', UI.fullDate(p.lastSeen)],
    ].filter(Boolean);
    const content = h(
      'div',
      { class: 'pdetail' },
      stage,
      h(
        'div',
        { class: 'pdetail__info' },
        h('div', { class: 'pdetail__meta' }, roleTag(p), presence(p), ranks.map((r) => h('span', { class: 'rank', title: r.hint, text: r.label }))),
        p.bio && h('p', { class: 'pdetail__bio', text: p.bio }),
        socials(p),
        h('div', { class: 'pdetail__poses' }, h('p', { class: 'pdetail__label', text: 'Примерить позу' }), poses),
        stats.length > 0 &&
          h('dl', { class: 'pdetail__stats' }, stats.map((r) => h('div', { class: 'pdetail__stat' }, h('dt', { text: r.label }), h('dd', { text: r.format(p.stats[r.key]) })))),
        dates.length > 0 && h('dl', { class: 'pdetail__dates' }, dates.map(([k, v]) => h('div', null, h('dt', { text: k }), h('dd', { text: v })))),
        p.full === false && h('p', { class: 'pdetail__note', text: 'Статистика из игры видна игрокам сервера после входа на сайт.' }),
        p.statsAt && h('p', { class: 'pdetail__note', text: 'Статистика обновлена ' + UI.relative(p.statsAt) + '.' }),
        moderate
      )
    );
    UI.modal({ title: p.nickname, content, size: 'wide', onClose: () => viewer.destroy() });
  }

  /* ------------------------------------------------------------ сетка со списком */

  const SORTS = [
    ['online', 'Сначала в сети'],
    ['playtime', 'По времени игры'],
    ['recent', 'Недавно были'],
    ['tops', 'Топы'],
  ];

  const TOPS = [
    { key: 'playtimeSec', title: 'Больше всех наиграли', format: hours },
    { key: 'deaths', title: 'Чаще всех умирали', format: num },
    { key: 'distanceM', title: 'Дальше всех прошли', format: distance },
  ];

  function stateBlock({ iconName, title, text, action, error }) {
    return h(
      'div',
      { class: 'state' + (error ? ' state--error' : '') },
      h('div', { class: 'state__icon' }, icon(iconName || 'info')),
      h('p', { class: 'state__title', text: title }),
      text && h('p', { class: 'state__text', text }),
      action
    );
  }

  function skeletons(n) {
    return h('div', { class: 'pgrid', 'aria-hidden': 'true' }, Array.from({ length: n }, () => h('div', { class: 'pcard pcard--skeleton card' }, h('div', { class: 'skeleton pcard__skeleton-scene' }), h('div', { class: 'pcard__body' }, h('div', { class: 'skeleton pcard__skeleton-line' }), h('div', { class: 'skeleton pcard__skeleton-line pcard__skeleton-line--short' })))));
  }

  /**
   * Список с поиском (и вкладками сортировки, если видна статистика).
   * root — куда рисовать; onLoad(ответ) — после каждой загрузки. Возвращает { reload, destroy }.
   */
  function mount(root, { emptyAction, onLoad } = {}) {
    let sort = 'online';
    let query = '';
    let full = false;
    let seq = 0;

    const searchInput = h('input', { class: 'input', type: 'search', placeholder: 'Найти по нику', 'aria-label': 'Найти игрока по нику', maxlength: '16', autocomplete: 'off', spellcheck: 'false' });
    const tabs = h(
      'div',
      { class: 'tabs players__tabs', role: 'tablist', 'aria-label': 'Порядок', hidden: true },
      SORTS.map(([key, label]) =>
        h('button', { class: 'tabs__tab', type: 'button', role: 'tab', 'aria-selected': String(key === sort), dataset: { key }, text: label, onclick: () => setSort(key) })
      )
    );
    const count = h('p', { class: 'players__count', 'aria-live': 'polite' });
    const box = h('div', { class: 'players__box', 'aria-busy': 'false' });
    clear(root).append(h('div', { class: 'players__tools' }, h('div', { class: 'search', role: 'search' }, icon('search'), searchInput), tabs), count, box);

    function setSort(key) {
      sort = key;
      tabs.querySelectorAll('.tabs__tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.key === key)));
      load();
    }

    const onSearch = UI.debounce(() => {
      query = searchInput.value.trim();
      load();
    }, 250);
    searchInput.addEventListener('input', onSearch);

    async function load() {
      const my = ++seq;
      box.setAttribute('aria-busy', 'true');
      if (!box.querySelector('.pcard')) clear(box).append(skeletons(6));
      try {
        const d = await Api.players.list({ sort: sort === 'tops' ? 'playtime' : sort, query });
        if (my !== seq) return;
        full = !!d.full;
        tabs.hidden = !full;
        if (!full && sort !== 'online') sort = 'online';
        render(d);
        if (onLoad) onLoad(d);
      } catch (err) {
        if (my !== seq) return;
        count.textContent = '';
        clear(box).append(stateBlock({ iconName: 'alert', error: true, title: 'Не удалось загрузить', text: err.message, action: h('button', { class: 'btn', type: 'button', text: 'Повторить', onclick: load }) }));
      } finally {
        if (my === seq) box.setAttribute('aria-busy', 'false');
      }
    }

    function render(d) {
      const list = d.players.map((p) => ({ ...p, full }));
      count.textContent = d.total ? `${d.total} ${UI.plural(d.total, 'игрок', 'игрока', 'игроков')}` + (full && d.online ? ` · в сети: ${d.online}` : '') : '';
      if (!list.length) {
        clear(box).append(
          query
            ? stateBlock({ iconName: 'search', title: 'Никого не нашли', text: `Игрока с ником «${query}» нет или он скрыл карточку.` })
            : stateBlock({ iconName: 'users', title: 'Пока никто не заходил', text: 'Карточки появятся, когда игроки зайдут на сервер.', action: emptyAction })
        );
        return;
      }
      if (sort === 'tops') {
        clear(box).append(tops(list));
        return;
      }
      clear(box).append(h('div', { class: 'pgrid' }, list.map((p) => card(p))));
    }

    function tops(list) {
      return h(
        'div',
        { class: 'tops' },
        TOPS.map((t) => {
          const rows = list.filter((p) => p.stats && typeof p.stats[t.key] === 'number' && p.stats[t.key] > 0).sort((a, b) => b.stats[t.key] - a.stats[t.key]).slice(0, 10);
          return h(
            'section',
            { class: 'tops__col card' },
            h('h3', { class: 'tops__title', text: t.title }),
            rows.length
              ? h(
                  'ol',
                  { class: 'tops__list' },
                  rows.map((p, i) =>
                    h(
                      'li',
                      { class: 'tops__row' + (i < 3 ? ' tops__row--' + (i + 1) : '') },
                      h('span', { class: 'tops__place', text: String(i + 1) }),
                      h('button', { class: 'tops__nick link', type: 'button', text: p.nickname, onclick: () => openDetails(p) }),
                      h('span', { class: 'tops__value', text: t.format(p.stats[t.key]) })
                    )
                  )
                )
              : h('p', { class: 'tops__empty', text: 'Пока пусто.' })
          );
        })
      );
    }

    const off = Api.players.onChange ? Api.players.onChange(() => load()) : null;
    load();
    return {
      reload: load,
      destroy: () => off && off(),
    };
  }

  /** Витрина на главной: несколько карточек вперемешку, без вкладок. */
  async function showcase(root, { limit = 8 } = {}) {
    try {
      const d = await Api.players.list({ sort: 'online' });
      const list = d.players.slice();
      for (let i = list.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [list[i], list[j]] = [list[j], list[i]];
      }
      if (!list.length) return false;
      clear(root).append(h('div', { class: 'pgrid' }, list.slice(0, limit).map((p) => card({ ...p, full: !!d.full }))));
      return true;
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------ своя карточка (профиль) */

  const SYNC_TEXT = {
    ok: 'Скин отправлен на сервер — через несколько секунд он появится в игре.',
    error: 'Не получилось отправить скин на сервер.',
    off: 'Скин сохранён на сайте. На сервере его поставит администрация: связь сайта с сервером ещё не настроена.',
  };

  /**
   * Секции профиля «Моя карточка» и «Мой скин». Возвращает элемент; данные грузит сам.
   * Всё применяется сразу, с тостом.
   */
  function editor() {
    const root = h('div', { class: 'stack my-card' }, h('section', { class: 'card card--pad' }, h('div', { class: 'skeleton-list', 'aria-hidden': 'true' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }))));
    let data = null;

    const save = async (patch, okText) => {
      try {
        data = await Api.players.updateMyCard(patch);
        if (okText) UI.toast(okText, { type: 'success' });
        // Только предпросмотр: форма с недописанным текстом остаётся как есть.
        refreshPreview();
        return true;
      } catch (err) {
        UI.toast(err.fields ? Object.values(err.fields)[0] : err.message, { type: 'error' });
        return false;
      }
    };

    function load() {
      Api.players
        .myCard()
        .then((d) => {
          data = d;
          draw();
        })
        .catch((err) => {
          clear(root).append(h('section', { class: 'card card--pad' }, stateBlock({ iconName: 'alert', error: true, title: 'Не удалось загрузить карточку', text: err.message, action: h('button', { class: 'btn', type: 'button', text: 'Повторить', onclick: load }) })));
        });
    }

    let preview;
    let viewer;
    // Как стоит персонаж — рабочая копия: предпросмотр меняется сразу, на сервер уходит чуть позже.
    let looks;
    let lookView = 'card';
    let previewFigure = null;
    let previewViewer = null;

    function draw() {
      if (viewer) viewer.destroy();
      looks = JSON.parse(JSON.stringify(data.looks));
      const p = { ...data.card, full: true };
      preview = h('div', { class: 'my-card__preview' });
      refreshPreview();
      clear(root).append(cardSection(p), skinSection(p));
    }

    /** Слева — то, что сейчас настраивают: маленькая карточка или окно игрока. */
    function refreshPreview() {
      if (previewViewer) previewViewer.destroy();
      previewViewer = null;
      previewFigure = null;
      const p = { ...data.card, looks, full: true };
      if (lookView === 'detail') {
        previewViewer = Skin3D.viewer({ url: p.skinUrl, slim: p.skinSlim, look: looks.detail, label: 'Окно игрока — предпросмотр', animate: false });
        preview.replaceChildren(
          paintBackground(h('div', { class: 'pdetail__stage my-card__stage' }, previewViewer.el), p),
          h('p', { class: 'my-card__caption', text: 'Так персонаж стоит в окне, которое открывается по нажатию на карточку.' })
        );
      } else {
        const el = card(p);
        previewFigure = el.querySelector('.skin3d__figure');
        preview.replaceChildren(el);
      }
    }

    function livePreview() {
      if (lookView === 'card' && previewFigure) previewFigure.update(looks.card);
      if (lookView === 'detail' && previewViewer) previewViewer.set({ look: looks.detail });
    }

    /* Персонаж: поза (или своя — ползунками), размер и поворот; отдельно для карточки и для окна. */

    // Подписи осей для каждой части; знак — чтобы «вправо» на ползунке значило «вперёд» / «в сторону от тела».
    const AXES = {
      head: [['Кивок', 1], ['Поворот', 1], ['Наклон к плечу', 1]],
      body: [['Наклон вперёд', 1], ['Поворот', 1], ['Наклон вбок', 1]],
      rightArm: [['Вперёд — назад', -1], ['Вращение', 1], ['В сторону', -1]],
      leftArm: [['Вперёд — назад', -1], ['Вращение', 1], ['В сторону', 1]],
      rightLeg: [['Вперёд — назад', -1], ['Вращение', 1], ['В сторону', -1]],
      leftLeg: [['Вперёд — назад', -1], ['Вращение', 1], ['В сторону', 1]],
    };

    function slider({ label, min, max, value, unit = '', onInput }) {
      const out = h('output', { class: 'look__value', text: value + unit });
      const input = h('input', { class: 'look__range', type: 'range', min: String(min), max: String(max), step: '1', value: String(value), 'aria-label': label });
      input.addEventListener('input', () => {
        out.textContent = input.value + unit;
        onInput(Number(input.value));
      });
      return h('label', { class: 'look__slider' }, h('span', { class: 'look__name', text: label }), input, out);
    }

    function lookSection() {
      const status = h('p', { class: 'look__status', 'aria-live': 'polite' });
      const persist = UI.debounce(async () => {
        status.textContent = 'Сохраняю…';
        try {
          data = await Api.players.updateMyCard({ looks });
          status.textContent = 'Сохранено';
        } catch (err) {
          status.textContent = '';
          UI.toast(err.fields ? Object.values(err.fields)[0] : err.message, { type: 'error' });
        }
      }, 600);
      const change = () => {
        livePreview();
        persist();
      };
      let part = 'rightArm';
      const controls = h('div', { class: 'look__controls' });
      const tabs = h(
        'div',
        { class: 'tabs look__tabs', role: 'tablist', 'aria-label': 'Что настраиваем' },
        Object.entries(Api.LOOK.views).map(([key, label]) =>
          h('button', {
            class: 'tabs__tab',
            type: 'button',
            role: 'tab',
            'aria-selected': String(key === lookView),
            dataset: { key },
            text: label,
            onclick: () => {
              lookView = key;
              tabs.querySelectorAll('.tabs__tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.key === key)));
              refreshPreview();
              render();
            },
          })
        )
      );

      /** Перерисовать настройки; focus — селектор кнопки, на которую вернуть фокус. */
      function render(focus) {
        const look = looks[lookView];
        const pick = (key) => {
          if (key === look.pose) return;
          looks[lookView] =
            key === 'custom'
              ? { pose: 'custom', angles: Skin3D.poseAngles(look.pose), scale: look.scale, turn: look.turn }
              : { pose: key, scale: look.scale, turn: look.turn };
          render(`[data-pose="${key}"]`);
          change();
        };
        const poseChips = h(
          'div',
          { class: 'chips', role: 'radiogroup', 'aria-label': 'Поза' },
          [...Object.entries(Api.CARD_POSES), ['custom', 'Своя поза']].map(([key, label]) =>
            h('button', { class: 'chip', type: 'button', role: 'radio', 'aria-checked': String(key === look.pose), dataset: { pose: key }, text: label, onclick: () => pick(key) })
          )
        );
        const other = lookView === 'card' ? 'detail' : 'card';
        UI.append(clear(controls), [
          h('div', { class: 'my-card__group' }, h('p', { class: 'field__label', text: 'Поза' }), poseChips),
          look.pose === 'custom' && custom(look),
          slider({ label: 'Размер', min: Math.round(Api.LOOK.scale[0] * 100), max: Math.round(Api.LOOK.scale[1] * 100), value: Math.round(look.scale * 100), unit: '%', onInput: (v) => ((look.scale = v / 100), change()) }),
          slider({ label: 'Поворот фигуры', min: -Api.LOOK.turn, max: Api.LOOK.turn, value: look.turn, unit: '°', onInput: (v) => ((look.turn = v), change()) }),
          h(
            'div',
            { class: 'actions-row' },
            h('button', {
              class: 'btn btn--sm btn--secondary',
              type: 'button',
              text: other === 'detail' ? 'Как в окне игрока' : 'Как на карточке',
              title: 'Взять позу, размер и поворот с другого вида',
              onclick: () => {
                looks[lookView] = JSON.parse(JSON.stringify(looks[other]));
                render();
                change();
              },
            }),
            h('button', {
              class: 'btn btn--sm btn--ghost',
              type: 'button',
              text: 'Сбросить',
              onclick: () => {
                looks[lookView] = { pose: 'stand', scale: 1, turn: 0 };
                render();
                change();
              },
            })
          ),
        ]);
        if (focus) controls.querySelector(focus)?.focus();
      }

      function custom(look) {
        const parts = h(
          'div',
          { class: 'chips chips--sm', role: 'radiogroup', 'aria-label': 'Часть тела' },
          Skin3D.PARTS.map(({ key, label }) =>
            h('button', {
              class: 'chip',
              type: 'button',
              role: 'radio',
              'aria-checked': String(key === part),
              dataset: { part: key },
              text: label,
              onclick: () => {
                part = key;
                render(`[data-part="${key}"]`);
              },
            })
          )
        );
        return h(
          'div',
          { class: 'look__custom' },
          h('p', { class: 'field__label', text: 'Что двигаем' }),
          parts,
          AXES[part].map(([label, sign], i) =>
            slider({ label, min: -Api.LOOK.angle, max: Api.LOOK.angle, value: sign * look.angles[part][i] || 0, unit: '°', onInput: (v) => ((look.angles[part][i] = sign * v), change()) })
          ),
          slider({ label: 'Присесть', min: 0, max: -Api.LOOK.lift[0], value: -look.angles.lift || 0, onInput: (v) => ((look.angles.lift = -v || 0), change()) })
        );
      }

      render();
      return h(
        'div',
        { class: 'my-card__group look' },
        h('p', { class: 'field__label', text: 'Персонаж' }),
        h('p', { class: 'card-sub', text: 'На маленькой карточке и в окне игрока персонаж может стоять по-разному. Выберите позу или соберите свою.' }),
        tabs,
        controls,
        status
      );
    }

    function cardSection(p) {
      // Фон — сразу, с предпросмотром. Своя картинка сжимается в браузере и хранится на сайте.
      const pickBackground = (key) => {
        data.card.background = key;
        data.card.backgroundUrl = key === 'custom' ? data.customBackground : null;
        refreshPreview();
        save({ background: key }, 'Фон сохранён');
      };
      const swatch = (key, label, extra) =>
        h('button', {
          class: 'swatch ' + (extra ? 'swatch--custom' : 'bg--' + key),
          type: 'button',
          role: 'radio',
          'aria-checked': String(key === (p.background === 'custom' ? 'custom' : backgroundOf(p))),
          'aria-label': label,
          title: label,
          onclick: (e) => {
            bgGroup.querySelectorAll('.swatch').forEach((b) => b.setAttribute('aria-checked', String(b === e.currentTarget)));
            pickBackground(key);
          },
        });
      const customSwatch = data.customBackground && swatch('custom', 'Своя картинка', true);
      if (customSwatch) customSwatch.style.backgroundImage = `url("${data.customBackground}")`;
      const bgGroup = h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': 'Фон' }, customSwatch, Object.entries(Api.CARD_BACKGROUNDS).map(([key, label]) => swatch(key, label)));

      const bgInput = h('input', { class: 'visually-hidden', type: 'file', accept: 'image/jpeg,image/png,image/webp,image/avif,image/gif', id: 'bg-file' });
      const bgUpload = h('label', { class: 'btn btn--sm btn--secondary', for: 'bg-file' }, icon('upload'), data.customBackground ? 'Другая картинка' : 'Своя картинка');
      bgInput.addEventListener('change', async () => {
        const file = bgInput.files[0];
        bgInput.value = '';
        if (!file) return;
        UI.setLoading(bgUpload, true);
        try {
          data = await Api.players.uploadBackground(file);
          UI.toast('Фон загружен', { type: 'success' });
          draw();
        } catch (err) {
          UI.toast(err.message, { type: 'error' });
          UI.setLoading(bgUpload, false);
        }
      });
      const bgRemove =
        data.customBackground &&
        h('button', {
          class: 'btn btn--sm btn--ghost',
          type: 'button',
          text: 'Удалить картинку',
          onclick: async () => {
            try {
              data = await Api.players.removeBackground();
              UI.toast('Картинка удалена');
              draw();
            } catch (err) {
              UI.toast(err.message, { type: 'error' });
            }
          },
        });

      // «О себе» и соцсети — по кнопке «Сохранить».
      const form = h('form', { class: 'my-card__form', novalidate: true });
      const bio = UI.field({ label: 'О себе', name: 'bio', textarea: true, value: p.bio, placeholder: 'Например: строю замки и ищу соседей у моря', attrs: { rows: '2' } });
      const bioControl = bio.querySelector('textarea');
      bio.querySelector('.field__label').after(UI.counter(bioControl, Api.LIMITS.cardBio.max));
      const socialFields = Object.entries(Api.SOCIALS).map(([key, s]) =>
        UI.field({ label: s.label, name: 'social-' + key, value: (p.socials && p.socials[key]) || '', placeholder: s.placeholder, attrs: { autocomplete: 'off', spellcheck: 'false', maxlength: '100' } })
      );
      const submit = h('button', { class: 'btn', type: 'submit', text: 'Сохранить' });
      UI.append(form, [bio, h('fieldset', { class: 'my-card__socials' }, h('legend', { class: 'field__label', text: 'Соцсети — ник или ссылка' }), h('div', { class: 'my-card__social-grid' }, socialFields)), h('div', { class: 'actions-row' }, submit)]);
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        UI.clearErrors(form);
        const socialsValue = {};
        for (const key of Object.keys(Api.SOCIALS)) socialsValue[key] = Api.parseSocial(key, form.elements['social-' + key].value);
        const patch = { bio: bioControl.value, socials: socialsValue };
        const f = Api.validate.card(patch);
        if (Object.keys(f).length) {
          if (f.bio) UI.setFieldError(form, 'bio', f.bio);
          for (const [k, msg] of Object.entries(f.socials || {})) UI.setFieldError(form, 'social-' + k, msg);
          return;
        }
        UI.setLoading(submit, true);
        await save(patch, 'Карточка сохранена');
        UI.setLoading(submit, false);
      });

      // Видимость: вся карточка или отдельные поля.
      const hiddenToggle = checkbox('Скрыть карточку', 'Её не увидит никто, кроме вас.', data.hidden, (v) => save({ hidden: v }, v ? 'Карточка скрыта' : 'Карточка снова видна'));
      const fieldsBox = h('div', { class: 'my-card__fields', hidden: !data.hideFields.length });
      const fieldsToggle = checkbox('Скрыть отдельные поля', 'Выберите, что не показывать другим.', data.hideFields.length > 0, (v) => {
        fieldsBox.hidden = !v;
        if (!v && data.hideFields.length) save({ hideFields: [] }, 'Все поля снова видны');
      });
      Object.entries(Api.CARD_FIELDS).forEach(([key, label]) => {
        fieldsBox.append(
          h('label', { class: 'checkbox' }, h('input', {
            type: 'checkbox',
            checked: data.hideFields.includes(key),
            onchange: (e) => {
              const next = e.target.checked ? [...data.hideFields, key] : data.hideFields.filter((k) => k !== key);
              save({ hideFields: next }, e.target.checked ? `«${label}» скрыто` : `«${label}» снова видно`);
            },
          }), h('span', { text: label }))
        );
      });

      return h(
        'section',
        { class: 'card card--pad' },
        h('h2', { class: 'card-title', text: 'Моя карточка' }),
        h('p', { class: 'card-sub', text: data.card.stats ? 'Так вашу карточку видят на сайте. Гости видят ник, скин, «о себе» и соцсети, игроки — ещё и статистику.' : 'Статистика появится, когда вы зайдёте на сервер. Остальное можно настроить уже сейчас.' }),
        h(
          'div',
          { class: 'card-content my-card__grid' },
          preview,
          h(
            'div',
            { class: 'my-card__controls' },
            lookSection(),
            h(
              'div',
              { class: 'my-card__group' },
              h('p', { class: 'field__label', text: 'Фон' }),
              bgGroup,
              h('div', { class: 'actions-row' }, bgInput, bgUpload, bgRemove),
              h('p', { class: 'field__hint', text: 'Своя картинка: JPEG, PNG или WebP. Сайт сам уменьшит её и сожмёт — обычно до 100–300 КБ.' })
            ),
            form,
            h('div', { class: 'my-card__group' }, hiddenToggle, fieldsToggle, fieldsBox)
          )
        )
      );
    }

    function skinSection(p) {
      viewer = Skin3D.viewer({ url: p.skinUrl, slim: p.skinSlim, look: looks.detail, label: 'Ваш скин' });
      const skin = data.skin;
      const input = h('input', { class: 'visually-hidden', type: 'file', accept: 'image/png', id: 'skin-file' });
      const uploadBtn = h('label', { class: 'btn', for: 'skin-file' }, icon('upload'), skin ? 'Загрузить другой' : 'Загрузить скин');
      const slim = h('input', { type: 'checkbox', checked: skin ? skin.slim : p.skinSlim });
      const slimBox = h('label', { class: 'checkbox' }, slim, h('span', { text: 'Тонкие руки (как у Алекс)' }));
      const status = h('div', { class: 'skin-sync', 'aria-live': 'polite' });

      function drawStatus() {
        clear(status);
        if (!skin) {
          const standard = p.skinDefault;
          status.append(
            h('p', {
              class: 'skin-sync__text',
              text: standard
                ? 'Сейчас стандартный скин. Как только вы зайдёте на сервер, здесь сам появится ваш скин из игры. Или возьмите скин по нику или загрузите файл.'
                : 'Сейчас — скин из игры. Он обновляется сам: поменяете скин в Minecraft — поменяется и здесь.',
            })
          );
          return;
        }
        const s = skin.sync || {};
        // UI.append, а не status.append: тот вывел бы null/false текстом.
        UI.append(status, [
          skin.nick && h('p', { class: 'skin-sync__text', text: `Скин как у лицензии ${skin.nick}.` }),
          h('p', { class: 'skin-sync__text skin-sync__text--' + (s.status || 'off'), text: s.status === 'error' ? `${SYNC_TEXT.error} ${s.message || ''}`.trim() : SYNC_TEXT[s.status] || SYNC_TEXT.off }),
          s.status === 'error' &&
            h('button', {
              class: 'btn btn--sm btn--secondary',
              type: 'button',
              text: 'Повторить',
              onclick: async (e) => {
                UI.setLoading(e.currentTarget, true);
                try {
                  data = await Api.players.syncSkin();
                  draw();
                } catch (err) {
                  UI.toast(err.message, { type: 'error' });
                  UI.setLoading(e.currentTarget, false);
                }
              },
            })
        ]);
      }
      drawStatus();

      async function upload(file) {
        if (!file) return;
        let checked;
        try {
          checked = await Api.players.checkSkinFile(file);
        } catch (err) {
          UI.toast(err.message, { type: 'error' });
          return;
        }
        // Тонкие ли руки — угадываем по картинке, галочку можно поправить.
        slim.checked = checked.slim;
        UI.setLoading(uploadBtn, true);
        try {
          data = await Api.players.uploadSkin(file, slim.checked);
          UI.toast('Скин загружен', { type: 'success' });
          draw();
        } catch (err) {
          UI.toast(err.message, { type: 'error' });
          UI.setLoading(uploadBtn, false);
        }
      }
      input.addEventListener('change', () => {
        upload(input.files[0]);
        input.value = '';
      });
      slim.addEventListener('change', async () => {
        viewer.set({ slim: slim.checked });
        if (!skin) return;
        try {
          data = await Api.players.setSkinModel(slim.checked);
          UI.toast(slim.checked ? 'Тонкие руки' : 'Обычные руки', { type: 'success' });
          draw();
        } catch (err) {
          UI.toast(err.message, { type: 'error' });
        }
      });

      const remove =
        skin &&
        h('button', {
          class: 'btn btn--ghost',
          type: 'button',
          text: 'Как в игре',
          title: 'Убрать свой скин и брать скин из игры',
          onclick: async () => {
            const ok = await UI.confirm({ title: 'Брать скин из игры?', text: 'Свой скин с сайта уберётся — и здесь, и на сервере. Карточка будет сама показывать скин, который у вас в Minecraft.', confirmText: 'Да, как в игре' });
            if (!ok) return;
            try {
              data = await Api.players.removeSkin();
              UI.toast('Теперь скин — как в игре');
              draw();
            } catch (err) {
              UI.toast(err.message, { type: 'error' });
            }
          },
        });

      // Скин по нику лицензии — как `/skin set <ник>` в игре.
      const nickForm = h('form', { class: 'skin-nick', novalidate: true });
      const nickField = UI.field({ label: 'Скин по нику', name: 'skin-nick', value: skin && skin.nick ? skin.nick : '', placeholder: 'Ник лицензии, например Notch', hint: 'Есть лицензия — впишите свой ник, скин будет как в лаунчере.', attrs: { autocomplete: 'off', spellcheck: 'false', maxlength: '16' } });
      const nickBtn = h('button', { class: 'btn btn--secondary', type: 'submit', text: 'Взять скин' });
      UI.append(nickForm, [h('div', { class: 'skin-nick__row' }, nickField, nickBtn)]);
      nickForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        UI.clearErrors(nickForm);
        UI.setLoading(nickBtn, true);
        try {
          data = await Api.players.skinByNick(nickForm.elements['skin-nick'].value);
          UI.toast(`Скин как у ${data.skin.nick}`, { type: 'success' });
          draw();
        } catch (err) {
          if (!UI.setFieldError(nickForm, 'skin-nick', (err.fields && err.fields.nickname) || err.message)) UI.toast(err.message, { type: 'error' });
          UI.setLoading(nickBtn, false);
        }
      });

      const drop = h(
        'div',
        { class: 'skin-drop' },
        paintBackground(h('div', { class: 'pdetail__stage skin-drop__stage' }, viewer.el), p),
        h(
          'div',
          { class: 'skin-drop__side' },
          h('p', { class: 'card-sub', text: 'Покрутите персонажа мышью или пальцем. Файл — PNG 64×64 (или старый 64×32), до 64 КБ: например, кнопка «Download» на NameMC.' }),
          nickForm,
          h('div', { class: 'actions-row' }, input, uploadBtn, remove),
          slimBox,
          status
        )
      );
      // Можно бросить файл прямо на персонажа.
      drop.addEventListener('dragover', (e) => {
        e.preventDefault();
        drop.classList.add('is-over');
      });
      drop.addEventListener('dragleave', () => drop.classList.remove('is-over'));
      drop.addEventListener('drop', (e) => {
        e.preventDefault();
        drop.classList.remove('is-over');
        upload(e.dataTransfer.files[0]);
      });

      return h('section', { class: 'card card--pad' }, h('h2', { class: 'card-title', text: 'Мой скин' }), h('div', { class: 'card-content' }, drop));
    }

    function checkbox(label, hint, checked, onChange) {
      const input = h('input', { type: 'checkbox', checked, onchange: (e) => onChange(e.target.checked) });
      return h('label', { class: 'checkbox checkbox--hint' }, input, h('span', null, h('span', { class: 'checkbox__label', text: label }), h('span', { class: 'checkbox__hint', text: hint })));
    }

    load();
    return root;
  }

  window.Players = {
    card,
    openDetails,
    mount,
    showcase,
    editor,
    /** fn() → может ли текущий человек убирать чужие картинки фона (кабинет: право «Люди»). */
    allowModeration: (fn) => {
      canModerate = fn;
    },
    format: { hours, distance, num },
  };
})();
