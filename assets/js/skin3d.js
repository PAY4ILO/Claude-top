/*
 * Скин Minecraft в 3D на <canvas>, без библиотек. Проекция ортогональная, поэтому каждая грань коробки —
 * параллелограмм, и её можно нарисовать одним drawImage с аффинным преобразованием. Пиксели не размываются
 * (imageSmoothingEnabled = false). Позы — повороты рук, ног и головы вокруг суставов.
 *
 *   Skin3D.load(url)                     → Promise<canvas 64×64> (старые скины 64×32 достраиваются)
 *   Skin3D.draw(canvas, skin, opts)      — один кадр: { slim, pose, yaw, pitch, time }
 *   Skin3D.viewer({ url, slim, pose, label }) → { el, set({url, slim, pose}), destroy() } — крутится мышью/пальцем/стрелками
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

  /* ------------------------------------------------------------ рисование */

  const CENTER_Y = 17; // середина модели по высоте (с поднятыми руками)
  const HEIGHT = 40; // сколько единиц модели помещается по высоте холста
  const WIDTH = 26;

  /**
   * Один кадр. canvas — уже нужного размера (в пикселях устройства), skin — 64×64 из load().
   * yaw/pitch — поворот камеры в градусах, pose — ключ позы, time — секунды анимации (null — без анимации).
   */
  function draw(canvas, skin, opts = {}) {
    const g = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!skin) return;
    g.imageSmoothingEnabled = false;
    const scale = Math.min(W / WIDTH, H / HEIGHT) * (opts.zoom || 1);
    const cx = W / 2;
    const cy = H / 2 + (opts.shiftY || 0) * scale;
    const yaw = opts.yaw === undefined ? 25 : opts.yaw;
    const pitch = opts.pitch === undefined ? 10 : opts.pitch;
    const angles = pose(POSE_KEYS.includes(opts.pose) ? opts.pose : 'stand', opts.time);

    // Модель → вид: поворот части вокруг сустава, подъём (сидит), центр, камера.
    const toView = (part, p) => {
      const local = add(rotate(sub(p, part.pivot), angles[part.key]), part.pivot);
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
        },
      };
    };

    const queue = model(opts.slim).map((part) => {
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
    const state = { url: opts.url, slim: !!opts.slim, pose: opts.pose || 'stand', yaw: 25, pitch: 10, skin: null, playing: !reducedMotion() && opts.animate !== false };
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
      draw(canvas, state.skin, { slim: state.slim, pose: state.pose, yaw: state.yaw, pitch: state.pitch, time: state.playing ? (now - started) / 1000 : null });
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
      if (next.pose) state.pose = next.pose;
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
    return { el, canvas, set, destroy, get state() { return { ...state, skin: undefined }; } };
  }

  /**
   * Неподвижная картинка для карточки в сетке: персонаж в позе, вполоборота.
   * Возвращает <canvas>; скин догружается сам.
   */
  function figure({ url, slim, pose: poseKey, width = 150, height = 190, label }) {
    const canvas = document.createElement('canvas');
    canvas.className = 'skin3d__figure';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', label || 'Скин игрока');
    fit(canvas, width, height);
    load(url)
      .then((skin) => draw(canvas, skin, { slim, pose: poseKey, yaw: 28, pitch: 8 }))
      .catch(() => {});
    return canvas;
  }

  window.Skin3D = { POSES, load, draw, viewer, figure, guessSlim, fit };
})();
