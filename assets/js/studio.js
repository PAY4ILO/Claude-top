/*
 * Студия персонажа (кабинет, #/studio): как стоит персонаж на карточках — отдельно на маленькой карточке (card)
 * и в окне игрока (detail).
 *   Слева — рабочая сцена (Skin3D.poser в режиме scene): тянуть пустое место — повернуть камеру, колёсико — приблизить,
 *     правая кнопка — сдвинуть кадр; нажать на часть тела, предмет, блок или моба — появятся ручки; двойное нажатие
 *     на персонажа — выбрать его целиком (двигать по сцене, вращать, менять размер).
 *     Кнопка «Камера карточки» — сцена через камеру вида в рамке размера карточки: так её и увидят; тянуть — повернуть,
 *     колёсико — приблизить, правая кнопка — сдвинуть кадр (это сохраняется в look.camera / scale / offset).
 *   В середине — как это увидят другие: маленькая карточка и окно игрока (рисует players.js). Нажатие — править этот вид.
 *   Справа — инструменты: «Поза», «Предметы», «Блоки», «Мобы», «Камера», «Свои картинки».
 * Предметы, блоки, головы и мобы — модели самой игры (McArt, assets/js/mc-art.js; McMobs, assets/js/mc-mobs.js).
 * Если McArt на странице нет, поза и камера работают, а во вкладках предметов, блоков и мобов — пояснение,
 * что каталог Minecraft не загружен.
 * Сохраняется по кнопке: «Сохранить» — открытый вид, «Сохранить обе» — оба. Ctrl+Z / Ctrl+Y — отменить / вернуть.
 *
 *   Studio.mount(root) → { destroy(), dirty() }
 */
