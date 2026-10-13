/*
 * Скин Minecraft в 3D на <canvas>, без библиотек. Проекция ортогональная, поэтому каждая грань коробки —
 * параллелограмм, и её можно нарисовать одним drawImage с аффинным преобразованием. Пиксели не размываются
 * (imageSmoothingEnabled = false). Позы — повороты рук, ног и головы вокруг суставов.
 *
 *   Skin3D.load(url)                     → Promise<canvas 64×64> (старые скины 64×32 достраиваются)
 *   Skin3D.draw(canvas, skin, opts)      — один кадр: { slim, pose, angles, zoom, yaw, pitch, time }
 *   Skin3D.viewer({ url, slim, pose, look, label }) → { el, set({url, slim, pose, look}), destroy() } — крутится мышью/пальцем/стрелками
 *   Skin3D.figure({ url, slim, pose, look }) → <canvas> с методом update(look) — неподвижная картинка для карточки
 *   Skin3D.poser({ url, slim, look, part, yaw, pitch, onSelect, onStart, onChange, onEnd }) → { el, set({look, part}), resetCamera(), destroy() }
 *                                        — редактор позы как в Blockbench: нажать на часть тела, тянуть цветные кольца
 *   Skin3D.poseAngles(key)               — углы позы без анимации (с них начинается «Своя поза»)
 *   look — как стоит персонаж на карточке: { pose: ключ | 'custom', angles (у custom), scale, turn } (см. Api.LOOK)
 *   Skin3D.guessSlim(skin)               — тонкие ли руки (по пустым пикселям, как это определяет сама игра — никак, поэтому «угадать»)
 *   Skin3D.POSES                         — [{ key, label }]
 */
(function () {
  'use strict';

  const DEG = Math.PI / 180;

  const POSES = [
    { key: 'stand', label: 'Стоит' },
    { key: 'wave', label: 'Машет' },
    { key: 'walk', label: 'Идёт' },
    { key: 'cheer', label: 'Ура!' },
    { key: 'point', label: 'Указывает' },
    { key: 'sit', label: 'Сидит' },
  ];
  const POSE_KEYS = POSES.map((p) => p.key);
  const PARTS = [
    { key: 'head', label: 'Голова' },
    { key: 'body', label: 'Тело' },
    { key: 'rightArm', label: 'Правая рука' },
    { key: 'leftArm', label: 'Левая рука' },
    { key: 'rightLeg', label: 'Правая нога' },
    { key: 'leftLeg', label: 'Левая нога' },
  ];

  /* ------------------------------------------------------------ модель */

  // y — вверх, лицо смотрит на +z, правая рука игрока — на −x (слева, если смотреть ему в лицо).
  // at — нижний угол коробки, uv — где текстура в файле скина, ov — второй слой (шапка, куртка…), pivot — сустав.
  function model(slim) {
    const aw = slim ? 3 : 4;
    return [
      { key: 'head', size: [8, 8, 8], at: [-4, 24, -4], uv: [0, 0], ov: [32, 0], pivot: [0, 24, 0], grow: 0.5 },
      { key: 'body', size: [8, 12, 4], at: [-4, 12, -2], uv: [16, 16], ov: [16, 32], pivot: [0, 12, 0], grow: 0.25 },
      { key: 'rightArm', size: [aw, 12, 4], at: [-4 - aw, 12, -2], uv: [40, 16], ov: [40, 32], pivot: [-5, 22, 0], grow: 0.25 },
      { key: 'leftArm', size: [aw, 12, 4], at: [4, 12, -2], uv: [32, 48], ov: [48, 48], pivot: [5, 22, 0], grow: 0.25 },
      { key: 'rightLeg', size: [4, 12, 4], at: [-4, 0, -2], uv: [0, 16], ov: [0, 32], pivot: [-2, 12, 0], grow: 0.25 },
      { key: 'leftLeg', size: [4, 12, 4], at: [0, 0, -2], uv: [16, 48], ov: [0, 48], pivot: [2, 12, 0], grow: 0.25 },
    ];
  }

  // Шесть граней коробки: угол, откуда идёт текстура (её левый верхний пиксель), направления вдоль u и v
  // и прямоугольник в файле скина (стандартная развёртка Minecraft: правый бок, перед, левый бок, зад; сверху — верх и низ).
  function faces(x0, y0, z0, x1, y1, z1, u, v, w, h, d) {
    const X = x1 - x0;
    const Y = y1 - y0;
    const Z = z1 - z0;
    return [
      { o: [x0, y1, z1], U: [X, 0, 0], V: [0, -Y, 0], tex: [u + d, v + d, w, h] }, // перед
      { o: [x1, y1, z0], U: [-X, 0, 0], V: [0, -Y, 0], tex: [u + 2 * d + w, v + d, w, h] }, // зад
      { o: [x0, y1, z0], U: [0, 0, Z], V: [0, -Y, 0], tex: [u, v + d, d, h] }, // правый бок (−x)
      { o: [x1, y1, z1], U: [0, 0, -Z], V: [0, -Y, 0], tex: [u + d + w, v + d, d, h] }, // левый бок (+x)
      { o: [x0, y1, z0], U: [X, 0, 0], V: [0, 0, Z], tex: [u + d, v, w, d] }, // верх
      { o: [x0, y0, z1], U: [X, 0, 0], V: [0, 0, -Z], tex: [u + d + w, v, w, d] }, // низ
    ];
  }

  /* ------------------------------------------------------------ позы */

  // Углы в градусах [rx, ry, rz]. rz < 0 поднимает правую руку в сторону, rx < 0 — вперёд (к зрителю).
  // t — время в секундах для анимации или null для неподвижной картинки.
  function pose(key, t) {
    const a = t === null || t === undefined ? 0 : t;
    const moving = t !== null && t !== undefined;
    const breathe = moving ? Math.sin(a * 2) * 2 : 0;
    const p = {
      head: [0, 0, 0],
      body: [0, 0, 0],
      rightArm: [0, 0, -4 - breathe],
      leftArm: [0, 0, 4 + breathe],
      rightLeg: [0, 0, 0],
      leftLeg: [0, 0, 0],
      lift: 0,
    };
    switch (key) {
      case 'wave':
        p.rightArm = [0, 0, -150 + (moving ? Math.sin(a * 7) * 18 : 0)];
        p.head = [0, 0, 6];
        break;
      case 'walk': {
        const s = moving ? Math.sin(a * 5) : 0.85;
        p.rightArm = [35 * s, 0, -3];
        p.leftArm = [-35 * s, 0, 3];
        p.rightLeg = [-32 * s, 0, 0];
        p.leftLeg = [32 * s, 0, 0];
        break;
      }
      case 'cheer': {
        const s = moving ? Math.sin(a * 6) * 8 : 0;
        p.rightArm = [0, 0, -162 + s];
        p.leftArm = [0, 0, 162 - s];
        p.head = [-12, 0, 0];
        break;
      }
      case 'point':
        p.rightArm = [-88 + breathe, 12, 0];
        p.head = [4, -8, 0];
        break;
      case 'sit':
        p.rightLeg = [-88, 10, 0];
        p.leftLeg = [-88, -10, 0];
        p.rightArm = [-40 + breathe, 0, -4];
        p.leftArm = [-40 + breathe, 0, 4];
        p.head = [6, 0, 0];
        p.lift = -10;
        break;
      default:
        p.head = [moving ? Math.sin(a * 0.9) * 3 : 0, moving ? Math.sin(a * 0.5) * 10 : 0, 0];
    }
    return p;
  }

  /** Углы позы без анимации — копия, её можно менять. */
  function poseAngles(key) {
    const p = pose(POSE_KEYS.includes(key) ? key : 'stand', null);
    const out = { lift: p.lift };
    for (const { key: part } of PARTS) out[part] = p[part].map((x) => Math.round(x));
    return out;
  }

  /** Своя поза (углы из look.angles), недостающее — как «Стоит». */
  function customPose(angles) {
    const p = pose('stand', null);
    for (const { key } of PARTS) if (Array.isArray(angles[key]) && angles[key].length === 3) p[key] = angles[key].map(Number);
    p.lift = Number(angles.lift) || 0;
    return p;
  }

  /** look → настройки draw(): поза, свои углы, размер, поворот (yaw — поворот камеры по умолчанию для этого вида). */
  function lookOpts(look, yaw) {
    const l = look || {};
    return {
      pose: l.pose === 'custom' && l.angles ? 'custom' : l.pose,
      angles: l.pose === 'custom' ? l.angles : null,
      zoom: typeof l.scale === 'number' ? l.scale : 1,
      yaw: yaw + (Number(l.turn) || 0),
    };
  }

  /* ------------------------------------------------------------ математика */

  function rotate(v, [rx, ry, rz]) {
    let [x, y, z] = v;
    if (rz) {
      const c = Math.cos(rz * DEG);
      const s = Math.sin(rz * DEG);
      [x, y] = [x * c - y * s, x * s + y * c];
    }
    if (rx) {
      const c = Math.cos(rx * DEG);
      const s = Math.sin(rx * DEG);
      [y, z] = [y * c - z * s, y * s + z * c];
    }
    if (ry) {
      const c = Math.cos(ry * DEG);
      const s = Math.sin(ry * DEG);
      [x, z] = [x * c + z * s, -x * s + z * c];
    }
    return [x, y, z];
  }

  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => mul(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));

  /* ------------------------------------------------------------ рисование */

  const ATTACHED = new Set(['head', 'rightArm', 'leftArm']);
  const CENTER_Y = 17; // середина модели по высоте (с поднятыми руками)
  const HEIGHT = 40; // сколько единиц модели помещается по высоте холста
  const WIDTH = 26;

  /**
   * Один кадр. canvas — уже нужного размера (в пикселях устройства), skin — 64×64 из load().
   * yaw/pitch — поворот камеры в градусах, pose — ключ позы ('custom' — углы из angles), time — секунды анимации (null — без анимации).
   * zoom — размер фигуры: растёт вверх от ног, ноги остаются на месте.
   * hits — массив: в него попадут нарисованные грани { key, poly } (для выбора части мышью), в порядке рисования.
   * Возвращает, как модель легла на холст (для колец редактора позы), или null без скина.
   */
  function draw(canvas, skin, opts = {}) {
    const g = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!skin) return null;
    g.imageSmoothingEnabled = false;
    const fitScale = Math.min(W / WIDTH, H / HEIGHT);
    const zoom = opts.zoom || 1;
    const scale = fitScale * zoom;
    const cx = W / 2;
    const cy = H / 2 + (opts.shiftY || 0) * scale + CENTER_Y * fitScale * (1 - zoom);
    const yaw = opts.yaw === undefined ? 25 : opts.yaw;
    const pitch = opts.pitch === undefined ? 10 : opts.pitch;
    const angles = opts.pose === 'custom' && opts.angles ? customPose(opts.angles) : pose(POSE_KEYS.includes(opts.pose) ? opts.pose : 'stand', opts.time);

    // Модель → вид: поворот части вокруг сустава, подъём (сидит), центр, камера.
    // Голова и руки крепятся к телу: наклонили тело — они наклоняются вместе с ним (ноги — нет).
    const BODY_PIVOT = [0, 12, 0];
    const bodyTurned = angles.body.some((x) => x);
    const toView = (part, p) => {
      let local = add(rotate(sub(p, part.pivot), angles[part.key]), part.pivot);
      if (bodyTurned && ATTACHED.has(part.key)) local = add(rotate(sub(local, BODY_PIVOT), angles.body), BODY_PIVOT);
      local[1] += angles.lift - CENTER_Y;
      return rotate(rotate(local, [0, yaw, 0]), [pitch, 0, 0]);
    };
    const toScreen = (p) => [cx + p[0] * scale, cy - p[1] * scale];
    const seam = 0.5 / scale; // грани чуть шире, чтобы между ними не просвечивали щели

    const drawFace = (f, part) => {
      const p0 = toView(part, f.o);
      const pu = toView(part, add(f.o, f.U));
      const pv = toView(part, add(f.o, f.V));
      const du = sub(pu, p0);
      const dv = sub(pv, p0);
      const nz = dv[0] * du[1] - dv[1] * du[0]; // z нормали: > 0 — грань смотрит на зрителя
      const [sx, sy, tw, th] = f.tex;
      const s0 = toScreen(p0);
      const su = toScreen(pu);
      const sv = toScreen(pv);
      return {
        nz,
        paint() {
          g.setTransform((su[0] - s0[0]) / tw, (su[1] - s0[1]) / tw, (sv[0] - s0[0]) / th, (sv[1] - s0[1]) / th, s0[0], s0[1]);
          g.drawImage(skin, sx, sy, tw, th, -seam, -seam, tw + 2 * seam, th + 2 * seam);
          if (opts.hits) opts.hits.push({ key: part.key, poly: [s0, su, [su[0] + sv[0] - s0[0], su[1] + sv[1] - s0[1]], sv] });
        },
      };
    };

    const parts = model(opts.slim);
    const queue = parts.map((part) => {
      const [w, h, d] = part.size;
      const [x0, y0, z0] = part.at;
      const box = (grow, [u, v]) => faces(x0 - grow, y0 - grow, z0 - grow, x0 + w + grow, y0 + h + grow, z0 + d + grow, u, v, w, h, d).map((f) => drawFace(f, part));
      const center = toView(part, [x0 + w / 2, y0 + h / 2, z0 + d / 2]);
      return { depth: center[2], inner: box(0, part.uv), outer: box(part.grow, part.ov) };
    });
    // Дальние части — первыми. Внутри части: изнанка второго слоя, сама часть, второй слой.
    queue.sort((a, b) => a.depth - b.depth);
    for (const q of queue) {
      for (const f of q.outer) if (f.nz < -1e-6) f.paint();
      for (const f of q.inner) if (f.nz > 1e-6) f.paint();
      for (const f of q.outer) if (f.nz > 1e-6) f.paint();
    }
    g.setTransform(1, 0, 0, 1, 0, 0);

    // Направление из мира модели в вид (только камера) и из системы родителя части в вид.
    const camera = (d) => rotate(rotate(d, [0, yaw, 0]), [pitch, 0, 0]);
    const fromParent = (key, d) => camera(bodyTurned && ATTACHED.has(key) ? rotate(d, angles.body) : d);
    return {
      scale,
      toScreen,
      camera,
      /** Сустав части в координатах вида. */
      pivot: (key) => {
        const part = parts.find((p) => p.key === key);
        return toView(part, part.pivot);
      },
      /**
       * Оси, вокруг которых поворачивают углы [rx, ry, rz] этой части (как «гимбал» в Blockbench):
       * поворот считается rz → rx → ry, поэтому ось ry — вертикаль родителя, rx — после ry, rz — после rx и ry.
       */
      axes: (key) => {
        const [rx, ry] = angles[key];
        return [rotate([1, 0, 0], [0, ry, 0]), [0, 1, 0], rotate([0, 0, 1], [rx, ry, 0])].map((d) => norm(fromParent(key, d)));
      },
    };
  }

  /* ------------------------------------------------------------ загрузка */

  const cache = new Map();

  /** Старый скин 64×32: левые рука и нога — зеркальные правые (как делает игра). */
  function upgrade(img) {
    const c = document.createElement('canvas');
    c.width = 64;
    c.height = 64;
    const g = c.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(img, 0, 0);
    if (img.height === 32) {
      const mirror = (sx, sy, w, h, dx, dy) => {
        g.save();
        g.translate(dx + w, dy);
        g.scale(-1, 1);
        g.drawImage(img, sx, sy, w, h, 0, 0, w, h);
        g.restore();
      };
      const limb = (u, v, du, dv) => {
        mirror(u + 4, v, 4, 4, du + 4, dv); // верх
        mirror(u + 8, v, 4, 4, du + 8, dv); // низ
        mirror(u + 8, v + 4, 4, 12, du, dv + 4); // левый бок → правый
        mirror(u + 4, v + 4, 4, 12, du + 4, dv + 4); // перед
        mirror(u, v + 4, 4, 12, du + 8, dv + 4); // правый бок → левый
        mirror(u + 12, v + 4, 4, 12, du + 12, dv + 4); // зад
      };
      limb(0, 16, 16, 48);
      limb(40, 16, 32, 48);
    }
    return c;
  }

  /** { cache: false } — не запоминать (файл, который только выбрали, а не скин с сайта). */
  function load(url, { cache: keep = true } = {}) {
    if (keep && cache.has(url)) return cache.get(url);
    const p = new Promise((resolve, reject) => {
      const img = new Image();
      img.decoding = 'async';
      img.onload = () => {
        if (img.width !== 64 || (img.height !== 64 && img.height !== 32)) reject(new Error('Скин должен быть PNG 64×64 или 64×32.'));
        else resolve(upgrade(img));
      };
      img.onerror = () => reject(new Error('Не удалось загрузить скин.'));
      img.src = url;
    });
    if (!keep) return p;
    cache.set(url, p);
    p.catch(() => cache.delete(url));
    if (cache.size > 300) cache.delete(cache.keys().next().value);
    return p;
  }

  /** Тонкие руки: у таких скинов полоса справа от правой руки (x 54–55, y 20–31) пустая. */
  function guessSlim(skin) {
    try {
      const data = skin.getContext('2d').getImageData(54, 20, 2, 12).data;
      for (let i = 3; i < data.length; i += 4) if (data[i] !== 0) return false;
      return true;
    } catch {
      return false;
    }
  }

  /* ------------------------------------------------------------ холст по размеру элемента */

  /** Подогнать размер холста под его CSS-размер (с учётом плотности экрана). */
  function fit(canvas, w, h) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    const W = Math.round((w || canvas.clientWidth || 160) * dpr);
    const H = Math.round((h || canvas.clientHeight || 200) * dpr);
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
  }

  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* ------------------------------------------------------------ просмотр с поворотом */

  /**
   * Крутится мышью или пальцем, стрелками с клавиатуры; анимация позы — кнопкой (при «уменьшить движение» выключена).
   * Остановится сам, когда элемент уберут со страницы.
   */
  function viewer(opts = {}) {
    const BASE_YAW = 25;
    const state = { url: opts.url, slim: !!opts.slim, look: opts.look || { pose: opts.pose || 'stand' }, yaw: BASE_YAW, pitch: 10, skin: null, playing: !reducedMotion() && opts.animate !== false };
    state.yaw = lookOpts(state.look, BASE_YAW).yaw;
    const canvas = document.createElement('canvas');
    canvas.className = 'skin3d__canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    const label = () => `${opts.label || 'Скин'}. Стрелки или перетаскивание — повернуть.`;
    canvas.setAttribute('aria-label', label());

    const play = document.createElement('button');
    play.type = 'button';
    play.className = 'skin3d__play btn btn--sm btn--ghost';
    const syncPlay = () => {
      play.textContent = state.playing ? 'Пауза' : 'Анимация';
      play.setAttribute('aria-pressed', String(state.playing));
    };
    syncPlay();

    const el = document.createElement('div');
    el.className = 'skin3d';
    el.append(canvas, play);

    let frame = 0;
    let started = performance.now();
    let alive = true;
    const render = (now) => {
      frame = 0;
      if (!alive) return;
      if (!el.isConnected) {
        // Ещё не вставлен — подождём; уже убран — всё.
        if (el.dataset.mounted) return destroy();
        frame = requestAnimationFrame(render);
        return;
      }
      el.dataset.mounted = '1';
      fit(canvas);
      const look = lookOpts(state.look, 0);
      draw(canvas, state.skin, { slim: state.slim, pose: look.pose, angles: look.angles, zoom: look.zoom, yaw: state.yaw, pitch: state.pitch, time: state.playing ? (now - started) / 1000 : null });
      if (state.playing) frame = requestAnimationFrame(render);
    };
    const redraw = () => {
      if (!frame) frame = requestAnimationFrame(render);
    };

    play.addEventListener('click', () => {
      state.playing = !state.playing;
      started = performance.now();
      syncPlay();
      redraw();
    });

    let drag = null;
    canvas.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, y: e.clientY, yaw: state.yaw, pitch: state.pitch };
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      state.yaw = drag.yaw + (e.clientX - drag.x) * 0.7;
      state.pitch = Math.max(-30, Math.min(45, drag.pitch + (e.clientY - drag.y) * 0.4));
      redraw();
    });
    const stop = () => {
      drag = null;
    };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    canvas.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: [-15, 0], ArrowRight: [15, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] }[e.key];
      if (!step) return;
      e.preventDefault();
      state.yaw += step[0];
      state.pitch = Math.max(-30, Math.min(45, state.pitch + step[1]));
      redraw();
    });

    function set(next = {}) {
      if (next.slim !== undefined) state.slim = !!next.slim;
      if (next.pose) state.look = { ...state.look, pose: next.pose, angles: undefined };
      if (next.look) {
        // Поворот поменяли в настройках — камера встаёт, как задано; иначе остаётся, куда её повернули.
        if ((Number(next.look.turn) || 0) !== (Number(state.look.turn) || 0)) state.yaw = lookOpts(next.look, BASE_YAW).yaw;
        state.look = next.look;
      }
      if (next.label) {
        opts.label = next.label;
        canvas.setAttribute('aria-label', label());
      }
      if (next.url && next.url !== state.url) {
        state.url = next.url;
        loadInto(next.url);
      }
      redraw();
    }

    function loadInto(url) {
      el.classList.add('is-loading');
      load(url)
        .then((skin) => {
          if (state.url !== url) return;
          state.skin = skin;
          el.classList.remove('is-loading');
          redraw();
        })
        .catch(() => el.classList.remove('is-loading'));
    }

    function destroy() {
      alive = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }

    if (state.url) loadInto(state.url);
    redraw();
    return { el, canvas, set, destroy, get state() { return { ...state, pose: state.look.pose, skin: undefined }; } };
  }

  /* ------------------------------------------------------------ редактор позы (как в Blockbench) */

  // Цвета осей — как в Blockbench: X красная, Y зелёная, Z синяя.
  const AXIS_COLORS = ['#f0484e', '#5cd65c', '#3d8bff'];
  const wrap180 = (v) => ((((v + 180) % 360) + 360) % 360) - 180;

  function inPoly([a, b, , d], x, y) {
    // Параллелограмм a, b, (b + d − a), d: x = a + s·(b − a) + t·(d − a), внутри — s, t от 0 до 1.
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const det = ux * vy - uy * vx;
    if (Math.abs(det) < 1e-9) return false;
    const px = x - a[0];
    const py = y - a[1];
    const s = (px * vy - py * vx) / det;
    const t = (ux * py - uy * px) / det;
    return s >= 0 && s <= 1 && t >= 0 && t <= 1;
  }

  function segDist(p, a, b) {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const k = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(p[0] - a[0] - k * dx, p[1] - a[1] - k * dy);
  }

  /**
   * Нажать на голову, тело, руку или ногу — вокруг сустава появятся три кольца; тянуть кольцо — поворот вокруг
   * этой оси (Shift — шагом 15°). У тела ещё зелёная стрелка «присесть» у правого края. Пустое место — повернуть камеру.
   * Меняет look.angles на месте; onChange(part) — после каждого шага, onStart/onEnd — начало и конец движения.
   */
  function poser(opts = {}) {
    const baseYaw = opts.yaw === undefined ? 25 : opts.yaw;
    const basePitch = opts.pitch === undefined ? 10 : opts.pitch;
    const state = { url: opts.url, slim: !!opts.slim, look: opts.look, part: opts.part || null, yaw: 0, pitch: basePitch, skin: null };
    const canvas = document.createElement('canvas');
    canvas.className = 'skin3d__canvas poser__canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', `${opts.label || 'Своя поза'}. Нажмите на часть тела и тяните цветные кольца; стрелки — повернуть камеру.`);
    const el = document.createElement('div');
    el.className = 'skin3d poser';
    el.append(canvas);

    let info = null; // как модель легла на холст в последнем кадре
    let hits = [];
    let gizmo = null; // кольца выбранной части в пикселях холста
    let hover = null;
    let drag = null;
    let frame = 0;
    let alive = true;

    function resetCamera() {
      state.yaw = lookOpts(state.look, baseYaw).yaw;
      state.pitch = basePitch;
      redraw();
    }

    function buildGizmo() {
      if (!info || !state.part) return null;
      const dpr = canvas.width / (canvas.clientWidth || canvas.width);
      const px = Math.max(44 * dpr, Math.min(canvas.width, canvas.height) * 0.2);
      const R = px / info.scale;
      const c = info.pivot(state.part);
      const cs = info.toScreen(c);
      const rings = info.axes(state.part).map((A, i) => {
        const u = norm(cross(A, Math.abs(A[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0]));
        const v = cross(A, u);
        const pts = [];
        for (let k = 0; k <= 64; k++) {
          const t = (k / 64) * Math.PI * 2;
          const p = add(c, add(mul(u, R * Math.cos(t)), mul(v, R * Math.sin(t))));
          pts.push({ p, s: info.toScreen(p), front: p[2] >= c[2] });
        }
        return { i, A, pts };
      });
      // «Присесть» — стрелка у правого края на высоте пояса: на самой фигуре она закрывала бы ноги.
      let arrow = null;
      if (state.part === 'body') {
        const down = info.camera([0, -1, 0]);
        const x = canvas.width - 32 * dpr;
        const y = Math.max(40 * dpr, Math.min(canvas.height - 56 * dpr, cs[1]));
        arrow = { from: [x, y - 26 * dpr], to: [x, y + 26 * dpr], perUnit: [down[0] * info.scale, -down[1] * info.scale] };
      }
      return { c, cs, R, px, dpr, rings, arrow };
    }

    function paintGizmo() {
      const g = canvas.getContext('2d');
      const z = gizmo;
      g.save();
      g.lineCap = 'round';
      g.lineJoin = 'round';
      // Выбранная часть — тонкий контур.
      g.strokeStyle = 'rgba(255, 255, 255, 0.55)';
      g.lineWidth = 1.25 * z.dpr;
      for (const hit of hits) {
        if (hit.key !== state.part) continue;
        g.beginPath();
        hit.poly.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.closePath();
        g.stroke();
      }
      const active = (id) => (drag && drag.target === id) || (!drag && hover === id);
      // Сначала задние половины колец (бледно), потом передние.
      for (const front of [false, true]) {
        for (const ring of z.rings) {
          g.strokeStyle = AXIS_COLORS[ring.i];
          g.globalAlpha = front ? 1 : 0.3;
          g.lineWidth = (active(ring.i) ? 4 : 2.25) * z.dpr;
          g.beginPath();
          for (let k = 1; k < ring.pts.length; k++) {
            const a = ring.pts[k - 1];
            const b = ring.pts[k];
            if (a.front !== front && b.front !== front) continue;
            g.moveTo(a.s[0], a.s[1]);
            g.lineTo(b.s[0], b.s[1]);
          }
          g.stroke();
        }
      }
      g.globalAlpha = 1;
      if (z.arrow) {
        const { from, to } = z.arrow;
        const w = (active('lift') ? 4 : 2.5) * z.dpr;
        const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
        const head = 9 * z.dpr;
        g.strokeStyle = g.fillStyle = AXIS_COLORS[1];
        g.lineWidth = w;
        g.beginPath();
        g.moveTo(from[0], from[1]);
        g.lineTo(to[0] - Math.cos(ang) * head * 0.6, to[1] - Math.sin(ang) * head * 0.6);
        g.stroke();
        g.beginPath();
        g.moveTo(to[0], to[1]);
        g.lineTo(to[0] - Math.cos(ang - 0.45) * head, to[1] - Math.sin(ang - 0.45) * head);
        g.lineTo(to[0] - Math.cos(ang + 0.45) * head, to[1] - Math.sin(ang + 0.45) * head);
        g.closePath();
        g.fill();
        g.font = `600 ${11 * z.dpr}px system-ui, sans-serif`;
        g.textAlign = 'center';
        g.textBaseline = 'top';
        g.fillText('присесть', to[0], to[1] + 5 * z.dpr);
      }
      // Сустав.
      g.fillStyle = '#fff';
      g.beginPath();
      g.arc(z.cs[0], z.cs[1], 3 * z.dpr, 0, Math.PI * 2);
      g.fill();
      g.restore();
    }

    const render = () => {
      frame = 0;
      if (!alive) return;
      if (!el.isConnected) {
        if (el.dataset.mounted) return destroy();
        frame = requestAnimationFrame(render);
        return;
      }
      el.dataset.mounted = '1';
      fit(canvas);
      const look = lookOpts(state.look, 0);
      hits = [];
      info = draw(canvas, state.skin, { slim: state.slim, pose: look.pose, angles: look.angles, zoom: look.zoom, yaw: state.yaw, pitch: state.pitch, time: null, hits });
      gizmo = look.pose === 'custom' ? buildGizmo() : null;
      if (gizmo) paintGizmo();
    };
    const redraw = () => {
      if (!frame) frame = requestAnimationFrame(render);
    };

    /** Что под точкой холста: кольцо (0, 1, 2), стрелка 'lift', часть тела { part } или null. */
    function pick(x, y) {
      if (gizmo) {
        const near = 9 * gizmo.dpr;
        let best = null;
        for (const ring of gizmo.rings) {
          for (let k = 1; k < ring.pts.length; k++) {
            const a = ring.pts[k - 1];
            const d = segDist([x, y], a.s, ring.pts[k].s) - (a.front ? 2 * gizmo.dpr : 0);
            if (d < near && (!best || d < best.d)) best = { d, target: ring.i, ring, at: a };
          }
        }
        if (gizmo.arrow) {
          const d = segDist([x, y], gizmo.arrow.from, gizmo.arrow.to);
          if (d < near && (!best || d < best.d)) best = { d, target: 'lift' };
        }
        if (best) return best;
      }
      for (let k = hits.length - 1; k >= 0; k--) if (inPoly(hits[k].poly, x, y)) return { part: hits[k].key };
      return null;
    }

    const pointer = (e) => {
      const r = canvas.getBoundingClientRect();
      return [((e.clientX - r.left) * canvas.width) / (r.width || 1), ((e.clientY - r.top) * canvas.height) / (r.height || 1)];
    };

    canvas.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      const [x, y] = pointer(e);
      const hit = pick(x, y);
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // указатель уже отпущен — тянуть всё равно можно, пока он над холстом
      }
      const angles = state.look && state.look.angles;
      if (hit && hit.target === 'lift' && angles) {
        drag = { target: 'lift', x, y, from: angles.lift || 0 };
      } else if (hit && hit.target !== undefined && angles) {
        const { A } = hit.ring;
        const r = sub(hit.at.p, gizmo.c);
        const t3 = cross(A, r);
        drag = {
          target: hit.target,
          x,
          y,
          from: angles[state.part][hit.target],
          // Кольцо смотрит на нас — крутим вокруг центра; стоит ребром — тянем вдоль касательной.
          facing: Math.abs(A[2]) > 0.3 ? Math.sign(A[2]) : 0,
          phi: Math.atan2(y - gizmo.cs[1], x - gizmo.cs[0]),
          turned: 0,
          tangent: [t3[0] * info.scale, -t3[1] * info.scale],
          px: gizmo.px,
        };
      } else {
        drag = { target: 'camera', x, y, yaw: state.yaw, pitch: state.pitch, moved: false, part: hit && hit.part };
        return;
      }
      if (opts.onStart) opts.onStart(state.part);
      redraw();
    });

    canvas.addEventListener('pointermove', (e) => {
      const [x, y] = pointer(e);
      if (!drag) {
        const hit = pick(x, y);
        const next = hit ? (hit.target !== undefined ? hit.target : 'part') : null;
        canvas.style.cursor = next === null ? '' : next === 'part' ? 'pointer' : 'grab';
        if (next !== hover) {
          hover = next;
          redraw();
        }
        return;
      }
      const dpr = canvas.width / (canvas.clientWidth || canvas.width);
      if (drag.target === 'camera') {
        if (Math.hypot(x - drag.x, y - drag.y) > 4 * dpr) drag.moved = true;
        state.yaw = drag.yaw + ((x - drag.x) / dpr) * 0.7;
        state.pitch = Math.max(-30, Math.min(45, drag.pitch + ((y - drag.y) / dpr) * 0.4));
        redraw();
        return;
      }
      const angles = state.look.angles;
      if (drag.target === 'lift') {
        const u = gizmo.arrow.perUnit;
        const k = ((x - drag.x) * u[0] + (y - drag.y) * u[1]) / (u[0] * u[0] + u[1] * u[1] || 1);
        angles.lift = Math.max(-12, Math.min(0, Math.round(drag.from - k)));
      } else {
        let delta;
        if (drag.facing) {
          const phi = Math.atan2(y - gizmo.cs[1], x - gizmo.cs[0]);
          let d = phi - drag.phi;
          if (d > Math.PI) d -= Math.PI * 2;
          if (d < -Math.PI) d += Math.PI * 2;
          drag.phi = phi;
          drag.turned += d;
          delta = -drag.turned * drag.facing;
        } else {
          const t = drag.tangent;
          delta = ((x - drag.x) * t[0] + (y - drag.y) * t[1]) / Math.max(t[0] * t[0] + t[1] * t[1], (drag.px * 0.5) ** 2);
        }
        let v = drag.from + delta / DEG;
        if (e.shiftKey) v = Math.round(v / 15) * 15;
        angles[state.part][drag.target] = Math.round(wrap180(v));
      }
      redraw();
      if (opts.onChange) opts.onChange(state.part);
    });

    const stop = () => {
      if (!drag) return;
      const was = drag;
      drag = null;
      if (was.target === 'camera') {
        if (!was.moved && was.part && was.part !== state.part) {
          state.part = was.part;
          if (opts.onSelect) opts.onSelect(was.part);
        }
      } else if (opts.onEnd) opts.onEnd(state.part);
      redraw();
    };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    canvas.addEventListener('pointerleave', () => {
      if (!drag && hover !== null) {
        hover = null;
        redraw();
      }
    });
    canvas.addEventListener('keydown', (e) => {
      const step = { ArrowLeft: [-15, 0], ArrowRight: [15, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] }[e.key];
      if (!step) return;
      e.preventDefault();
      state.yaw += step[0];
      state.pitch = Math.max(-30, Math.min(45, state.pitch + step[1]));
      redraw();
    });

    function set(next = {}) {
      if (next.look) {
        if ((Number(next.look.turn) || 0) !== (Number(state.look && state.look.turn) || 0)) {
          state.look = next.look;
          resetCamera();
        }
        state.look = next.look;
      }
      if (next.part !== undefined) state.part = next.part;
      if (next.slim !== undefined) state.slim = !!next.slim;
      redraw();
    }

    function destroy() {
      alive = false;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    }

    resetCamera();
    el.classList.add('is-loading');
    load(state.url)
      .then((skin) => {
        state.skin = skin;
        el.classList.remove('is-loading');
        redraw();
      })
      .catch(() => el.classList.remove('is-loading'));
    return { el, canvas, set, resetCamera, destroy, get part() { return state.part; } };
  }

  /**
   * Неподвижная картинка для карточки в сетке: персонаж в позе, вполоборота.
   * Возвращает <canvas>; скин догружается сам.
   */
  function figure({ url, slim, pose: poseKey, look, width = 150, height = 190, label }) {
    const canvas = document.createElement('canvas');
    canvas.className = 'skin3d__figure';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', label || 'Скин игрока');
    fit(canvas, width, height);
    let current = look || { pose: poseKey };
    let skin = null;
    const paint = () => skin && draw(canvas, skin, { slim, pitch: 8, ...lookOpts(current, 28) });
    /** Другая поза/размер/поворот без перезагрузки скина (предпросмотр в редакторе). */
    canvas.update = (next) => {
      current = next || current;
      paint();
    };
    load(url)
      .then((s) => {
        skin = s;
        paint();
      })
      .catch(() => {});
    return canvas;
  }

  window.Skin3D = { POSES, PARTS, AXIS_COLORS, load, draw, viewer, poser, figure, poseAngles, guessSlim, fit };
})();