(function () {
  'use strict';

  const { h, icon, clear } = UI;
  const LOOK = Api.LOOK;
  const VIEWS = Object.keys(LOOK.views);
  // Камера в начале — как на маленькой карточке и как в окне игрока (players.js, skin3d.js).
  const CAMERA = { card: { yaw: 28, pitch: 8 }, detail: { yaw: 25, pitch: 10 } };
  // Сцена в начале чуть отдалена: видно и персонажа, и блоки вокруг.
  const SCENE_ZOOM = 0.6;
  const PAGE_SIZE = 48;
  const HISTORY_MAX = 100;

  // Подписи осей для каждой части; знак — чтобы «вправо» на ползунке значило «вперёд» / «в сторону от тела».
  const AXES = {
    head: [['Кивок', 1], ['Поворот', 1], ['Наклон к плечу', 1]],
    body: [['Наклон вперёд', 1], ['Поворот', 1], ['Наклон вбок', 1]],
    rightArm: [['Вперёд — назад', -1], ['Вращение', 1], ['В сторону', -1]],
    leftArm: [['Вперёд — назад', -1], ['Вращение', 1], ['В сторону', 1]],
    rightLeg: [['Вперёд — назад', -1], ['Вращение', 1], ['В сторону', -1]],
    leftLeg: [['Вперёд — назад', -1], ['Вращение', 1], ['В сторону', 1]],
  };
  const SLOTS = { rightHand: 'Правая рука', leftHand: 'Левая рука', head: 'Голова' };
  const SLOT_TO = { rightHand: 'в правую руку', leftHand: 'в левую руку', head: 'на голову' };
  const TABS = { pose: 'Поза', items: 'Предметы', blocks: 'Блоки', mobs: 'Мобы', camera: 'Камера', textures: 'Свои картинки' };
  const TOOLS = { select: 'Выбрать', place: 'Ставить', break: 'Убрать' };
  // Ручки на сцене, как в Blockbench: [подпись, клавиша, значок].
  const MODES = { move: ['Двигать', 'V', 'move'], rotate: ['Вращать', 'R', 'retry'], scale: ['Растянуть', 'S', 'scale'] };
  const PART_LABEL = Object.fromEntries(Skin3D.PARTS.map((p) => [p.key, p.label]));
  const PART_KEYS = new Set(Object.keys(PART_LABEL));
  const mobs = () => window.McMobs || null;

  const clone = (x) => JSON.parse(JSON.stringify(x));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const round = (x, k = 1) => Math.round(x * k) / k;
  const isTex = (id) => /^tex[1-3]$/.test(id);
  const isHead = (id) => LOOK.heads.includes(id);
  /** Поворот моба [x, y, z]; у старых — одно число (вокруг вертикали). */
  const rotArr = (r) => (Array.isArray(r) ? [0, 1, 2].map((i) => Number(r[i]) || 0) : [0, Number(r) || 0, 0]);
  const art = () => (window.McArt && typeof window.McArt.model === 'function' ? window.McArt : null);
  // Ключи выбранного — как в Skin3D.poser: часть тела, 'figure', 'held:<слот>', 'block:<i>', 'mob:<i>', 'mob:<i>:<часть>'.
  const kindOf = (key) =>
    !key ? null : PART_KEYS.has(key) ? 'part' : key === 'figure' ? 'figure' : key.startsWith('held:') ? 'held' : key.startsWith('block:') ? 'block' : key.startsWith('mob:') ? (key.split(':').length === 3 ? 'mobpart' : 'mob') : null;
  /** Номер моба в ключе 'mob:<i>' и 'mob:<i>:<часть>'. */
  const mobIndex = (key) => Number(key.split(':')[1]);
  const mobLabel = (type) => {
    const t = mobs() && mobs().TYPES.find((x) => x.key === type);
    return t ? t.label : type;
  };
  /** 12,5 — с запятой, без лишних нулей. */
  const num = (v) => String(round(v, 10)).replace('.', ',').replace('-', '−');

  /** Несохранённое, когда из студии ушли по ссылке меню: вернувшись, человек увидит свои правки. */
  let draft = null;

  /* ------------------------------------------------------------ вид look: как хранит сервер */

  /** Как server/lib/validate.js → normalizeLook: округлить, лишнее выбросить (тот же порядок ключей). */
  function normalize(v) {
    const out = { pose: v.pose, scale: v.scale === undefined ? 1 : round(v.scale, 100), turn: v.turn === undefined ? 0 : round(v.turn) };
    if (v.pose === 'custom') out.angles = normAngles(v.angles);
    const offset = v.offset ? v.offset.map((x) => round(x, 10)) : null;
    if (offset && offset.some((x) => x)) out.offset = offset;
    if (v.camera) out.camera = { yaw: round(v.camera.yaw), pitch: round(v.camera.pitch) };
    const pos = v.pos ? v.pos.map((x) => round(x, 10)) : null;
    if (pos && pos.some((x) => x)) out.pos = pos;
    if (v.size !== undefined && round(v.size, 100) !== 1) out.size = round(v.size, 100);
    if (v.textures && v.textures.length) out.textures = [...v.textures];
    const withSkin = (o, e) => (typeof e.skin === 'string' ? { ...o, skin: e.skin } : o);
    if (v.held) {
      const held = {};
      for (const slot of LOOK.slots) {
        const e = v.held[slot];
        if (!e) continue;
        held[slot] = withSkin({ id: e.id, rot: (e.rot || [0, 0, 0]).map((x) => round(x)), size: e.size === undefined ? 1 : round(e.size, 100), at: (e.at || [0, 0, 0]).map((x) => round(x, 10)) }, e);
      }
      if (Object.keys(held).length) out.held = held;
    }
    if (v.blocks && v.blocks.length) out.blocks = v.blocks.map((b) => withSkin({ id: b.id, at: b.at.map((x) => round(x, 10)), rot: rotArr(b.rot).map((x) => round(x)), size: b.size === undefined ? 1 : round(b.size, 100) }, b));
    if (v.mobs && v.mobs.length) {
      out.mobs = v.mobs.map((m) => {
        const rot = Array.isArray(m.rot) ? m.rot.map((x) => round(x)) : [0, m.rot === undefined ? 0 : round(m.rot), 0];
        let o = withSkin({ type: m.type, at: m.at.map((x) => round(x, 10)), rot, size: m.size === undefined ? 1 : round(m.size, 100), pose: m.pose || 'stand' }, m);
        if (m.type === 'player' && m.slim) o = { ...o, slim: true };
        if (m.pose === 'custom') o.angles = normAngles(m.angles);
        return o;
      });
    }
    return out;
  }

  /** Углы своей позы — как normalizeAngles в server/lib/validate.js. */
  function normAngles(src) {
    const a = src || Skin3D.poseAngles('stand');
    const out = { lift: a.lift === undefined ? 0 : round(a.lift) };
    for (const part of LOOK.parts) out[part] = (a[part] || [0, 0, 0]).map((x) => round(x));
    const move = {};
    for (const part of LOOK.parts) {
      const m = a.move && a.move[part];
      if (m && m.some((x) => round(x, 10))) move[part] = m.map((x) => round(x, 10));
    }
    if (Object.keys(move).length) out.move = move;
    const stretch = {};
    for (const part of LOOK.parts) {
      const k = a.stretch && a.stretch[part];
      if (k && k.some((x) => round(x, 100) !== 1)) stretch[part] = k.map((x) => round(x, 100));
    }
    if (Object.keys(stretch).length) out.stretch = stretch;
    return out;
  }
  const keyOf = (look) => JSON.stringify(normalize(look));

  /**
   * Рабочая копия вида: всё, что нужно редактору, на месте. У старых видов (без camera) поворот turn крутил камеру —
   * переводим в свою камеру вида с тем же углом, а фигура больше не повёрнута: картинка та же.
   */
  function prepare(look, view) {
    const l = clone(look || { pose: 'stand' });
    if (l.pose !== 'custom' && !Object.hasOwn(Api.CARD_POSES, l.pose)) l.pose = 'stand';
    if (typeof l.scale !== 'number') l.scale = 1;
    if (typeof l.turn !== 'number') l.turn = 0;
    if (!l.camera || typeof l.camera !== 'object') {
      const base = CAMERA[view] || CAMERA.card;
      l.camera = { yaw: round(((((base.yaw + l.turn + 180) % 360) + 360) % 360) - 180), pitch: base.pitch };
      l.turn = 0;
    }
    if (l.pose === 'custom' && !l.angles) l.angles = Skin3D.poseAngles('stand');
    if (l.angles && typeof l.angles.lift !== 'number') l.angles.lift = 0;
    if (l.pose !== 'custom') delete l.angles;
    return l;
  }

  /* ------------------------------------------------------------ свои картинки */

  function loadImage(file) {
    return new Promise((resolve, reject) => {
      if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) return reject(new Error('Подойдёт PNG, JPG, WebP или GIF.'));
      if (file.size > 8 * 1024 * 1024) return reject(new Error('Файл больше 8 МБ.'));
      const url = URL.createObjectURL(file);
      const img = new Image();
      img.onload = () => {
        URL.revokeObjectURL(url);
        resolve(img);
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        reject(new Error('Не получилось открыть картинку.'));
      };
      img.src = url;
    });
  }

  /**
   * Квадрат картинки → холст N×N. crisp — ближайшая точка (пиксель-арт), иначе плавно, уменьшая вдвое за шаг.
   * Если квадрат меньше N — увеличивает (чётко или плавно, так же).
   */
  function downscale(img, sx, sy, side, crisp, N) {
    let src = img;
    let x = sx;
    let y = sy;
    let s = side;
    if (!crisp) {
      while (s > N * 2) {
        const n = Math.max(N, Math.ceil(s / 2));
        const c = document.createElement('canvas');
        c.width = c.height = n;
        const g = c.getContext('2d');
        g.imageSmoothingEnabled = true;
        g.imageSmoothingQuality = 'high';
        g.drawImage(src, x, y, s, s, 0, 0, n, n);
        src = c;
        x = 0;
        y = 0;
        s = n;
      }
    }
    const out = document.createElement('canvas');
    out.width = out.height = N;
    const g = out.getContext('2d');
    g.imageSmoothingEnabled = !crisp;
    g.imageSmoothingQuality = 'high';
    g.drawImage(src, x, y, s, s, 0, 0, N, N);
    return out;
  }

  const toPng = (canvas) => new Promise((resolve) => canvas.toBlob((b) => resolve(b), 'image/png'));

  /**
   * Окно «Какую часть взять»: квадрат двигают мышью, пальцем или стрелками, приближают колёсиком, ползунком, + и −.
   * Размер — «как есть» (сколько точек в выбранном квадрате, не больше LOOK.textures.maxSide) или меньше: 256…16.
   * Рядом — как получится. Возвращает Promise<{ blob (PNG), size }> или null («Отмена»).
   * Получилось больше LOOK.textures.bytes — размер уменьшается вдвое, пока не влезет (reduced: true).
   */
  function cropTexture(img) {
    const iw = img.naturalWidth;
    const ih = img.naturalHeight;
    const MAX = LOOK.textures.maxSide;
    const MAX_ZOOM = clamp(Math.min(iw, ih) / 4, 1, 32);
    let zoom = 1;
    let cx = iw / 2;
    let cy = ih / 2;
    // 'native' — разрешение самой картинки (выбранного квадрата), иначе число точек по стороне.
    let res = 'native';
    const side = () => Math.min(iw, ih) / zoom;
    const nativeSize = () => clamp(Math.round(side()), 1, MAX);
    const outSize = () => (res === 'native' ? nativeSize() : Math.min(res, nativeSize() * 8, MAX));
    const fix = () => {
      const half = side() / 2;
      cx = clamp(cx, half, iw - half);
      cy = clamp(cy, half, ih - half);
    };

    const canvas = h('canvas', { class: 'crop__canvas' });
    const grid = h('div', { class: 'studio-crop__grid', 'aria-hidden': 'true' });
    const stage = h(
      'div',
      { class: 'crop__stage studio-crop__stage', tabindex: '0', autofocus: true, role: 'img', 'aria-label': 'Картинка. Перетащите, чтобы выбрать часть; стрелки — сдвиг, плюс и минус — масштаб.' },
      canvas,
      grid
    );
    const preview = h('canvas', { class: 'studio-crop__preview', width: '16', height: '16', role: 'img', 'aria-label': 'Как получится' });
    const sizeText = h('p', { class: 'field__hint' });
    const range = h('input', { class: 'crop__range', type: 'range', min: '1', max: String(MAX_ZOOM), step: '0.01', value: '1', 'aria-label': 'Масштаб' });
    const crisp = h('input', { type: 'checkbox', checked: Math.min(iw, ih) <= 64 });
    const sizes = h('div', { class: 'chips chips--sm', role: 'radiogroup', 'aria-label': 'Размер картинки' });
    const zoomBtn = (name, label, k) => h('button', { class: 'icon-btn', type: 'button', 'aria-label': label, onclick: () => setZoom(zoom * k) }, icon(name));
    const done = h('button', { class: 'btn', type: 'button', text: 'Готово' });
    const content = h(
      'div',
      { class: 'crop studio-crop' },
      h('div', { class: 'studio-crop__row' }, stage, h('div', { class: 'studio-crop__side' }, h('p', { class: 'field__label', text: 'Получится' }), preview, sizeText)),
      h('div', { class: 'crop__controls' }, zoomBtn('minus', 'Отдалить', 1 / 1.25), range, zoomBtn('plus', 'Приблизить', 1.25)),
      h('div', { class: 'studio-crop__sizes' }, h('p', { class: 'field__label', text: 'Размер' }), sizes),
      h('label', { class: 'checkbox' }, crisp, h('span', { text: 'Чёткие пиксели — для пиксель-арта и скинов' })),
      h('div', { class: 'modal__actions' }, h('button', { class: 'btn btn--ghost', type: 'button', text: 'Отмена', onclick: () => m.close() }), done)
    );

    /** Варианты размера: «как есть» и меньше — 256, 128, 64, 32, 16 (что меньше самой картинки). */
    function drawSizes() {
      const n = nativeSize();
      const options = [['native', `Как есть, ${n} × ${n}`], ...[256, 128, 64, 32, 16].filter((v) => v < n).map((v) => [v, `${v} × ${v}`])];
      if (res !== 'native' && res >= n) res = 'native';
      clear(sizes).append(
        ...options.map(([v, label]) =>
          h('button', {
            class: 'chip',
            type: 'button',
            role: 'radio',
            'aria-checked': String(v === res),
            text: label,
            onclick: () => {
              res = v;
              drawSizes();
              draw();
            },
          })
        )
      );
    }

    function draw() {
      const rect = stage.getBoundingClientRect();
      const px = Math.max(1, Math.round(rect.width * (window.devicePixelRatio || 1)));
      if (canvas.width !== px) canvas.width = canvas.height = px;
      const g = canvas.getContext('2d');
      g.imageSmoothingEnabled = !crisp.checked;
      g.imageSmoothingQuality = 'high';
      const s = side();
      g.clearRect(0, 0, px, px);
      g.drawImage(img, cx - s / 2, cy - s / 2, s, s, 0, 0, px, px);
      const N = outSize();
      const small = downscale(img, cx - s / 2, cy - s / 2, s, crisp.checked, N);
      if (preview.width !== N) preview.width = preview.height = N;
      const pg = preview.getContext('2d');
      pg.clearRect(0, 0, N, N);
      pg.drawImage(small, 0, 0);
      sizeText.textContent = `${N} × ${N} точек`;
      // Сетка точек поверх — только пока точки крупные (до 32 по стороне), иначе она бы закрыла картинку.
      grid.hidden = N > 32;
      grid.style.backgroundSize = `${100 / N}% ${100 / N}%`;
    }
    function setZoom(z) {
      zoom = clamp(z, 1, MAX_ZOOM);
      range.value = String(zoom);
      fix();
      drawSizes();
      draw();
    }
    function pan(dx, dy) {
      const k = side() / (stage.getBoundingClientRect().width || 1);
      cx -= dx * k;
      cy -= dy * k;
      fix();
      draw();
    }
    range.addEventListener('input', () => setZoom(Number(range.value)));
    crisp.addEventListener('change', draw);
    stage.addEventListener(
      'wheel',
      (e) => {
        e.preventDefault();
        setZoom(zoom * Math.exp(-e.deltaY * 0.0015));
      },
      { passive: false }
    );
    stage.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 40 : 10;
      const moves = { ArrowLeft: [step, 0], ArrowRight: [-step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
      if (moves[e.key]) pan(...moves[e.key]);
      else if (e.key === '+' || e.key === '=') setZoom(zoom * 1.1);
      else if (e.key === '-') setZoom(zoom / 1.1);
      else return;
      e.preventDefault();
    });
    let last = null;
    stage.addEventListener('pointerdown', (e) => {
      stage.setPointerCapture(e.pointerId);
      last = [e.clientX, e.clientY];
      stage.classList.add('is-dragging');
    });
    stage.addEventListener('pointermove', (e) => {
      if (!last) return;
      pan(e.clientX - last[0], e.clientY - last[1]);
      last = [e.clientX, e.clientY];
    });
    const up = () => {
      last = null;
      stage.classList.remove('is-dragging');
    };
    stage.addEventListener('pointerup', up);
    stage.addEventListener('pointercancel', up);

    const resize = new ResizeObserver(draw);
    let result = null;
    let m;
    const promise = new Promise((resolve) => {
      m = UI.modal({
        title: 'Какую часть картинки взять',
        content,
        onClose: () => {
          resize.disconnect();
          resolve(result);
        },
      });
    });
    done.addEventListener('click', async () => {
      done.disabled = true;
      const s = side();
      let N = outSize();
      let blob = await toPng(downscale(img, cx - s / 2, cy - s / 2, s, crisp.checked, N));
      let reduced = false;
      // Пёстрая фотография в PNG бывает тяжёлой — уменьшаем, пока не влезет в лимит сайта.
      while (blob && blob.size > LOOK.textures.bytes && N > 16) {
        N = Math.max(16, Math.round(N / 2));
        blob = await toPng(downscale(img, cx - s / 2, cy - s / 2, s, crisp.checked, N));
        reduced = true;
      }
      done.disabled = false;
      if (!blob) return UI.toast('Не получилось сохранить картинку.', { type: 'error' });
      result = { blob, size: N, reduced };
      m.close();
    });
    resize.observe(stage);
    drawSizes();
    draw();
    return promise;
  }

  /* ------------------------------------------------------------ студия */

  function mount(root) {
    let alive = true;
    const S = {
      data: null,
      looks: null,
      saved: {},
      view: 'card',
      sel: 'rightArm',
      part: 'rightArm',
      tab: 'pose',
      tool: 'select',
      mode: 'rotate',
      slot: 'rightHand',
      brush: null,
      brushSize: 1,
      // Голова игрока, которую ставят блоком, — чья (skin), и кого ставят на сцену во вкладке «Мобы».
      brushSkin: null,
      mob: 'zombie',
      mobSkin: null,
      mobSlim: false,
      grid: true,
      cameraMode: false,
      saving: false,
      pal: { items: { query: '', kind: 'all', page: 0 }, blocks: { query: '', page: 0 } },
    };
    // Чей это скин (sha256 → ник): для подписей у голов и игроков на сцене.
    const skinNames = new Map();
    let lwlPlayers = null;
    const undoStack = [];
    const redoStack = [];
    let lastGroup = null;
    let groupTimer = 0;

    // Части страницы (появляются в build()).
    let poser = null;
    let viewer = null;
    let figureEl = null;
    let panel = null;
    let tabs = [];
    let bar = null;
    let previewEls = [];
    let selectionEl = null;
    let hintEl = null;
    let toolBadge = null;
    let modesEl = null;
    let resize = null;
    // Ползунки и кнопки, которые надо подвинуть, когда меняют на сцене или отменяют.
    let sync = [];
    let syncPoseChips = null;

    const cur = () => S.looks[S.view];
    const other = () => (S.view === 'card' ? 'detail' : 'card');
    const isDirty = (v) => !!S.looks && keyOf(S.looks[v]) !== S.saved[v];
    const anyDirty = () => !!S.looks && VIEWS.some(isDirty);
    const blocksOf = () => cur().blocks || [];
    const blockAt = (key) => blocksOf()[Number(key.slice(6))] || null;
    const mobsOf = () => cur().mobs || [];
    const mobAt = (key) => mobsOf()[mobIndex(key)] || null;
    const heldIn = (slot) => (cur().held && cur().held[slot]) || null;
    const headLabel = (id) => ((mobs() && mobs().HEADS.find((x) => x.id === id)) || {}).label || id;
    const labelOf = (id) => (isTex(id) ? `Своя картинка ${id.slice(3)}` : isHead(id) ? headLabel(id) : art() ? art().label(id) : id);
    /** Чей скин: «Стив», ник игрока LWL или лицензии, иначе «скин игрока». */
    const skinLabel = (skin) => (!skin ? 'Стив' : /^(wide|slim)\//.test(skin) ? (mobs() ? mobs().skinLabel(skin) : skin) : skinNames.get(skin) || 'скин игрока');
    const entryLabel = (e) => (e.id === 'player_head' ? `Голова: ${skinLabel(e.skin)}` : labelOf(e.id));

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

    function load() {
      clear(root).append(h('div', { class: 'card card--pad' }, h('div', { class: 'skeleton-list', 'aria-hidden': 'true' }, h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }))));
      Api.players
        .myCard()
        .then((d) => alive && start(d))
        .catch((err) => {
          if (!alive) return;
          clear(root).append(h('div', { class: 'card' }, stateBlock({ iconName: 'alert', error: true, title: 'Не удалось загрузить карточку', text: err.message, action: h('button', { class: 'btn', type: 'button', text: 'Повторить', onclick: load }) })));
        });
    }

    function start(d) {
      if (!d.card) {
        clear(root).append(h('div', { class: 'card' }, stateBlock({ iconName: 'user', title: 'Карточки пока нет', text: 'Она появится вместе со скином — загляните в профиль.', action: h('a', { class: 'btn', href: '#/profile', text: 'В профиль' }) })));
        return;
      }
      S.data = d;
      S.looks = { card: prepare(d.looks.card, 'card'), detail: prepare(d.looks.detail, 'detail') };
      for (const v of VIEWS) S.saved[v] = keyOf(S.looks[v]);
      // Ушли со студии, не сохранив, а на сервере с тех пор ничего не менялось — возвращаем правки.
      let restored = false;
      if (draft && VIEWS.every((v) => draft.saved[v] === S.saved[v])) {
        S.looks = clone(draft.looks);
        S.view = draft.view;
        restored = true;
      }
      draft = null;
      build();
      if (restored) {
        UI.toast('Вернули несохранённые изменения', {
          timeout: 8000,
          action: {
            label: 'Отбросить',
            onClick: () => {
              begin(null);
              for (const v of VIEWS) S.looks[v] = prepare(S.data.looks[v], v);
              refreshAll();
            },
          },
        });
      }
    }

    /* ---------------------------------------------------- история: отменить / вернуть */

    const snapshot = () => ({ view: S.view, looks: clone(S.looks), sel: S.sel });

    /** Перед изменением: запомнить, как было. group — серия (ползунок): её шаги в пределах 0,6 с — одна отмена. */
    function begin(group) {
      clearTimeout(groupTimer);
      if (!group || group !== lastGroup) {
        undoStack.push(snapshot());
        if (undoStack.length > HISTORY_MAX) undoStack.shift();
        redoStack.length = 0;
      }
      lastGroup = group || null;
      if (group) groupTimer = setTimeout(() => (lastGroup = null), 600);
    }
    const endGroup = () => {
      clearTimeout(groupTimer);
      lastGroup = null;
    };

    function restore(s) {
      S.looks = s.looks;
      S.view = s.view;
      S.sel = s.sel;
      endGroup();
      refreshAll();
    }
    function undo() {
      const prev = undoStack.pop();
      if (!prev) return false;
      redoStack.push(snapshot());
      restore(prev);
      return true;
    }
    function redo() {
      const next = redoStack.pop();
      if (!next) return false;
      undoStack.push(snapshot());
      restore(next);
      return true;
    }

    /* ---------------------------------------------------- обновления */

    let pending = 0;
    function schedule() {
      if (!pending) pending = requestAnimationFrame(flush);
    }
    function flush() {
      pending = 0;
      if (!alive || !S.looks) return;
      if (figureEl) figureEl.update(S.looks.card);
      if (viewer) viewer.set({ look: S.looks.detail });
      syncBar();
    }

    /** После каждого шага изменений: сцена, ползунки, предпросмотр, «не сохранено». */
    function changed() {
      if (poser) poser.set({ look: cur() });
      sync.forEach((f) => f());
      if (syncPoseChips) syncPoseChips();
      syncSelection();
      schedule();
    }

    /** Выбранное ещё есть? (после отмены, удаления, смены вида) */
    function validSel(key) {
      const kind = kindOf(key);
      if (kind === 'block') return blockAt(key) ? key : null;
      if (kind === 'mob') return mobAt(key) ? key : null;
      if (kind === 'mobpart') return mobAt(key) && mobAt(key).type === 'player' ? key : null;
      if (kind === 'held') return heldIn(key.slice(5)) ? key : null;
      return key;
    }

    /** Всё заново: другой вид или другая копия looks (отмена, сброс). */
    function refreshAll() {
      S.sel = validSel(S.sel);
      if (poser) poser.set({ look: cur(), part: S.sel });
      renderTools();
      changed();
    }

    function setView(v) {
      if (v === S.view || !S.looks) return;
      S.view = v;
      endGroup();
      S.sel = validSel(S.sel);
      poser.set({ look: cur(), camera: CAMERA[v], part: S.sel });
      renderTools();
      changed();
      flush();
    }

    function select(key, fromScene) {
      S.sel = key;
      const kind = kindOf(key);
      if (kind === 'part' || kind === 'figure') {
        S.part = key;
        if (fromScene) S.tab = 'pose';
      } else if (kind === 'held') {
        S.slot = key.slice(5);
        if (fromScene) S.tab = 'items';
      } else if (kind === 'block' && fromScene) S.tab = 'blocks';
      else if ((kind === 'mob' || kind === 'mobpart') && fromScene) S.tab = 'mobs';
      if (!fromScene) poser.set({ part: key });
      renderTools();
      syncSelection();
    }

    /** Двигать / вращать / растянуть — какие ручки у выбранного на сцене. */
    function setMode(mode) {
      S.mode = mode;
      if (S.tool !== 'select') setTool('select');
      if (S.cameraMode) setCameraMode(false);
      if (poser) poser.set({ mode });
      if (modesEl) modesEl.querySelectorAll('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
    }

    function setTool(tool) {
      if (!art() && tool !== 'select') return;
      S.tool = tool;
      S.toolTab = tool === 'select' ? null : S.tab;
      if (tool !== 'select' && S.cameraMode) setCameraMode(false);
      if (poser) poser.set({ tool });
      if (panel) panel.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
      syncSelection();
    }

    /** «Камера карточки»: сцена через камеру открытого вида, в рамке размера карточки. */
    function setCameraMode(on) {
      S.cameraMode = !!on;
      if (on && S.tool !== 'select') {
        S.tool = 'select';
        if (poser) poser.set({ tool: 'select' });
      }
      if (poser) {
        poser.set({ cameraMode: S.cameraMode });
        const stage = poser.el.closest('.studio__stage');
        if (stage) stage.classList.toggle('is-camera', S.cameraMode);
      }
      document.querySelectorAll('[data-camera-toggle]').forEach((b) => b.setAttribute('aria-pressed', String(S.cameraMode)));
      syncSelection();
    }

    /** Рамка карточки для режима камеры: пропорции и приближение — как у настоящей карточки и окна игрока. */
    function frameOf() {
      if (S.view === 'card') return { aspect: 320 / 270, viewZoom: 190 / 270, ...CAMERA.card };
      const c = viewer && viewer.canvas;
      const aspect = c && c.clientWidth && c.clientHeight ? c.clientWidth / c.clientHeight : 1.4;
      return { aspect, viewZoom: 1, ...CAMERA.detail };
    }

    /* ---------------------------------------------------- действия */

    function pickPose(key) {
      const look = cur();
      if (key === look.pose) return;
      begin(null);
      if (key === 'custom') {
        look.angles = Skin3D.poseAngles(look.pose);
        look.pose = 'custom';
      } else {
        // Готовая поза: предметы, блоки, размер и сдвиг остаются.
        look.pose = key;
        delete look.angles;
      }
      changed();
    }

    function ensureCustom() {
      const look = cur();
      if (look.pose === 'custom') return;
      look.angles = Skin3D.poseAngles(look.pose);
      look.pose = 'custom';
    }

    function assignHeld(slot, id, skin) {
      begin(null);
      const look = cur();
      look.held = look.held || {};
      const prev = look.held[slot];
      look.held[slot] = { id, rot: prev ? prev.rot.slice() : [0, 0, 0], size: prev ? prev.size : 1, at: prev ? prev.at.slice() : [0, 0, 0] };
      // Голова игрока: чья — переданная или та же, что была.
      const s = skin !== undefined ? skin : prev && prev.id === 'player_head' ? prev.skin : null;
      if (id === 'player_head' && s) look.held[slot].skin = s;
      S.slot = slot;
      S.sel = 'held:' + slot;
      poser.set({ look, part: S.sel });
      changed();
    }

    function removeHeld(slot) {
      const look = cur();
      if (!look.held || !look.held[slot]) return;
      begin(null);
      delete look.held[slot];
      if (!Object.keys(look.held).length) delete look.held;
      if (S.sel === 'held:' + slot) S.sel = null;
      poser.set({ look, part: S.sel });
      changed();
    }

    function addBlock(b) {
      const look = cur();
      if (blocksOf().length >= LOOK.blocks.max) {
        UI.toast(`Больше ${LOOK.blocks.max} блоков поставить нельзя.`, { type: 'error' });
        return false;
      }
      begin(null);
      look.blocks = look.blocks || [];
      look.blocks.push(b);
      S.sel = 'block:' + (look.blocks.length - 1);
      poser.set({ look, part: S.sel });
      changed();
      return true;
    }

    function removeBlock(i) {
      const look = cur();
      if (!look.blocks || !look.blocks[i]) return;
      begin(null);
      look.blocks.splice(i, 1);
      if (!look.blocks.length) delete look.blocks;
      if (kindOf(S.sel) === 'block') {
        const j = Number(S.sel.slice(6));
        S.sel = j === i ? null : j > i ? 'block:' + (j - 1) : S.sel;
      }
      poser.set({ look, part: S.sel });
      changed();
    }

    function addMob(m) {
      const look = cur();
      if (mobsOf().length >= LOOK.mobs.max) {
        UI.toast(`Больше ${LOOK.mobs.max} мобов поставить нельзя.`, { type: 'error' });
        return false;
      }
      begin(null);
      look.mobs = look.mobs || [];
      look.mobs.push(m);
      S.sel = 'mob:' + (look.mobs.length - 1);
      poser.set({ look, part: S.sel });
      changed();
      return true;
    }

    function removeMob(i) {
      const look = cur();
      if (!look.mobs || !look.mobs[i]) return;
      begin(null);
      look.mobs.splice(i, 1);
      if (!look.mobs.length) delete look.mobs;
      if (kindOf(S.sel) === 'mob' || kindOf(S.sel) === 'mobpart') {
        const j = mobIndex(S.sel);
        S.sel = j === i ? null : j > i ? S.sel.replace(/^mob:d+/, 'mob:' + (j - 1)) : S.sel;
      }
      poser.set({ look, part: S.sel });
      changed();
    }

    /** Новый моб — кого и в какой позе (у человекоподобных по умолчанию — как в игре: зомби руки вперёд). */
    function newMob(at, rot) {
      const def = mobs() && mobs().mob(S.mob);
      const m = { type: S.mob, at, rot: [0, Number(rot) || 0, 0], size: 1, pose: (def && def.pose) || 'stand' };
      if (S.mob === 'player') {
        if (S.mobSkin) m.skin = S.mobSkin;
        if (S.mobSlim || /^slim\//.test(S.mobSkin || '')) m.slim = true;
      }
      return m;
    }

    /** Где встанет новый моб: на верх блока под мышью или на пол (по сетке — в середину клетки). */
    function mobTarget(u) {
      if (mobsOf().length >= LOOK.mobs.max || !u) return null;
      let at;
      if (kindOf(u.key) === 'block' && u.normal && u.normal[1] > 0.7) {
        const b = blockAt(u.key);
        if (!b) return null;
        at = [b.at[0], b.at[1] + 16 * (b.size || 1), b.at[2]];
      } else if (u.ground) {
        const step = S.grid ? 16 : 1;
        at = [Math.round(u.ground[0] / step) * step, 0, Math.round(u.ground[2] / step) * step];
      } else return null;
      at = at.map((x) => round(x, 10) || 0);
      const M = LOOK.mobs;
      if (Math.abs(at[0]) > M.side || Math.abs(at[2]) > M.side || at[1] < M.y[0] || at[1] > M.y[1]) return null;
      return { at, rot: 0, size: 1, mob: true };
    }

    /** Где встанет новый блок: на грани блока под мышью или на полу. null — некуда. Во вкладке «Мобы» — моб. */
    function placeTarget(u) {
      if (S.tab === 'mobs') return mobTarget(u);
      const blocks = blocksOf();
      if (!S.brush || blocks.length >= LOOK.blocks.max || !u) return null;
      const size = S.brushSize;
      let at;
      let rot = 0;
      if (kindOf(u.key) === 'block' && u.normal) {
        const b = blocks[Number(u.key.slice(6))];
        if (!b) return null;
        const bs = b.size || 1;
        const n = u.normal;
        rot = rotArr(b.rot);
        if (Math.abs(n[1]) > 0.7) {
          at = [b.at[0], n[1] > 0 ? b.at[1] + 16 * bs : b.at[1] - 16 * size, b.at[2]];
        } else {
          // Сбоку: вдоль нормали грани (у повёрнутого блока она тоже повёрнута), вплотную.
          const len = Math.hypot(n[0], n[2]) || 1;
          const d = 8 * bs + 8 * size;
          at = [b.at[0] + (n[0] / len) * d, b.at[1], b.at[2] + (n[2] / len) * d];
        }
      } else if (u.ground) {
        const step = S.grid ? 16 * size : 1;
        at = [Math.round(u.ground[0] / step) * step, 0, Math.round(u.ground[2] / step) * step];
      } else return null;
      at = at.map((x) => round(x, 10) || 0);
      const B = LOOK.blocks;
      if (Math.abs(at[0]) > B.side || Math.abs(at[2]) > B.side || at[1] < B.y[0] || at[1] > B.y[1]) return null;
      return { at, rot, size };
    }

    function tap(u) {
      if (S.tool === 'break') {
        if (kindOf(u.key) === 'block') {
          removeBlock(Number(u.key.slice(6)));
          renderTools();
        } else if (kindOf(u.key) === 'mob' || kindOf(u.key) === 'mobpart') {
          removeMob(mobIndex(u.key));
          renderTools();
        }
        return;
      }
      if (S.tool !== 'place') return;
      if (S.tab === 'mobs') {
        if (mobsOf().length >= LOOK.mobs.max) return UI.toast(`Больше ${LOOK.mobs.max} мобов поставить нельзя.`, { type: 'error' });
        const t = mobTarget(u);
        if (!t) return UI.toast('Сюда не поставить: слишком далеко.');
        if (addMob(newMob(t.at, t.rot))) renderTools();
        return;
      }
      if (!S.brush) return UI.toast('Сначала выберите блок в палитре.');
      if (blocksOf().length >= LOOK.blocks.max) return UI.toast(`Больше ${LOOK.blocks.max} блоков поставить нельзя.`, { type: 'error' });
      const t = placeTarget(u);
      if (!t) return UI.toast('Сюда не поставить: слишком далеко от персонажа.');
      const b = { id: S.brush, at: t.at, rot: t.rot, size: t.size };
      if (S.brush === 'player_head' && S.brushSkin) b.skin = S.brushSkin;
      if (addBlock(b)) renderTools();
    }

    function removeSelected() {
      const kind = kindOf(S.sel);
      if (kind === 'block') removeBlock(Number(S.sel.slice(6)));
      else if (kind === 'mob' || kind === 'mobpart') removeMob(mobIndex(S.sel));
      else if (kind === 'held') removeHeld(S.sel.slice(5));
      else return false;
      renderTools();
      return true;
    }

    /** Убрать картинку texN: предметы и блоки с ней тоже убираются, номера картинок после неё сдвигаются. */
    function removeTexture(i) {
      const look = cur();
      if (!look.textures || !look.textures[i]) return;
      begin(null);
      const n = i + 1;
      const remap = (id) => {
        if (!isTex(id)) return id;
        const k = Number(id.slice(3));
        return k === n ? null : k > n ? 'tex' + (k - 1) : id;
      };
      look.textures.splice(i, 1);
      if (!look.textures.length) delete look.textures;
      if (look.held) {
        for (const slot of Object.keys(look.held)) {
          const e = look.held[slot];
          const id = e && remap(e.id);
          if (id) e.id = id;
          else delete look.held[slot];
        }
        if (!Object.keys(look.held).length) delete look.held;
      }
      if (look.blocks) {
        look.blocks = look.blocks.filter((b) => remap(b.id)).map((b) => ({ ...b, id: remap(b.id) }));
        if (!look.blocks.length) delete look.blocks;
      }
      if (S.brush && isTex(S.brush)) S.brush = remap(S.brush);
      S.sel = kindOf(S.sel) === 'part' ? S.sel : null;
      poser.set({ look, part: S.sel });
      changed();
    }

    async function addTexture(file) {
      let img;
      try {
        img = await loadImage(file);
      } catch (err) {
        UI.toast(err.message, { type: 'error' });
        return;
      }
      const picked = await cropTexture(img);
      if (!picked || !alive) return;
      if ((cur().textures || []).length >= LOOK.textures.max) {
        UI.toast(`Своих картинок — не больше ${LOOK.textures.max}.`, { type: 'error' });
        return;
      }
      // Картинка — отдельным файлом на сайте (в своём разрешении); в карточке — только её sha256.
      let uploaded;
      try {
        uploaded = await Api.players.uploadTexture(picked.blob);
      } catch (err) {
        if (alive) UI.toast(err.fields ? Object.values(err.fields)[0] : err.message, { type: 'error' });
        return;
      }
      if (!alive) return;
      const look = cur();
      begin(null);
      look.textures = [...(look.textures || []), uploaded.texture];
      changed();
      renderTools();
      UI.toast(
        picked.reduced
          ? `Картинка добавлена, но файл был слишком тяжёлым — уменьшена до ${picked.size} × ${picked.size}.`
          : `Картинка ${picked.size} × ${picked.size} добавлена — дайте её в руку, наденьте на голову или поставьте блоком.`,
        { type: 'success' }
      );
    }

    function copyToOther() {
      const o = other();
      begin(null);
      S.looks[o] = clone(cur());
      changed();
      UI.toast(`Всё скопировано в «${LOOK.views[o]}»`, { action: { label: 'Открыть', onClick: () => setView(o) } });
    }

    let errorBox = null;
    function showError(text) {
      if (!errorBox) return;
      errorBox.hidden = !text;
      errorBox.querySelector('.studio__error-text').textContent = text || '';
    }

    async function save(views) {
      if (S.saving || !S.looks) return;
      const todo = views.filter(isDirty);
      if (!todo.length) {
        UI.toast('Всё уже сохранено');
        return;
      }
      const looks = Object.fromEntries(todo.map((v) => [v, normalize(S.looks[v])]));
      const f = Api.validate.card({ looks });
      if (f.looks) {
        showError(f.looks);
        return;
      }
      S.saving = true;
      syncBar();
      try {
        const d = await Api.players.updateMyCard({ looks });
        if (!alive) return;
        S.data = d;
        for (const v of todo) S.saved[v] = keyOf(prepare(d.looks[v], v));
        showError('');
        UI.toast(todo.length > 1 ? 'Сохранено: карточка и окно игрока' : `Сохранено: ${LOOK.views[todo[0]].toLowerCase()}`, { type: 'success' });
      } catch (err) {
        if (!alive) return;
        if (err.fields && err.fields.looks) showError(err.fields.looks);
        else UI.toast(err.fields ? Object.values(err.fields)[0] : err.message, { type: 'error' });
      } finally {
        S.saving = false;
        if (alive) syncBar();
      }
    }

    /* ---------------------------------------------------- разметка */

    function build() {
      const p = { ...S.data.card, looks: S.looks, full: true };

      // Верхняя полоса: какой вид, отмена, сохранение.
      const viewSwitch = h(
        'div',
        { class: 'segmented studio__views', role: 'group', 'aria-label': 'Что настраиваем' },
        VIEWS.map((v) =>
          h('button', { type: 'button', 'aria-pressed': String(v === S.view), dataset: { view: v }, onclick: () => setView(v) }, LOOK.views[v], h('span', { class: 'studio__dot', title: 'Есть несохранённые изменения', hidden: true }))
        )
      );
      const undoBtn = h('button', { class: 'btn btn--sm btn--ghost studio__undo', type: 'button', title: 'Отменить (Ctrl+Z)', onclick: undo }, icon('back'), h('span', { class: 'studio__btn-text', text: 'Отменить' }));
      const redoBtn = h('button', { class: 'btn btn--sm btn--ghost studio__redo', type: 'button', title: 'Вернуть (Ctrl+Y)', onclick: redo }, h('span', { class: 'studio__btn-text', text: 'Вернуть' }), icon('arrowRight'));
      const copyBtn = h('button', { class: 'btn btn--sm btn--ghost studio__copy', type: 'button', onclick: copyToOther }, icon('copy'), h('span', { class: 'studio__copy-text' }));
      const status = h('p', { class: 'studio__status', 'aria-live': 'polite' });
      const saveBtn = h('button', { class: 'btn btn--sm studio__save', type: 'button', title: 'Сохранить открытый вид', text: 'Сохранить', onclick: () => save([S.view]) });
      const saveAllBtn = h('button', { class: 'btn btn--sm btn--secondary studio__save-all', type: 'button', title: 'Ctrl+S', text: 'Сохранить обе', onclick: () => save(VIEWS) });
      bar = { viewSwitch, undoBtn, redoBtn, copyBtn, status, saveBtn, saveAllBtn };
      errorBox = h(
        'div',
        { class: 'callout callout--danger studio__error', role: 'alert', hidden: true },
        icon('alert'),
        h('div', {}, h('p', { class: 'callout__title', text: 'Сервер не принял настройки' }), h('p', { class: 'studio__error-text' }))
      );

      // Слева — сцена.
      poser = Skin3D.poser({
        url: p.skinUrl,
        slim: p.skinSlim,
        look: cur(),
        part: S.sel,
        scene: true,
        mode: S.mode,
        yaw: CAMERA[S.view].yaw,
        pitch: CAMERA[S.view].pitch,
        zoom: SCENE_ZOOM,
        label: 'Сцена студии',
        snap: (key) => {
          if (kindOf(key) === 'mob') return S.grid ? 16 : 1;
          const b = blockAt(key);
          return S.grid ? 16 * ((b && b.size) || 1) : 1;
        },
        target: placeTarget,
        frame: frameOf,
        onSelect: (key) => select(key, true),
        onStart: () => begin(null),
        onChange: () => changed(),
        onEnd: () => {
          endGroup();
          renderToolsSoft();
        },
        onTap: tap,
      });
      const zoomBtn = (name, label, k) => h('button', { class: 'icon-btn studio__zoom-btn', type: 'button', 'aria-label': label, title: label, onclick: () => poser.zoomBy(k) }, icon(name));
      toolBadge = h('p', { class: 'studio__tool-badge', hidden: true });
      modesEl = h(
        'div',
        { class: 'studio__modes', role: 'group', 'aria-label': 'Ручки на сцене' },
        Object.entries(MODES).map(([key, [label, k, ic]]) =>
          h('button', { class: 'studio__mode', type: 'button', 'aria-pressed': String(key === S.mode), dataset: { mode: key }, title: `${label} (${k})`, onclick: () => setMode(key) }, icon(ic), h('span', { class: 'studio__mode-text', text: label }), h('kbd', { class: 'studio__mode-key', text: k }))
        )
      );
      const stage = h(
        'div',
        { class: 'studio__stage' },
        poser.el,
        modesEl,
        h(
          'div',
          { class: 'studio__zoom' },
          zoomBtn('minus', 'Отдалить', 1 / 1.25),
          zoomBtn('plus', 'Приблизить', 1.25),
          h('button', { class: 'btn btn--sm btn--ghost studio__camera', type: 'button', title: 'Камера студии — как камера открытого вида', text: 'Вид как на карточке', onclick: () => poser.resetCamera() }),
          h(
            'button',
            { class: 'btn btn--sm studio__cam-toggle', type: 'button', 'aria-pressed': String(S.cameraMode), dataset: { cameraToggle: '' }, title: 'Двигать камеру карточки (C)', onclick: () => setCameraMode(!S.cameraMode) },
            icon('camera'),
            h('span', { text: 'Камера карточки' })
          )
        ),
        toolBadge
      );
      selectionEl = h('p', { class: 'studio__selection', 'aria-live': 'polite' });
      hintEl = h('p', { class: 'studio__hint' });
      const work = h(
        'section',
        { class: 'card studio__work', 'aria-label': 'Просмотр персонажа' },
        h('div', { class: 'studio__work-head' }, h('h2', { class: 'studio__heading', text: 'Просмотр персонажа' }), selectionEl),
        stage,
        hintEl
      );
      resize = new ResizeObserver(() => poser && poser.set({}));
      resize.observe(stage);

      // В середине — как увидят другие.
      const cardEl = Players.card(p, { onOpen: () => setView('card') });
      figureEl = cardEl.querySelector('.skin3d__figure');
      viewer = Skin3D.viewer({ url: p.skinUrl, slim: p.skinSlim, look: S.looks.detail, label: 'Окно игрока — предпросмотр', animate: false, rotate: false });
      const detailStage = Players.paintBackground(h('div', { class: 'pdetail__stage studio__detail-stage' }, viewer.el), p);
      let down = null;
      detailStage.addEventListener('pointerdown', (e) => (down = [e.clientX, e.clientY]), true);
      detailStage.addEventListener('click', (e) => {
        if (e.target.closest('button, a')) return;
        if (down && Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
        setView('detail');
      });
      const previewHead = (v, title) =>
        h(
          'div',
          { class: 'studio__preview-head' },
          h('h3', { class: 'studio__preview-title', text: title }),
          h('button', { class: 'btn btn--sm btn--ghost studio__preview-edit', type: 'button', 'aria-pressed': String(v === S.view), text: 'Править', onclick: () => setView(v) })
        );
      previewEls = [
        h('div', { class: 'studio__preview studio__preview--card', dataset: { view: 'card' } }, previewHead('card', 'Мелкое — карточка'), h('div', { class: 'studio__preview-card' }, cardEl)),
        h('div', { class: 'studio__preview studio__preview--detail', dataset: { view: 'detail' } }, previewHead('detail', 'Крупное — окно игрока'), detailStage),
      ];
      const previews = h('section', { class: 'card studio__previews', 'aria-label': 'Как увидят другие' }, h('h2', { class: 'studio__heading', text: 'Как увидят другие' }), previewEls);

      // Справа — инструменты.
      tabs = Object.entries(TABS).map(([key, label]) =>
        h('button', {
          class: 'tabs__tab',
          type: 'button',
          role: 'tab',
          id: 'studio-tab-' + key,
          'aria-controls': 'studio-panel',
          'aria-selected': String(key === S.tab),
          dataset: { tab: key },
          text: label,
          onclick: () => {
            S.tab = key;
            renderTools();
          },
        })
      );
      panel = h('div', { class: 'studio__panel', id: 'studio-panel', role: 'tabpanel' });
      const tools = h('section', { class: 'card studio__tools', 'aria-label': 'Редактор с инструментами' }, h('div', { class: 'tabs studio__tabs', role: 'tablist', 'aria-label': 'Инструменты' }, tabs), panel);

      clear(root).append(
        h(
          'div',
          { class: 'card studio__bar' },
          h('a', { class: 'btn btn--sm btn--ghost studio__exit', href: '#/profile', title: 'К профилю' }, icon('back'), h('span', { text: 'К профилю' })),
          h('h1', { class: 'studio__title', text: 'Студия' }),
          viewSwitch,
          h('div', { class: 'studio__history' }, undoBtn, redoBtn, copyBtn),
          h('div', { class: 'studio__save-row' }, status, saveBtn, saveAllBtn)
        ),
        errorBox,
        h('div', { class: 'studio' }, work, previews, tools)
      );
      renderTools();
      syncSelection();
      flush();
    }

    function syncBar() {
      if (!bar) return;
      for (const b of bar.viewSwitch.querySelectorAll('button')) {
        b.setAttribute('aria-pressed', String(b.dataset.view === S.view));
        b.querySelector('.studio__dot').hidden = !isDirty(b.dataset.view);
      }
      for (const el of previewEls) {
        const on = el.dataset.view === S.view;
        el.classList.toggle('is-active', on);
        el.querySelector('.studio__preview-edit').setAttribute('aria-pressed', String(on));
      }
      bar.undoBtn.disabled = !undoStack.length;
      bar.redoBtn.disabled = !redoStack.length;
      const copyText = `Скопировать в «${LOOK.views[other()]}»`;
      bar.copyBtn.querySelector('.studio__copy-text').textContent = copyText;
      bar.copyBtn.title = copyText;
      const dirty = VIEWS.filter(isDirty);
      bar.status.textContent = S.saving ? 'Сохраняю…' : dirty.length ? 'Изменения не сохранены' : 'Всё сохранено';
      bar.status.classList.toggle('is-dirty', dirty.length > 0 && !S.saving);
      bar.saveBtn.disabled = S.saving || !isDirty(S.view);
      bar.saveAllBtn.disabled = S.saving || !dirty.length;
    }

    function syncSelection() {
      if (!selectionEl) return;
      const key = S.sel;
      const kind = kindOf(key);
      let text = 'Ничего не выбрано — нажмите на персонажа';
      if (kind === 'part') text = `Выбрано: ${PART_LABEL[key].toLowerCase()}`;
      else if (kind === 'figure') text = 'Выбран весь персонаж';
      else if (kind === 'held' && heldIn(key.slice(5))) text = `Предмет: ${entryLabel(heldIn(key.slice(5)))} — ${SLOTS[key.slice(5)].toLowerCase()}`;
      else if (kind === 'block' && blockAt(key)) text = `Блок ${Number(key.slice(6)) + 1}: ${entryLabel(blockAt(key))}`;
      else if ((kind === 'mob' || kind === 'mobpart') && mobAt(key)) text = `Моб ${mobIndex(key) + 1}: ${mobLabel(mobAt(key).type)}${mobAt(key).type === 'player' ? ` (${skinLabel(mobAt(key).skin)})` : ''}${kind === 'mobpart' ? ' — ' + PART_LABEL[key.split(':')[2]].toLowerCase() : ''}`;
      if (S.cameraMode) text = `Камера: ${LOOK.views[S.view].toLowerCase()}`;
      selectionEl.textContent = text;
      if (toolBadge) {
        const what = S.tab === 'mobs' ? `Ставить: ${mobLabel(S.mob)}` : S.brush ? `Ставить: ${S.brush === 'player_head' ? `голова (${skinLabel(S.brushSkin)})` : labelOf(S.brush)}` : 'Ставить: выберите блок в палитре';
        toolBadge.hidden = S.tool === 'select' && !S.cameraMode;
        toolBadge.textContent = S.cameraMode
          ? 'Камера карточки: тяните — повернуть, колёсико — приблизить, правая кнопка — сдвинуть · C — выйти'
          : S.tool === 'place'
            ? `${what} · Esc — выбор`
            : S.tool === 'break'
              ? 'Убрать: нажмите на блок или моба · Esc — выбор'
              : '';
      }
      if (hintEl) {
        hintEl.textContent = S.cameraMode
          ? 'Рамка — ровно то, что попадёт на карточку. Тяните — повернуть камеру, колёсико — приблизить, правая кнопка — сдвинуть кадр, стрелки — повернуть по шагам. Точные значения — во вкладке «Камера».'
          : 'Нажмите на часть тела, предмет, блок или моба и тяните ручки: V — стрелки (двигать), R — кольца (вращать), S — кубики (растянуть; квадрат в середине — всё сразу). Двойное нажатие на персонажа — выбрать его целиком. Shift — крупный шаг. Пустое место — повернуть камеру, колёсико — приблизить, правая кнопка — сдвинуть кадр. C — камера карточки, Delete — убрать выбранное.';
      }
    }

    /* ---------------------------------------------------- инструменты справа */

    function renderTools(focus) {
      if (!panel) return;
      sync = [];
      syncPoseChips = null;
      for (const t of tabs) {
        const on = t.dataset.tab === S.tab;
        t.setAttribute('aria-selected', String(on));
        t.tabIndex = on ? 0 : -1;
      }
      // «Ставить» и «Убрать» — только пока открыты блоки или мобы (инструмент свой у каждой вкладки).
      if (S.tool !== 'select' && S.tab !== S.toolTab) setTool('select');
      panel.setAttribute('aria-labelledby', 'studio-tab-' + S.tab);
      clear(panel);
      ({ pose: renderPose, items: renderItems, blocks: renderBlocks, mobs: renderMobs, camera: renderCamera, textures: renderTextures })[S.tab]();
      if (focus) {
        const el = panel.querySelector(focus);
        if (el) el.focus();
      }
    }
    /** После движения на сцене: списки и подписи (без потери фокуса — он на сцене). */
    const renderToolsSoft = () => {
      if (S.tab === 'blocks' || S.tab === 'items' || S.tab === 'mobs') renderTools();
    };

    /**
     * Ползунок как в профиле (look__slider); read — откуда взять значение, когда его поменяли на сцене.
     * log — размеры (от 5 % до 2000 %): ползунок по логарифму, чтобы и мелкие, и огромные было удобно выбрать.
     * Значение за пределами ползунка (сцена позволяет больше) — ползунок у края, подпись — настоящее число.
     */
    function slider({ label, min, max, step = 1, value, unit = '', axis, read, onInput, group, format, history = true, log = false }) {
      const fmt = format || ((v) => v + unit);
      const toIn = (v) => (log ? Math.log(Math.max(Number(v) || 0, 1e-6)) : v);
      const out = h('output', { class: 'look__value', text: fmt(value) });
      const input = h('input', { class: 'look__range', type: 'range', min: String(toIn(min)), max: String(toIn(max)), step: log ? '0.001' : String(step), value: String(toIn(value)), 'aria-label': label });
      input.addEventListener('input', () => {
        const v = log ? Math.round(Math.exp(Number(input.value)) / step) * step : Number(input.value);
        out.textContent = fmt(v);
        // history: false — настройка инструмента, а не вида персонажа: в историю и «не сохранено» не попадает.
        if (history) begin(group || label);
        onInput(v);
        if (history) changed();
      });
      input.addEventListener('change', endGroup);
      if (read) {
        sync.push(() => {
          const v = read();
          if (v === undefined || v === null) return;
          input.value = String(toIn(v));
          out.textContent = fmt(v);
        });
      }
      return h(
        'label',
        { class: 'look__slider', dataset: axis === undefined ? null : { axis: 'xyz'[axis] } },
        h('span', { class: 'look__name' }, axis !== undefined && h('span', { class: 'look__axis', 'aria-hidden': 'true' }), label),
        input,
        out
      );
    }

    const group = (title, ...children) => h('div', { class: 'studio__group' }, title && h('p', { class: 'field__label', text: title }), children);

    function notice(text, action) {
      return h('div', { class: 'callout callout--warning studio__notice' }, icon('info'), h('div', {}, h('p', { class: 'callout__title', text: 'Каталог Minecraft не загружен' }), h('p', { text }), action));
    }

    /**
     * Ползунки одной части тела: поворот, сдвиг, размер, «Присесть» — у персонажа и у игрока на сцене.
     * read() — углы позы сейчас (у готовой — её углы), edit() — сделать позу своей и вернуть её углы (меняются на месте),
     * key — начало ключа для «Отменить» (у каждого игрока на сцене своё).
     */
    function limbSliders({ part, read, edit, key = '' }) {
      const angles = read;
      return [
        h('p', { class: 'studio__sub', text: 'Поворот' }),
        AXES[part].map(([label, sign], i) => {
          const read = () => sign * angles()[part][i] || 0;
          return slider({
            label,
            axis: i,
            read,
            min: -LOOK.angle,
            max: LOOK.angle,
            value: read(),
            unit: '°',
            group: `${key}angle:${part}:${i}`,
            onInput: (v) => {
              edit()[part][i] = sign * v;
            },
          });
        }),
        h('p', { class: 'studio__sub', text: 'Сдвиг' }),
        ['Вбок', 'Вверх', 'Вперёд'].map((label, i) => {
          const read = () => {
            const m = angles().move && angles().move[part];
            return m ? m[i] : 0;
          };
          return slider({
            label,
            read,
            min: -64,
            max: 64,
            step: 0.5,
            value: read(),
            format: num,
            group: `${key}move:${part}:${i}`,
            onInput: (v) => {
              const a = edit();
              a.move = a.move || {};
              const m = (a.move[part] || [0, 0, 0]).slice();
              m[i] = v;
              a.move[part] = m;
            },
          });
        }),
        h('p', { class: 'studio__sub', text: 'Размер' }),
        ['Ширина', 'Высота', 'Толщина'].map((label, i) => {
          const read = () => {
            const k = angles().stretch && angles().stretch[part];
            return Math.round((k ? k[i] : 1) * 100);
          };
          return slider({
            label,
            read,
            log: true,
            min: Math.round(LOOK.stretch[0] * 100),
            max: Math.round(LOOK.stretch[1] * 100),
            step: 1,
            value: read(),
            unit: '%',
            group: `${key}stretch:${part}:${i}`,
            onInput: (v) => {
              const a = edit();
              a.stretch = a.stretch || {};
              const k = (a.stretch[part] || [1, 1, 1]).slice();
              k[i] = v / 100;
              a.stretch[part] = k;
            },
          });
        }),
        h(
          'div',
          { class: 'actions-row' },
          h('button', {
            class: 'btn btn--sm btn--ghost studio__reset-part',
            type: 'button',
            text: `Сбросить: ${PART_LABEL[part].toLowerCase()}`,
            onclick: () => {
              begin(null);
              const a = edit();
              a[part] = [0, 0, 0];
              if (a.move) delete a.move[part];
              if (a.stretch) delete a.stretch[part];
              changed();
              renderTools();
            },
          })
        ),
        slider({
          label: 'Присесть',
          read: () => -angles().lift || 0,
          min: -LOOK.lift[1],
          max: -LOOK.lift[0],
          value: -angles().lift || 0,
          group: key + 'lift',
          onInput: (v) => {
            edit().lift = -v || 0;
          },
        }),
        h('p', { class: 'field__hint', text: 'Готовая поза станет своей, как только повернёте, сдвинете или растянете часть тела. На сцене то же делают ручки: V — двигать, R — вращать, S — растянуть.' })
      ];
    }

    /* «Поза» */
    function renderPose() {
      const angles = () => (cur().pose === 'custom' ? cur().angles : Skin3D.poseAngles(cur().pose));
      const chips = h(
        'div',
        { class: 'chips', role: 'radiogroup', 'aria-label': 'Поза' },
        [...Object.entries(Api.CARD_POSES), ['custom', 'Своя поза']].map(([key, label]) =>
          h('button', { class: 'chip', type: 'button', role: 'radio', 'aria-checked': String(key === cur().pose), dataset: { pose: key }, text: label, onclick: () => pickPose(key) })
        )
      );
      syncPoseChips = () => chips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.pose === cur().pose)));

      const part = S.part;
      const parts = h(
        'div',
        { class: 'chips chips--sm', role: 'radiogroup', 'aria-label': 'Часть тела' },
        [{ key: 'figure', label: 'Весь персонаж' }, ...Skin3D.PARTS].map(({ key, label }) =>
          h('button', {
            class: 'chip' + (key === 'figure' ? ' chip--strong' : ''),
            type: 'button',
            role: 'radio',
            'aria-checked': String(key === part),
            dataset: { part: key },
            text: label,
            onclick: () => {
              S.part = key;
              select(key, false);
              renderTools(`[data-part="${key}"]`);
            },
          })
        )
      );

      // Весь персонаж: где стоит, какого размера, куда повёрнут. Блоки и мобы вокруг не меняются.
      const posOf = (i) => (cur().pos ? cur().pos[i] : 0);
      const setPos = (i, v) => {
        const p = cur().pos ? cur().pos.slice() : [0, 0, 0];
        p[i] = v;
        cur().pos = p;
      };
      const W = LOOK.world;
      const figure = group(
        'Персонаж на сцене',
        slider({ label: 'Размер', log: true, min: Math.round(LOOK.size[0] * 100), max: Math.round(LOOK.size[1] * 100), value: Math.round((cur().size || 1) * 100), unit: '%', group: 'fig-size', read: () => Math.round((cur().size || 1) * 100), onInput: (v) => (cur().size = v / 100) }),
        slider({ label: 'Поворот', axis: 1, min: -LOOK.turn, max: LOOK.turn, value: cur().turn, unit: '°', group: 'fig-turn', read: () => cur().turn, onInput: (v) => (cur().turn = v) }),
        ['Вбок (X)', 'Вверх (Y)', 'Вперёд (Z)'].map((label, i) =>
          slider({ label, axis: i, min: i === 1 ? -128 : -256, max: i === 1 ? 256 : 256, step: 0.5, value: posOf(i), format: num, group: `fig-pos:${i}`, read: () => posOf(i), onInput: (v) => setPos(i, clamp(v, i === 1 ? W.y[0] : -W.side, i === 1 ? W.y[1] : W.side)) })
        ),
        h('p', { class: 'field__hint', text: '16 — один блок. На сцене персонажа можно взять целиком: двойное нажатие по нему, дальше V — двигать, R — вращать, S — размер. Ручками можно дальше, чем ползунками.' }),
        h(
          'div',
          { class: 'actions-row' },
          h('button', {
            class: 'btn btn--sm btn--ghost',
            type: 'button',
            text: 'Персонаж на место',
            onclick: () => {
              begin(null);
              cur().size = 1;
              cur().turn = 0;
              delete cur().pos;
              changed();
            },
          })
        )
      );

      const custom =
        part === 'figure'
          ? h('div', { class: 'look__custom' }, h('p', { class: 'field__label', text: 'Что двигаем' }), parts)
          : h('div', { class: 'look__custom' }, h('p', { class: 'field__label', text: 'Что двигаем' }), parts, limbSliders({ part, read: angles, edit: () => (ensureCustom(), cur().angles) }));

      UI.append(panel, [
        group('Поза', chips),
        custom,
        figure,
        h(
          'div',
          { class: 'actions-row' },
          h('button', {
            class: 'btn btn--sm btn--secondary',
            type: 'button',
            text: 'Сбросить позу',
            onclick: () => {
              if (cur().pose === 'stand') return;
              begin(null);
              cur().pose = 'stand';
              delete cur().angles;
              changed();
            },
          }),
          h('button', {
            class: 'btn btn--sm btn--ghost',
            type: 'button',
            text: 'Сбросить всё',
            onclick: async () => {
              const ok = await UI.confirm({ title: 'Сбросить всё?', text: `В виде «${LOOK.views[S.view]}» персонаж встанет как обычно, без предметов, блоков, мобов и своих картинок, камера — как была. Это можно отменить (Ctrl+Z).`, confirmText: 'Сбросить', danger: true });
              if (!ok || !alive) return;
              begin(null);
              S.looks[S.view] = prepare({ pose: 'stand', scale: 1, turn: 0 }, S.view);
              S.sel = PART_KEYS.has(S.part) ? S.part : 'rightArm';
              refreshAll();
            },
          })
        ),
      ]);
    }

    /* «Камера»: как вид снят — для карточки и для окна игрока своя. */
    function renderCamera() {
      const cam = () => cur().camera || { yaw: CAMERA[S.view].yaw, pitch: CAMERA[S.view].pitch };
      const setCam = (k, v) => (cur().camera = { ...cam(), [k]: v });
      const off = (i) => (cur().offset ? cur().offset[i] : 0);
      const setOff = (i, v) => {
        const o = cur().offset ? cur().offset.slice() : [0, 0];
        o[i] = v;
        cur().offset = o;
      };
      const toggle = h(
        'button',
        { class: 'btn studio__cam-big', type: 'button', 'aria-pressed': String(S.cameraMode), dataset: { cameraToggle: '' }, onclick: () => setCameraMode(!S.cameraMode) },
        icon('camera'),
        h('span', { text: 'Двигать камеру на сцене' })
      );
      UI.append(panel, [
        h('p', { class: 'card-sub', text: `Камера вида «${LOOK.views[S.view]}»: откуда смотрим на сцену и насколько близко. У карточки и окна игрока камеры разные.` }),
        h('div', { class: 'studio__group' }, toggle, h('p', { class: 'field__hint', text: 'На сцене появится рамка — ровно то, что увидят на карточке. Тяните — повернуть, колёсико — приблизить, правая кнопка — сдвинуть кадр. Клавиша C — включить и выключить.' })),
        group(
          'Поворот камеры',
          slider({ label: 'Вокруг', axis: 1, min: -180, max: 180, value: cam().yaw, unit: '°', group: 'cam-yaw', read: () => cam().yaw, onInput: (v) => setCam('yaw', v) }),
          slider({ label: 'Сверху — снизу', axis: 0, min: -LOOK.pitch + 1, max: LOOK.pitch - 1, value: cam().pitch, unit: '°', group: 'cam-pitch', read: () => cam().pitch, onInput: (v) => setCam('pitch', v) })
        ),
        group(
          'Кадр',
          slider({ label: 'Приближение', log: true, min: Math.round(LOOK.scale[0] * 100), max: Math.round(LOOK.scale[1] * 100), value: Math.round(cur().scale * 100), unit: '%', group: 'cam-zoom', read: () => Math.round(cur().scale * 100), onInput: (v) => (cur().scale = v / 100) }),
          slider({ label: 'Сдвиг вбок', min: -400, max: 400, step: 0.5, value: off(0), format: num, group: 'cam-x', read: () => off(0), onInput: (v) => setOff(0, v) }),
          slider({ label: 'Сдвиг вверх', min: -400, max: 400, step: 0.5, value: off(1), format: num, group: 'cam-y', read: () => off(1), onInput: (v) => setOff(1, v) })
        ),
        h(
          'div',
          { class: 'actions-row' },
          h('button', {
            class: 'btn btn--sm btn--secondary',
            type: 'button',
            title: 'Поворот и наклон — как сейчас у камеры студии',
            text: 'Снять с вида студии',
            onclick: () => {
              begin(null);
              cur().camera = poser.view;
              changed();
              UI.toast('Камера вида — как сейчас на сцене');
            },
          }),
          h('button', {
            class: 'btn btn--sm btn--ghost',
            type: 'button',
            text: 'Камера как была',
            onclick: () => {
              begin(null);
              cur().camera = { yaw: CAMERA[S.view].yaw, pitch: CAMERA[S.view].pitch };
              cur().scale = 1;
              delete cur().offset;
              changed();
            },
          })
        ),
      ]);
    }

    /* Палитра блоков и предметов: поиск, страницы по PAGE_SIZE, значки рисуются только для открытой страницы. */
    const lists = {};
    function idsFor(kind) {
      if (lists[kind]) return lists[kind];
      const all = art().list();
      const seen = new Set();
      const out = [];
      const add = (ids) => ids.forEach((id) => !seen.has(id) && (seen.add(id), out.push(id)));
      // Головы мобов и игроков — первыми: их не найти в длинном списке английских названий.
      if (kind !== 'items' && mobs()) add(mobs().HEADS.map((x) => x.id));
      if (kind === 'heads') return (lists[kind] = out);
      if (kind !== 'blocks') add(all.items);
      if (kind !== 'items') add(all.blocks);
      lists[kind] = out;
      return out;
    }

    let namesAsked = false;
    function palette({ stateKey, blocksOnly, picked, onPick }) {
      const A = art();
      const st = S.pal[stateKey];
      const box = h('div', { class: 'studio__palette' });
      if (!A.ready) {
        box.append(h('p', { class: 'studio__loading', role: 'status', text: 'Загружаю каталог Minecraft…' }));
        A.load()
          .then(() => alive && panel && renderTools())
          .catch(() => {
            if (!alive) return;
            clear(box).append(
              h('p', { class: 'field__hint', text: 'Не получилось загрузить каталог Minecraft.' }),
              h('button', { class: 'btn btn--sm btn--secondary', type: 'button', text: 'Повторить', onclick: () => renderTools() })
            );
          });
        return box;
      }
      if (!namesAsked) {
        namesAsked = true;
        // Английские названия из игры — для поиска и подсказок; пока грузятся, названия — из id.
        A.loadNames().then(() => alive && grid && drawGrid());
      }
      const search = h('input', { class: 'input', type: 'search', placeholder: blocksOnly ? 'Найти блок: stone, oak…' : 'Найти: sword, apple, stone…', value: st.query, 'aria-label': 'Поиск', autocomplete: 'off', spellcheck: 'false' });
      const kinds = !blocksOnly && h(
        'div',
        { class: 'segmented segmented--sm studio__kinds', role: 'group', 'aria-label': 'Что показать' },
        [['all', 'Всё'], ['items', 'Предметы'], ['blocks', 'Блоки'], ['heads', 'Головы']].map(([k, label]) =>
          h('button', {
            type: 'button',
            'aria-pressed': String(st.kind === k),
            text: label,
            onclick: (e) => {
              st.kind = k;
              st.page = 0;
              kinds.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
              drawGrid();
            },
          })
        )
      );
      let grid = h('div', { class: 'studio__grid', role: 'list' });
      const pager = h('div', { class: 'studio__pager' });
      const count = h('p', { class: 'studio__count' });

      function filtered() {
        const textures = !blocksOnly && st.kind === 'heads' ? [] : (cur().textures || []).map((_, i) => 'tex' + (i + 1));
        const ids = [...textures, ...idsFor(blocksOnly ? 'blocks' : st.kind)];
        const q = st.query.trim().toLowerCase();
        if (!q) return ids;
        return ids.filter((id) => id.includes(q.replace(/\s+/g, '_')) || labelOf(id).toLowerCase().includes(q));
      }
      function drawGrid() {
        const ids = filtered();
        const pages = Math.max(1, Math.ceil(ids.length / PAGE_SIZE));
        st.page = clamp(st.page, 0, pages - 1);
        clear(grid);
        grid.append(
          ...ids.slice(st.page * PAGE_SIZE, (st.page + 1) * PAGE_SIZE).map((id) =>
            h(
              'button',
              { class: 'studio__tile', type: 'button', role: 'listitem', title: `${labelOf(id)} (${id})`, 'aria-label': labelOf(id), 'aria-pressed': String(id === picked), dataset: { id }, onclick: () => onPick(id) },
              iconOf(id, 32)
            )
          )
        );
        if (!ids.length) grid.append(h('p', { class: 'field__hint studio__empty', text: 'Ничего не нашлось. Названия — как в игре, на английском.' }));
        count.textContent = `Найдено: ${ids.length}`;
        UI.append(clear(pager), [
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Предыдущая страница', disabled: st.page === 0, onclick: () => ((st.page -= 1), drawGrid()) }, icon('back')),
          h('span', { class: 'studio__page', text: `${st.page + 1} из ${pages}` }),
          h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Следующая страница', disabled: st.page >= pages - 1, onclick: () => ((st.page += 1), drawGrid()) }, icon('chevronRight')),
        ]);
      }
      search.addEventListener(
        'input',
        UI.debounce(() => {
          st.query = search.value;
          st.page = 0;
          drawGrid();
        }, 150)
      );
      drawGrid();
      UI.append(box, [h('div', { class: 'search', role: 'search' }, icon('search'), search), kinds, grid, h('div', { class: 'studio__pal-foot' }, count, pager)]);
      return box;
    }

    /** Значок головы: как в инвентаре игры (у головы игрока — его скин). */
    function headIcon(id, px, skin) {
      const c = document.createElement('canvas');
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      c.width = c.height = Math.round(px * dpr);
      c.className = 'mc-icon';
      const paint = () => {
        const m = Skin3D.headModel(id, skin, paint);
        if (m) Skin3D.drawIcon(c, m);
      };
      paint();
      return c;
    }

    /** Значок моба для палитры и списка. */
    function mobIcon(type, px, skin, slim) {
      const c = document.createElement('canvas');
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      c.width = c.height = Math.round(px * dpr);
      c.className = 'mc-icon mc-icon--mob';
      const paint = () => Skin3D.drawMob(c, type, { skin, slim, onReady: paint });
      paint();
      return c;
    }

    /** Значок блока, предмета или головы (или своя картинка без каталога). skin — чья голова игрока. */
    function iconOf(id, px = 32, skin) {
      const A = art();
      if (A && isHead(id)) return headIcon(id, px, skin);
      if (A) return A.icon(id, px, null, cur().textures || []);
      if (isTex(id) && cur().textures && cur().textures[Number(id.slice(3)) - 1]) return h('img', { class: 'studio__tex-img', src: Api.textureUrl(cur().textures[Number(id.slice(3)) - 1]), alt: '', width: String(px), height: String(px) });
      return h('span', { class: 'studio__no-icon', 'aria-hidden': 'true' });
    }

    /**
     * Чей скин — для головы игрока и игрока на сцене: стандартные скины игры, игроки LWL (их скины уже на сайте)
     * или любая лицензия по нику (сайт скачает скин у Mojang). onPick(skin, slim) — skin: sha256 или 'wide/steve'.
     */
    function skinPicker({ value, onPick, label = 'Чей скин' }) {
      const box = h('div', { class: 'studio__skins' });
      const now = h('p', { class: 'studio__current-id', text: `Сейчас: ${skinLabel(value)}` });
      const std = h(
        'div',
        { class: 'chips chips--sm', role: 'radiogroup', 'aria-label': 'Стандартные скины' },
        (mobs() ? mobs().SKINS : []).filter((s) => s.startsWith('wide/') || s === 'slim/alex').filter((s) => s !== 'wide/alex').map((skin) =>
          h('button', { class: 'chip', type: 'button', role: 'radio', 'aria-checked': String(skin === (value || 'wide/steve')), text: mobs().skinLabel(skin).replace(' (тонкие руки)', ''), onclick: () => onPick(skin, skin.startsWith('slim/')) })
        )
      );
      const players = h('div', { class: 'chips chips--sm studio__skin-players', role: 'radiogroup', 'aria-label': 'Игроки LWL' }, h('span', { class: 'studio__loading', text: 'Загружаю игроков…' }));
      const fillPlayers = (list) => {
        clear(players);
        const withSkin = list.filter((p) => p.hash);
        if (!withSkin.length) players.append(h('span', { class: 'field__hint', text: 'У игроков сервера пока нет своих скинов.' }));
        for (const p of withSkin)
          players.append(h('button', { class: 'chip', type: 'button', role: 'radio', 'aria-checked': String(p.hash === value), text: p.nickname, onclick: () => onPick(p.hash, p.slim) }));
      };
      if (lwlPlayers) fillPlayers(lwlPlayers);
      else
        Api.players
          .list({ sort: 'recent' })
          .then((d) => {
            lwlPlayers = (d.players || []).map((p) => {
              const m = /\/api\/skins\/([0-9a-f]{64})\.png/.exec(p.skinUrl || '');
              const hash = m && !p.skinDefault ? m[1] : null;
              if (hash) skinNames.set(hash, p.nickname);
              return { nickname: p.nickname, hash, slim: !!p.skinSlim };
            });
            if (alive && players.isConnected) fillPlayers(lwlPlayers);
          })
          .catch(() => {
            clear(players).append(h('span', { class: 'field__hint', text: 'Не получилось загрузить игроков.' }));
          });
      const nick = h('input', { class: 'input', type: 'text', placeholder: 'Ник лицензии', 'aria-label': 'Ник лицензии Minecraft', autocomplete: 'off', spellcheck: 'false', maxlength: '16' });
      const find = h('button', { class: 'btn btn--sm btn--secondary', type: 'button', text: 'Найти' });
      const findSkin = async () => {
        find.disabled = true;
        try {
          const d = await Api.players.findSkin(nick.value);
          if (!alive) return;
          if (/^[0-9a-f]{64}$/.test(d.skin)) skinNames.set(d.skin, d.nickname);
          onPick(d.skin, d.slim);
          UI.toast(/^[0-9a-f]{64}$/.test(d.skin) ? `Скин ${d.nickname} найден` : `У ${d.nickname} стандартный скин`, { type: 'success' });
        } catch (err) {
          UI.toast(err.fields ? Object.values(err.fields)[0] : err.message, { type: 'error' });
        } finally {
          find.disabled = false;
        }
      };
      find.addEventListener('click', findSkin);
      nick.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          findSkin();
        }
      });
      UI.append(box, [
        h('p', { class: 'field__label', text: label }),
        now,
        h('p', { class: 'studio__sub', text: 'Стандартные' }),
        std,
        h('p', { class: 'studio__sub', text: 'Игроки сервера' }),
        players,
        h('p', { class: 'studio__sub', text: 'Любая лицензия' }),
        h('div', { class: 'studio__skin-find' }, nick, find),
      ]);
      return box;
    }

    /* «Предметы» */
    function renderItems() {
      const A = art();
      const slots = h(
        'div',
        { class: 'segmented studio__slots', role: 'group', 'aria-label': 'Куда' },
        LOOK.slots.map((slot) =>
          h(
            'button',
            {
              type: 'button',
              'aria-pressed': String(slot === S.slot),
              dataset: { slot },
              onclick: () => {
                S.slot = slot;
                if (heldIn(slot)) select('held:' + slot, false);
                renderTools(`[data-slot="${slot}"]`);
              },
            },
            SLOTS[slot],
            heldIn(slot) && h('span', { class: 'studio__filled', 'aria-label': '(занято)', text: '•' })
          )
        )
      );
      if (!A) {
        const held = LOOK.slots.filter((slot) => heldIn(slot));
        UI.append(panel, [
          notice('Предметы в руках и на голове берутся из самой игры, а на этой странице её каталог сейчас не загружен. Поза, размер и сдвиг работают как обычно.'),
          held.length
            ? group(
                'Сейчас у персонажа',
                h(
                  'ul',
                  { class: 'studio__list' },
                  held.map((slot) =>
                    h('li', { class: 'studio__row' }, h('span', { class: 'studio__row-text', text: `${SLOTS[slot]}: ${heldIn(slot).id}` }), h('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: 'Убрать', onclick: () => (removeHeld(slot), renderTools()) }))
                  )
                )
              )
            : h('p', { class: 'field__hint', text: 'Сейчас в руках ничего нет.' }),
        ]);
        return;
      }
      const e = heldIn(S.slot);
      const slot = S.slot;
      const entry = () => heldIn(slot);
      const current = e
        ? h(
            'div',
            { class: 'studio__current' },
            iconOf(e.id, 40, e.skin),
            h('div', { class: 'studio__current-text' }, h('p', { class: 'studio__current-name', text: entryLabel(e) }), h('p', { class: 'studio__current-id', text: e.id })),
            h('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: 'Убрать', onclick: () => (removeHeld(slot), renderTools()) })
          )
        : h('p', { class: 'field__hint', text: `${SLOTS[slot]}: пусто — выберите предмет, блок или голову ниже.` });
      const setRot = (i, v) => {
        const x = entry();
        x.rot = x.rot.slice();
        x.rot[i] = v;
      };
      const setAt = (i, v) => {
        const x = entry();
        x.at = x.at.slice();
        x.at[i] = v;
      };
      const H = LOOK.held;
      UI.append(panel, [
        group('Куда', slots),
        current,
        e &&
          e.id === 'player_head' &&
          skinPicker({
            value: e.skin,
            label: 'Чья голова',
            onPick: (skin) => {
              begin(null);
              entry().skin = skin;
              changed();
              renderTools();
            },
          }),
        e &&
          group(
            'Как держит',
            ['Наклон', 'Поворот', 'Крен'].map((label, i) =>
              slider({ label, axis: i, min: -H.rot, max: H.rot, value: e.rot[i], unit: '°', group: `held-rot:${i}`, read: () => entry() && entry().rot[i], onInput: (v) => setRot(i, v) })
            ),
            slider({ label: 'Размер', log: true, min: Math.round(H.size[0] * 100), max: Math.round(H.size[1] * 100), value: Math.round(e.size * 100), unit: '%', group: 'held-size', read: () => entry() && Math.round(entry().size * 100), onInput: (v) => (entry().size = v / 100) }),
            ['Сдвиг вбок', 'Сдвиг вверх', 'Сдвиг вперёд'].map((label, i) =>
              slider({ label, min: -32, max: 32, step: 0.5, value: e.at[i], format: num, group: `held-at:${i}`, read: () => entry() && entry().at[i], onInput: (v) => setAt(i, v) })
            ),
            h('p', { class: 'field__hint', text: 'Предмет держится в кулаке, как в игре. Или нажмите на него на сцене и тяните кольца и стрелки — так можно и дальше от руки.' })
          ),
        group(
          `Палитра — ${SLOT_TO[slot]}`,
          palette({ stateKey: 'items', picked: e && e.id, onPick: (id) => (assignHeld(slot, id), renderTools()) })
        ),
      ]);
    }

    /* «Блоки» */
    function renderBlocks() {
      const A = art();
      const blocks = blocksOf();
      const counter = h('p', { class: 'studio__counter' + (blocks.length >= LOOK.blocks.max ? ' is-full' : ''), text: `Блоков: ${blocks.length} из ${LOOK.blocks.max}` });
      const list = blocks.length
        ? h(
            'ul',
            { class: 'studio__list' },
            blocks.map((b, i) =>
              h(
                'li',
                { class: 'studio__row' + (S.sel === 'block:' + i ? ' is-selected' : '') },
                A && iconOf(b.id, 24, b.skin),
                h('button', { class: 'studio__row-pick', type: 'button', 'aria-pressed': String(S.sel === 'block:' + i), text: `${i + 1}. ${entryLabel(b)}`, onclick: () => (setTool('select'), select('block:' + i, false)) }),
                h('button', { class: 'icon-btn studio__row-del', type: 'button', 'aria-label': `Убрать блок ${i + 1}`, title: 'Убрать', onclick: () => (removeBlock(i), renderTools()) }, icon('trash'))
              )
            )
          )
        : h('p', { class: 'field__hint', text: 'Блоков пока нет.' });
      const clearAll =
        blocks.length > 0 &&
        h('button', {
          class: 'btn btn--sm btn--ghost',
          type: 'button',
          text: 'Убрать все блоки',
          onclick: () => {
            begin(null);
            delete cur().blocks;
            if (kindOf(S.sel) === 'block') S.sel = null;
            refreshAll();
          },
        });
      if (!A) {
        UI.append(panel, [
          notice('Блоки вокруг персонажа — настоящие блоки игры, а на этой странице её каталог сейчас не загружен. Уже поставленные блоки сохранятся; убрать их можно здесь.'),
          counter,
          list,
          h('div', { class: 'actions-row' }, clearAll),
        ]);
        return;
      }
      const toolBtns = h(
        'div',
        { class: 'segmented studio__tool-switch', role: 'group', 'aria-label': 'Инструмент' },
        Object.entries(TOOLS).map(([key, label]) => h('button', { type: 'button', 'aria-pressed': String(S.tool === key), dataset: { tool: key }, text: label, onclick: () => setTool(key) }))
      );
      const gridBox = h('label', { class: 'checkbox' }, h('input', { type: 'checkbox', checked: S.grid, onchange: (e) => (S.grid = e.target.checked) }), h('span', { text: 'По сетке (Shift — наоборот)' }));
      const brush = S.brush
        ? h(
            'div',
            { class: 'studio__current' },
            iconOf(S.brush, 32, S.brushSkin),
            h('div', { class: 'studio__current-text' }, h('p', { class: 'studio__current-name', text: S.brush === 'player_head' ? `Голова: ${skinLabel(S.brushSkin)}` : labelOf(S.brush) }), h('p', { class: 'studio__current-id', text: 'Ставится этот блок' }))
          )
        : h('p', { class: 'field__hint', text: 'Выберите блок в палитре ниже — и ставьте его на пол или на грань другого блока. Заборы, стены и стёкла сами соединяются с соседями.' });

      // Выбранный блок: где стоит, поворот, размер.
      const sel = kindOf(S.sel) === 'block' ? S.sel : null;
      const b = sel && blockAt(sel);
      const bk = () => sel && blockAt(sel);
      const B = LOOK.blocks;
      const setAt = (i, v) => {
        const x = bk();
        x.at = x.at.slice();
        x.at[i] = v;
      };
      const setBlockRot = (i, v) => {
        const x = bk();
        x.rot = rotArr(x.rot);
        x.rot[i] = v;
      };
      const selected =
        b &&
        group(
          `Выбранный блок ${Number(sel.slice(6)) + 1}: ${entryLabel(b)}`,
          slider({ label: 'Вбок (X)', min: -256, max: 256, value: b.at[0], format: num, group: 'block-x', read: () => bk() && bk().at[0], onInput: (v) => setAt(0, v) }),
          slider({ label: 'Высота (Y)', min: -128, max: 256, value: b.at[1], format: num, group: 'block-y', read: () => bk() && bk().at[1], onInput: (v) => setAt(1, v) }),
          slider({ label: 'Вперёд (Z)', min: -256, max: 256, value: b.at[2], format: num, group: 'block-z', read: () => bk() && bk().at[2], onInput: (v) => setAt(2, v) }),
          // Поворот по трём осям вокруг центра блока (у старых — одно число, вокруг вертикали).
          h('p', { class: 'studio__sub', text: 'Поворот' }),
          ['Наклон вперёд', 'Поворот', 'Наклон вбок'].map((label, i) =>
            slider({ label, axis: i, min: -180, max: 180, value: rotArr(b.rot)[i], unit: '°', group: `block-rot:${i}`, read: () => bk() && rotArr(bk().rot)[i], onInput: (v) => setBlockRot(i, v) })
          ),
          slider({ label: 'Размер', log: true, min: Math.round(B.size[0] * 100), max: Math.round(B.size[1] * 100), value: Math.round((b.size || 1) * 100), unit: '%', group: 'block-size', read: () => bk() && Math.round((bk().size || 1) * 100), onInput: (v) => (bk().size = v / 100) }),
          b.id === 'player_head' &&
            skinPicker({
              value: b.skin,
              label: 'Чья голова',
              onPick: (skin) => {
                begin(null);
                bk().skin = skin;
                changed();
                renderTools();
              },
            }),
          h(
            'div',
            { class: 'actions-row' },
            h('button', {
              class: 'btn btn--sm btn--secondary',
              type: 'button',
              text: 'Копия рядом',
              onclick: () => {
                const s = b.size || 1;
                const x = b.at[0] + 16 * s <= B.side ? b.at[0] + 16 * s : b.at[0] - 16 * s;
                const copy = { id: b.id, at: [round(x, 10), b.at[1], b.at[2]], rot: rotArr(b.rot), size: s };
                if (b.skin) copy.skin = b.skin;
                if (addBlock(copy)) renderTools();
              },
            }),
            h('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: 'Брать этот блок', onclick: () => ((S.brush = b.id), (S.brushSkin = b.skin || null), renderTools()) }),
            h('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: 'Убрать', onclick: () => (removeBlock(Number(sel.slice(6))), renderTools()) })
          )
        );
      UI.append(panel, [
        h('div', { class: 'studio__group' }, h('div', { class: 'studio__row-between' }, toolBtns, counter), gridBox),
        group('Ставится', brush, slider({ label: 'Размер новых', log: true, min: Math.round(B.size[0] * 100), max: Math.round(B.size[1] * 100), value: Math.round(S.brushSize * 100), unit: '%', history: false, onInput: (v) => (S.brushSize = v / 100) })),
        S.brush === 'player_head' && skinPicker({ value: S.brushSkin, label: 'Чью голову ставить', onPick: (skin) => ((S.brushSkin = skin), renderTools()) }),
        selected,
        group('Поставленные', list, h('div', { class: 'actions-row' }, clearAll)),
        group(
          'Палитра блоков',
          palette({
            stateKey: 'blocks',
            blocksOnly: true,
            picked: S.brush,
            onPick: (id) => {
              S.brush = id;
              setTool('place');
              renderTools();
            },
          })
        ),
      ]);
    }

    /* «Мобы»: мобы игры и другие игроки рядом с персонажем. */
    function renderMobs() {
      const A = art();
      const M = mobs();
      const list = mobsOf();
      const counter = h('p', { class: 'studio__counter' + (list.length >= LOOK.mobs.max ? ' is-full' : ''), text: `Мобов: ${list.length} из ${LOOK.mobs.max}` });
      const placed = list.length
        ? h(
            'ul',
            { class: 'studio__list' },
            list.map((m, i) =>
              h(
                'li',
                { class: 'studio__row' + (S.sel && (S.sel === 'mob:' + i || S.sel.startsWith('mob:' + i + ':')) ? ' is-selected' : '') },
                A && M && mobIcon(m.type, 24, m.skin, m.slim),
                h('button', { class: 'studio__row-pick', type: 'button', 'aria-pressed': String(!!S.sel && (S.sel === 'mob:' + i || S.sel.startsWith('mob:' + i + ':'))), text: `${i + 1}. ${mobLabel(m.type)}${m.type === 'player' ? ` (${skinLabel(m.skin)})` : ''}`, onclick: () => (setTool('select'), select('mob:' + i, false)) }),
                h('button', { class: 'icon-btn studio__row-del', type: 'button', 'aria-label': `Убрать моба ${i + 1}`, title: 'Убрать', onclick: () => (removeMob(i), renderTools()) }, icon('trash'))
              )
            )
          )
        : h('p', { class: 'field__hint', text: 'Мобов пока нет.' });
      const clearAll =
        list.length > 0 &&
        h('button', {
          class: 'btn btn--sm btn--ghost',
          type: 'button',
          text: 'Убрать всех мобов',
          onclick: () => {
            begin(null);
            delete cur().mobs;
            if (kindOf(S.sel) === 'mob') S.sel = null;
            refreshAll();
          },
        });
      if (!A || !M) {
        UI.append(panel, [notice('Мобы — модели и текстуры самой игры, а на этой странице её каталог сейчас не загружен. Уже поставленные мобы сохранятся; убрать их можно здесь.'), counter, placed, h('div', { class: 'actions-row' }, clearAll)]);
        return;
      }
      const toolBtns = h(
        'div',
        { class: 'segmented studio__tool-switch', role: 'group', 'aria-label': 'Инструмент' },
        Object.entries(TOOLS).map(([key, label]) => h('button', { type: 'button', 'aria-pressed': String(S.tool === key), dataset: { tool: key }, text: label, onclick: () => setTool(key) }))
      );
      const gridBox = h('label', { class: 'checkbox' }, h('input', { type: 'checkbox', checked: S.grid, onchange: (e) => (S.grid = e.target.checked) }), h('span', { text: 'По сетке (Shift — наоборот)' }));
      const brush = h(
        'div',
        { class: 'studio__current' },
        mobIcon(S.mob, 40, S.mobSkin, S.mobSlim),
        h(
          'div',
          { class: 'studio__current-text' },
          h('p', { class: 'studio__current-name', text: mobLabel(S.mob) + (S.mob === 'player' ? ` (${skinLabel(S.mobSkin)})` : '') }),
          h('p', { class: 'studio__current-id', text: 'Ставится этот моб: «Ставить» и нажмите на пол или на верх блока' })
        )
      );

      // Выбранный моб: поза, место, поворот, размер; у игрока — чей скин и каждая часть тела, как у персонажа.
      const sel = kindOf(S.sel) === 'mob' || kindOf(S.sel) === 'mobpart' ? 'mob:' + mobIndex(S.sel) : null;
      const limb = kindOf(S.sel) === 'mobpart' ? S.sel.split(':')[2] : null;
      const m = sel && mobAt(sel);
      const mk = () => sel && mobAt(sel);
      const setAt = (i, v) => {
        const x = mk();
        x.at = x.at.slice();
        x.at[i] = v;
      };
      const setRot = (i, v) => {
        const x = mk();
        x.rot = rotArr(x.rot);
        x.rot[i] = v;
      };
      const def = m && M.mob(m.type, m.slim);
      const isPlayer = m && m.type === 'player';
      // У игрока на сцене — ещё «Своя поза»: каждая часть тела отдельно (углы как у персонажа).
      const poseKeys = def ? [...def.poses, ...(isPlayer ? ['custom'] : [])] : [];
      const mobAngles = () => (mk().pose === 'custom' && mk().angles ? mk().angles : Skin3D.poseAngles(mk().pose));
      const mobEdit = () => {
        const x = mk();
        if (x.pose !== 'custom' || !x.angles) {
          x.angles = Skin3D.poseAngles(x.pose);
          x.pose = 'custom';
        }
        return x.angles;
      };
      const limbChips =
        isPlayer &&
        h(
          'div',
          { class: 'chips chips--sm', role: 'radiogroup', 'aria-label': 'Часть тела игрока' },
          [{ key: null, label: 'Весь игрок' }, ...Skin3D.PARTS].map(({ key, label }) =>
            h('button', {
              class: 'chip' + (key ? '' : ' chip--strong'),
              type: 'button',
              role: 'radio',
              'aria-checked': String(key === limb),
              dataset: { mobPart: key || 'whole' },
              text: label,
              onclick: () => {
                select(key ? `${sel}:${key}` : sel, false);
                renderTools(`[data-mob-part="${key || 'whole'}"]`);
              },
            })
          )
        );
      const poseChips =
        poseKeys.length > 1 &&
          h(
            'div',
            { class: 'chips chips--sm', role: 'radiogroup', 'aria-label': 'Поза моба' },
            poseKeys.map((p) =>
              h('button', {
                class: 'chip',
                type: 'button',
                role: 'radio',
                'aria-checked': String((m.pose || 'stand') === p),
                dataset: { mobPose: p },
                text: p === 'custom' ? 'Своя поза' : M.POSE_LABELS[p] || p,
                onclick: () => {
                  if ((mk().pose || 'stand') === p) return;
                  begin(null);
                  const x = mk();
                  if (p === 'custom') {
                    x.angles = Skin3D.poseAngles(x.pose);
                    x.pose = 'custom';
                  } else {
                    x.pose = p;
                    delete x.angles;
                  }
                  changed();
                  renderTools();
                },
              })
            )
          );
      // Поменяли на сцене или ползунком — «Своя поза» отмечается сразу.
      if (poseChips) sync.push(() => mk() && poseChips.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-checked', String(c.dataset.mobPose === (mk().pose || 'stand')))));
      const selected =
        m &&
        group(
          `Выбранный моб ${mobIndex(sel) + 1}: ${mobLabel(m.type)}`,
          poseChips,
          isPlayer && h('p', { class: 'field__label', text: 'Что двигаем' }),
          limbChips,
          isPlayer && limb && h('div', { class: 'look__custom' }, limbSliders({ part: limb, read: mobAngles, edit: mobEdit, key: `mob${mobIndex(sel)}:` })),
          !limb && slider({ label: 'Вбок (X)', axis: 0, min: -256, max: 256, step: 0.5, value: m.at[0], format: num, group: 'mob-x', read: () => mk() && mk().at[0], onInput: (v) => setAt(0, v) }),
          !limb && slider({ label: 'Высота (Y)', axis: 1, min: -128, max: 256, step: 0.5, value: m.at[1], format: num, group: 'mob-y', read: () => mk() && mk().at[1], onInput: (v) => setAt(1, v) }),
          !limb && slider({ label: 'Вперёд (Z)', axis: 2, min: -256, max: 256, step: 0.5, value: m.at[2], format: num, group: 'mob-z', read: () => mk() && mk().at[2], onInput: (v) => setAt(2, v) }),
          // Поворот по трём осям (старое число — только вокруг вертикали): наклон вперёд, поворот, наклон вбок.
          !limb && h('p', { class: 'studio__sub', text: 'Поворот' }),
          !limb &&
            ['Наклон вперёд', 'Поворот', 'Наклон вбок'].map((label, i) =>
              slider({ label, axis: i, min: -180, max: 180, value: rotArr(m.rot)[i], unit: '°', group: `mob-rot:${i}`, read: () => mk() && rotArr(mk().rot)[i], onInput: (v) => setRot(i, v) })
            ),
          !limb && slider({ label: 'Размер', log: true, min: Math.round(LOOK.mobs.size[0] * 100), max: Math.round(LOOK.mobs.size[1] * 100), value: Math.round((m.size || 1) * 100), unit: '%', group: 'mob-size', read: () => mk() && Math.round((mk().size || 1) * 100), onInput: (v) => (mk().size = v / 100) }),
          isPlayer && !limb && h('p', { class: 'field__hint', text: 'Нажмите на руку, ногу, голову или тело игрока на сцене — и тяните ручки, как у своего персонажа. Двойное нажатие по игроку — выбрать его целиком.' }),
          isPlayer &&
            !limb &&
            skinPicker({
              value: m.skin,
              label: 'Чей скин у игрока',
              onPick: (skin, slim) => {
                begin(null);
                const x = mk();
                x.skin = skin;
                if (slim) x.slim = true;
                else delete x.slim;
                changed();
                renderTools();
              },
            }),
          h(
            'div',
            { class: 'actions-row' },
            h('button', {
              class: 'btn btn--sm btn--secondary',
              type: 'button',
              text: 'Копия рядом',
              onclick: () => {
                const copy = clone(m);
                copy.at = [round(m.at[0] + 16 <= LOOK.mobs.side ? m.at[0] + 16 : m.at[0] - 16, 10), m.at[1], m.at[2]];
                if (addMob(copy)) renderTools();
              },
            }),
            h('button', { class: 'btn btn--sm btn--ghost', type: 'button', text: 'Убрать', onclick: () => (removeMob(mobIndex(sel)), renderTools()) })
          )
        );

      // Палитра мобов по группам.
      const tiles = Object.entries(M.GROUPS).map(([g, title]) =>
        h(
          'div',
          { class: 'studio__group' },
          h('p', { class: 'studio__sub', text: title }),
          h(
            'div',
            { class: 'studio__grid studio__grid--mobs', role: 'list' },
            M.TYPES.filter((t) => t.group === g).map((t) =>
              h(
                'button',
                {
                  class: 'studio__tile studio__tile--mob',
                  type: 'button',
                  role: 'listitem',
                  title: t.label,
                  'aria-label': t.label,
                  'aria-pressed': String(t.key === S.mob),
                  dataset: { mob: t.key },
                  onclick: () => {
                    S.mob = t.key;
                    setTool('place');
                    renderTools();
                  },
                },
                mobIcon(t.key, 40, t.key === 'player' ? S.mobSkin : null, t.key === 'player' && S.mobSlim),
                h('span', { class: 'studio__tile-label', text: t.label })
              )
            )
          )
        )
      );
      UI.append(panel, [
        h('div', { class: 'studio__group' }, h('div', { class: 'studio__row-between' }, toolBtns, counter), gridBox),
        group('Ставится', brush),
        S.mob === 'player' &&
          skinPicker({
            value: S.mobSkin,
            label: 'Какого игрока ставить',
            onPick: (skin, slim) => {
              S.mobSkin = skin;
              S.mobSlim = !!slim;
              renderTools();
            },
          }),
        selected,
        group('На сцене', placed, h('div', { class: 'actions-row' }, clearAll)),
        group('Мобы', ...tiles),
      ]);
    }

    /* «Свои картинки» */
    function renderTextures() {
      const A = art();
      const list = cur().textures || [];
      const max = LOOK.textures.max;
      const input = h('input', { class: 'visually-hidden', type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', id: 'studio-tex-file' });
      input.addEventListener('change', () => {
        const file = input.files[0];
        input.value = '';
        if (file) addTexture(file);
      });
      const full = list.length >= max;
      const upload = full
        ? h('p', { class: 'field__hint', text: `Уже ${max} картинки — больше нельзя. Удалите одну, чтобы добавить другую.` })
        : h('label', { class: 'btn btn--sm', for: 'studio-tex-file' }, icon('upload'), 'Загрузить картинку');
      const rows = list.map((src, i) => {
        const id = 'tex' + (i + 1);
        return h(
          'li',
          { class: 'studio__tex' },
          h('img', { class: 'studio__tex-img', src: Api.textureUrl(src), alt: `Своя картинка ${i + 1}`, width: '64', height: '64' }),
          h(
            'div',
            { class: 'studio__tex-body' },
            h('p', { class: 'studio__current-name', text: `Картинка ${i + 1}` }),
            h(
              'div',
              { class: 'studio__tex-actions' },
              LOOK.slots.map((slot) =>
                h('button', {
                  class: 'btn btn--sm btn--ghost',
                  type: 'button',
                  'aria-pressed': String(!!heldIn(slot) && heldIn(slot).id === id),
                  text: slot === 'head' ? 'На голову' : SLOT_TO[slot].replace(/^в /, 'В '),
                  onclick: () => {
                    assignHeld(slot, id);
                    renderTools();
                    UI.toast(`Картинка ${i + 1} — ${SLOT_TO[slot]}`);
                  },
                })
              ),
              A &&
                h('button', {
                  class: 'btn btn--sm btn--ghost',
                  type: 'button',
                  text: 'Ставить блоком',
                  onclick: () => {
                    S.brush = id;
                    S.tab = 'blocks';
                    renderTools();
                    setTool('place');
                  },
                }),
              h('button', {
                class: 'btn btn--sm btn--ghost studio__tex-del',
                type: 'button',
                text: 'Удалить',
                onclick: async () => {
                  const used = Object.values(cur().held || {}).some((e) => e && e.id === id) || blocksOf().some((b) => b.id === id);
                  if (used) {
                    const ok = await UI.confirm({ title: 'Удалить картинку?', text: 'Предметы и блоки с этой картинкой тоже уберутся.', confirmText: 'Удалить', danger: true });
                    if (!ok || !alive) return;
                  }
                  removeTexture(i);
                  renderTools();
                },
              })
            )
          )
        );
      });
      UI.append(panel, [
        h('p', { class: 'card-sub', text: `Своя картинка — в своём разрешении, до ${LOOK.textures.maxSide} × ${LOOK.textures.maxSide} точек. Её можно дать в руку, надеть на голову или поставить блоком. До ${max} картинок в каждом виде.` }),
        !A && notice('Картинки сохранятся, но увидеть их на персонаже можно будет, когда на странице появится каталог Minecraft — он рисует предметы и блоки.'),
        rows.length ? h('ul', { class: 'studio__texs' }, rows) : h('p', { class: 'field__hint', text: 'Своих картинок пока нет.' }),
        h('div', { class: 'actions-row' }, input, upload),
        h('p', { class: 'field__hint', text: 'PNG, JPG, WebP или GIF до 8 МБ. После загрузки выберите квадрат и размер: «как есть» — без потери чёткости, меньше — для пиксель-арта.' }),
      ]);
    }

    /* ---------------------------------------------------- клавиши и уход со страницы */

    function onKey(e) {
      if (!S.looks || document.body.classList.contains('has-modal')) return;
      const t = e.target;
      const typing = t && t.closest && t.closest('input:not([type=range]):not([type=checkbox]), textarea, select, [contenteditable]');
      if ((e.ctrlKey || e.metaKey) && !e.altKey) {
        if (e.code === 'KeyZ' && !typing) {
          e.preventDefault();
          if (e.shiftKey) redo();
          else undo();
        } else if (e.code === 'KeyY' && !typing) {
          e.preventDefault();
          redo();
        } else if (e.code === 'KeyS') {
          e.preventDefault();
          save(VIEWS);
        }
        return;
      }
      if (typing) return;
      const mode = !e.altKey && { KeyV: 'move', KeyR: 'rotate', KeyS: 'scale' }[e.code];
      if (mode) {
        e.preventDefault();
        setMode(mode);
        return;
      }
      if (e.code === 'KeyC' && !e.altKey) {
        e.preventDefault();
        setCameraMode(!S.cameraMode);
        return;
      }
      if (e.key === 'Escape' && S.cameraMode) {
        setCameraMode(false);
        e.preventDefault();
      } else if (e.key === 'Escape' && S.tool !== 'select') {
        setTool('select');
        e.preventDefault();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && poser && t === poser.canvas) {
        if (removeSelected()) e.preventDefault();
      }
    }
    const onUnload = (e) => {
      if (!anyDirty()) return;
      e.preventDefault();
      e.returnValue = '';
    };
    document.addEventListener('keydown', onKey);
    window.addEventListener('beforeunload', onUnload);
    // На широком экране студия — во весь экран (lk.css, .is-studio).
    document.documentElement.classList.add('is-studio');

    function destroy() {
      if (!alive) return;
      if (anyDirty()) {
        draft = { looks: clone(S.looks), saved: { ...S.saved }, view: S.view };
        UI.toast('Изменения в студии не сохранены', { timeout: 8000, action: { label: 'Вернуться', onClick: () => (location.hash = '#/studio') } });
      }
      alive = false;
      document.documentElement.classList.remove('is-studio');
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('beforeunload', onUnload);
      if (pending) cancelAnimationFrame(pending);
      clearTimeout(groupTimer);
      if (resize) resize.disconnect();
      if (poser) poser.destroy();
      if (viewer) viewer.destroy();
    }

    load();
    return { destroy, dirty: anyDirty };
  }

  window.Studio = { mount };
})();
