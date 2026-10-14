/*
 * Скин Minecraft в 3D на <canvas>, без библиотек. Проекция ортогональная. Всё, что видно на сцене (персонаж, предметы,
 * блоки, головы, мобы), сначала превращается в список четырёхугольников (грань коробки, грань блока, слой предмета),
 * а потом рисуется через WebGL с буфером глубины: что ближе к камере, то и видно — рукоять меча в кулаке, а не поверх
 * руки. Нет WebGL — те же грани рисуются на 2D-холсте от дальних к ближним (как раньше). Пиксели не размываются.
 *
 *   Skin3D.load(url)                     → Promise<canvas 64×64> (старые скины 64×32 достраиваются)
 *   Skin3D.draw(canvas, skin, opts)      — один кадр (см. draw ниже)
 *   Skin3D.viewer({ url, slim, pose, look, label, rotate }) → { el, set({url, slim, pose, look}), destroy() } — крутится мышью/пальцем/стрелками
 *                                        (rotate: false — не крутится, стоит, как задано в look)
 *   Skin3D.figure({ url, slim, pose, look }) → <canvas> с методом update(look) — неподвижная картинка для карточки
 *   Skin3D.poser({ url, slim, look, part, yaw, pitch, zoom, scene, snap, target, frame, onSelect, onStart, onChange, onEnd, onTap })
 *                                        → { el, set({look, part, tool, mode, camera, cameraMode}), resetCamera(), zoomBy(k), destroy() }
 *                                        — редактор сцены как в Blockbench: нажать на часть тела, тянуть цветные ручки
 *   Skin3D.poseAngles(key)               — углы позы без анимации (с них начинается «Своя поза»)
 *   Skin3D.lookOpts(look, yaw, pitch)    — look → настройки draw() (камера вида, фигура, предметы, блоки, мобы)
 *   look — как стоит персонаж на карточке (см. Api.LOOK): { pose, angles, scale (приближение камеры), turn, offset (сдвиг кадра),
 *          camera: { yaw, pitch }, pos, size, held, blocks, mobs, textures }
 *   Skin3D.guessSlim(skin)               — тонкие ли руки (по пустым пикселям)
 *   Skin3D.drawMob(canvas, type, opts)   — значок моба для палитры
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
  const PART_KEYS = new Set(PARTS.map((p) => p.key));

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
      { o: [x0, y1, z1], U: [X, 0, 0], V: [0, -Y, 0], tex: [u + d, v + d, w, h], dir: 'south' }, // перед
      { o: [x1, y1, z0], U: [-X, 0, 0], V: [0, -Y, 0], tex: [u + 2 * d + w, v + d, w, h], dir: 'north' }, // зад
      { o: [x0, y1, z0], U: [0, 0, Z], V: [0, -Y, 0], tex: [u, v + d, d, h], dir: 'west' }, // правый бок (−x)
      { o: [x1, y1, z1], U: [0, 0, -Z], V: [0, -Y, 0], tex: [u + d + w, v + d, d, h], dir: 'east' }, // левый бок (+x)
      { o: [x0, y1, z0], U: [X, 0, 0], V: [0, 0, Z], tex: [u + d, v, w, d], dir: 'up' }, // верх
      { o: [x0, y0, z1], U: [X, 0, 0], V: [0, 0, -Z], tex: [u + d + w, v, w, d], dir: 'down' }, // низ
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
      case 'zombie': // только у мобов: руки вперёд
        p.rightArm = [-88, 0, -3];
        p.leftArm = [-88, 0, 3];
        break;
      default:
        p.head = [moving ? Math.sin(a * 0.9) * 3 : 0, moving ? Math.sin(a * 0.5) * 10 : 0, 0];
    }
    return p;
  }

  /** Углы позы без анимации — копия, её можно менять. */
  function poseAngles(key) {
    const p = pose([...POSE_KEYS, 'zombie'].includes(key) ? key : 'stand', null);
    const out = { lift: p.lift };
    for (const { key: part } of PARTS) out[part] = p[part].map((x) => Math.round(x));
    return out;
  }

  /** Своя поза (углы из look.angles), недостающее — как «Стоит». */
  function customPose(angles) {
    const p = pose('stand', null);
    for (const { key } of PARTS) if (Array.isArray(angles[key]) && angles[key].length === 3) p[key] = angles[key].map(Number);
    p.lift = Number(angles.lift) || 0;
    // Сдвиг частей тела [x, y, z] (в единицах модели, 16 = блок).
    if (angles.move && typeof angles.move === 'object') {
      p.move = {};
      for (const { key } of PARTS) if (Array.isArray(angles.move[key]) && angles.move[key].length === 3) p.move[key] = angles.move[key].map((x) => Number(x) || 0);
    }
    // Растяжение частей тела [x, y, z] вдоль своих осей (1 — как есть).
    if (angles.stretch && typeof angles.stretch === 'object') {
      p.stretch = {};
      for (const { key } of PARTS) if (Array.isArray(angles.stretch[key]) && angles.stretch[key].length === 3) p.stretch[key] = angles.stretch[key].map((x) => Number(x) || 1);
    }
    return p;
  }

  /**
   * look → настройки draw(). yaw/pitch — камера этого вида по умолчанию (карточка 28°/8°, окно игрока 25°/10°).
   * Есть look.camera — камера своя, а turn поворачивает только фигуру; нет (старые виды) — turn поворачивает камеру,
   * как было до появления своей камеры.
   */
  function lookOpts(look, yaw = 25, pitch = 10) {
    const l = look || {};
    const cam = l.camera && typeof l.camera === 'object' ? l.camera : null;
    return {
      pose: l.pose === 'custom' && l.angles ? 'custom' : l.pose,
      angles: l.pose === 'custom' ? l.angles : null,
      zoom: typeof l.scale === 'number' ? l.scale : 1,
      yaw: cam ? Number(cam.yaw) || 0 : yaw + (Number(l.turn) || 0),
      pitch: cam ? Number(cam.pitch) || 0 : pitch,
      figTurn: cam ? Number(l.turn) || 0 : 0,
      pos: Array.isArray(l.pos) ? l.pos : null,
      size: typeof l.size === 'number' ? l.size : 1,
      offset: l.offset || null,
      held: l.held || null,
      blocks: l.blocks || null,
      mobs: l.mobs || null,
      textures: l.textures || null,
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
  /** Поворот как ModelPart в игре: сначала x, потом y, потом z. */
  const rotateXYZ = (v, [rx, ry, rz]) => rotate(rotate(rotate(v, [rx, 0, 0]), [0, ry, 0]), [0, 0, rz]);

  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => mul(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));
  const det3 = (a, b, c) => a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);
  const hexRgb = (hex) => {
    const n = parseInt(String(hex).slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  };

  /* ------------------------------------------------------------ четырёхугольники */

  /*
   * Грань сцены: a — точка, где левый верхний угол текстуры (uv[0], uv[1]), b — правый верхний (uv[2], uv[1]),
   * d — левый нижний (uv[0], uv[3]); четвёртый угол — b + d − a. Точки — в координатах вида (x вправо, y вверх,
   * z к зрителю), uv — в точках текстуры (бывают «наоборот» — отражение). tint — оттенок '#rrggbb', shade — затенение,
   * key — что это на сцене (для выбора мышью), cull — не рисовать изнанку, cut — порог прозрачности,
   * skin — скин игрока (полупрозрачные точки рисуются как непрозрачные, как в игре).
   */
  function quad(a, b, d, tex, uv, o = {}) {
    return { a, b, d, tex, uv, tint: o.tint || null, shade: o.shade === undefined ? 1 : o.shade, key: o.key || null, cull: !!o.cull, cut: o.cut || 0.5, skin: !!o.skin };
  }

  /** Коробка → грани. xf — точка коробки → вид, mirror — отражение по x (левые руки и ноги старых развёрток). */
  function boxQuads(out, box, xf, o) {
    const [x0, y0, z0] = box.from;
    const [x1, y1, z1] = box.to;
    const [w, h, d] = box.size;
    const m = box.mirror ? (p) => xf([x0 + x1 - p[0], p[1], p[2]]) : xf;
    for (const f of faces(x0, y0, z0, x1, y1, z1, box.uv[0], box.uv[1], w, h, d)) {
      const [sx, sy, tw, th] = f.tex;
      if (tw <= 0 || th <= 0) continue;
      out.push(quad(m(f.o), m(add(f.o, f.U)), m(add(f.o, f.V)), box.texture, [sx, sy, sx + tw, sy + th], o));
    }
  }

  /* ------------------------------------------------------------ блоки и предметы Minecraft (McArt) */

  // Грань элемента модели игры: угол (левый верх текстуры), направление вдоль u и вдоль v.
  const FACE_GEO = {
    down: (f, t) => [[f[0], f[1], t[2]], [t[0] - f[0], 0, 0], [0, 0, f[2] - t[2]]],
    up: (f, t) => [[f[0], t[1], f[2]], [t[0] - f[0], 0, 0], [0, 0, t[2] - f[2]]],
    north: (f, t) => [[t[0], t[1], f[2]], [f[0] - t[0], 0, 0], [0, f[1] - t[1], 0]],
    south: (f, t) => [[f[0], t[1], t[2]], [t[0] - f[0], 0, 0], [0, f[1] - t[1], 0]],
    west: (f, t) => [[f[0], t[1], f[2]], [0, 0, t[2] - f[2]], [0, f[1] - t[1], 0]],
    east: (f, t) => [[t[0], t[1], t[2]], [0, 0, f[2] - t[2]], [0, f[1] - t[1], 0]],
  };
  // Затенение граней — как в игре.
  const FACE_SHADE = { up: 1, down: 0.5, north: 0.8, south: 0.8, west: 0.6, east: 0.6 };
  const HELD_SLOTS = ['rightHand', 'leftHand', 'head'];

  /** Поворот элемента модели вокруг своей точки (старый формат axis/angle и новый x/y/z). */
  function elementPoint(r, p) {
    if (!r) return p;
    const d = sub(p, r.origin || [8, 8, 8]);
    let v;
    if (r.axis) {
      if (!r.angle) return p;
      const k = r.rescale ? 1 / Math.cos(r.angle * DEG) : 1;
      if (r.axis === 'x') v = rotate([d[0], d[1] * k, d[2] * k], [r.angle, 0, 0]);
      else if (r.axis === 'y') v = rotate([d[0] * k, d[1], d[2] * k], [0, r.angle, 0]);
      else v = rotate([d[0] * k, d[1] * k, d[2]], [0, 0, r.angle]);
    } else {
      v = rotate(d, [r.x || 0, r.y || 0, r.z || 0]);
    }
    return add(v, r.origin || [8, 8, 8]);
  }

  /** Подходит ли часть блока под состояние (условие when из оглавления: { north: 'true|low' }, OR, AND). */
  function whenOk(when, state) {
    if (!when) return true;
    if (Array.isArray(when.OR)) return when.OR.some((w) => whenOk(w, state));
    if (Array.isArray(when.AND)) return when.AND.every((w) => whenOk(w, state));
    return Object.entries(when).every(([k, v]) => String(v).split('|').includes(String(state[k] === undefined ? 'false' : state[k])));
  }

  /** Полный ли это куб (к нему цепляются заборы, стены и стёкла). */
  function isFullBlock(m) {
    if (!m || m.kind !== 'block') return false;
    if (m.full === undefined) m.full = m.parts.some((p) => !p.when && !p.off && p.elements.some((e) => !e.rotation && e.from.every((v) => v === 0) && e.to.every((v) => v === 16)));
    return m.full;
  }

  // Семейства соединяющихся блоков и с кем они соединяются (кроме полных кубов — с ними все).
  const FAMILY = (id) => (/_fence_gate$/.test(id) ? 'gate' : /_fence$/.test(id) ? 'fence' : /_wall$/.test(id) ? 'wall' : /(_pane|^glass_pane)$/.test(id) ? 'pane' : /_bars$/.test(id) ? 'pane' : null);
  const JOINS = { fence: ['fence', 'gate'], wall: ['wall', 'pane', 'gate'], pane: ['pane', 'wall'] };

  /** Состояние соединяющегося блока по соседям (те же размер и высота, вплотную по сторонам света блока). */
  function connectState(blocks, i, modelOf) {
    const b = blocks[i];
    const fam = FAMILY(b.id);
    const size = b.size || 1;
    const dirs = { north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] };
    const state = {};
    const on = {};
    for (const [dir, v] of Object.entries(dirs)) {
      const want = add(b.at, rotate(mul(v, 16 * size), [0, b.rot || 0, 0]));
      const n = blocks.find((o, j) => j !== i && o && Math.abs((o.size || 1) - size) < 0.01 && Math.abs(o.at[0] - want[0]) < 1 && Math.abs(o.at[1] - want[1]) < 1 && Math.abs(o.at[2] - want[2]) < 1);
      on[dir] = !!n && ((JOINS[fam] || []).includes(FAMILY(n.id)) || isFullBlock(modelOf(n)));
    }
    if (fam === 'wall') {
      for (const dir of Object.keys(dirs)) state[dir] = on[dir] ? 'low' : 'none';
      const straight = (on.north && on.south && !on.east && !on.west) || (on.east && on.west && !on.north && !on.south);
      state.up = straight ? 'false' : 'true';
    } else for (const dir of Object.keys(dirs)) state[dir] = on[dir] ? 'true' : 'false';
    return state;
  }

  const masks = new WeakMap();
  /** Непрозрачные точки текстуры (кешируется): Uint8Array w×h, 1 — непрозрачная. */
  function maskOf(tex) {
    let m = masks.get(tex);
    if (!m) {
      const w = tex.width;
      const h = tex.height;
      let data = null;
      try {
        data = tex.getContext('2d').getImageData(0, 0, w, h).data;
      } catch {
        data = null;
      }
      const bits = new Uint8Array(w * h);
      let partial = 0;
      for (let k = 0; k < w * h; k++) {
        const a = data ? data[k * 4 + 3] : 255;
        bits[k] = a > 25 ? 1 : 0;
        if (a > 10 && a < 245) partial++;
      }
      m = { w, h, bits, alpha: data, translucent: partial > 0 };
      masks.set(tex, m);
    }
    return m;
  }

  /**
   * Модель игры → грани (в вид). xf — точка модели (0…16) → вид. state — состояние соединяющегося блока.
   * Плоский предмет — как в игре: картинка спереди и сзади и по краю непрозрачных точек — бортик толщиной в точку.
   */
  function modelQuads(out, m, xf, o = {}) {
    if (m.kind === 'mesh') {
      for (const q of m.quads) out.push({ ...q, a: xf(q.a), b: xf(q.b), d: xf(q.d), key: o.key || null });
      return;
    }
    const origin = xf([0, 0, 0]);
    const flip = det3(sub(xf([1, 0, 0]), origin), sub(xf([0, 1, 0]), origin), sub(xf([0, 0, 1]), origin)) < 0;
    if (m.kind === 'block') {
      for (const part of m.parts) {
        if (part.when && !whenOk(part.when, o.state || {})) continue;
        for (const el of part.elements) {
          for (const f of el.faces) {
            if (!f.tex) continue;
            const [u1, v1, u2, v2] = f.uv;
            if (u1 === u2 || v1 === v2) continue;
            const [a, U, V] = FACE_GEO[f.dir](el.from, el.to);
            const place = (p) => {
              let q = elementPoint(el.rotation, p);
              if (part.x || part.y) q = add(rotate(sub(q, [8, 8, 8]), [-part.x, -part.y, 0]), [8, 8, 8]);
              if (part.off) q = add(q, part.off);
              return xf(q);
            };
            const G = [a, add(a, U), add(add(a, U), V), add(a, V)].map(place);
            const du = sub(G[1], G[0]);
            const dv = sub(G[3], G[0]);
            const nz = (dv[0] * du[1] - dv[1] * du[0]) * (flip ? -1 : 1);
            // Грань смотрит от камеры — её не видно (как в игре; у плоских крестиков-растений грани двусторонние парой).
            if (nz <= 1e-6) continue;
            const r = ((Math.round((f.rotation || 0) / 90) % 4) + 4) % 4;
            const tw = f.tex.width / 16;
            out.push(quad(G[r % 4], G[(1 + r) % 4], G[(3 + r) % 4], f.tex, [u1 * tw, v1 * tw, u2 * tw, v2 * tw], { key: o.key, tint: f.tint, shade: el.shade ? FACE_SHADE[f.dir] : 1, cut: 0.5 }));
          }
        }
      }
      return;
    }
    // Плоский предмет.
    for (let li = 0; li < m.layers.length; li++) {
      const l = m.layers[li];
      const tex = l.tex;
      const N = tex.width; // анимированные — квадрат первого кадра
      const s = 16 / N;
      const zf = 8.5 + li * 0.002;
      const zb = 7.5 - li * 0.002;
      const op = { key: o.key, tint: l.tint, cut: 0.1 };
      out.push(quad(xf([0, 16, zf]), xf([16, 16, zf]), xf([0, 0, zf]), tex, [0, 0, N, N], op));
      out.push(quad(xf([0, 16, zb]), xf([16, 16, zb]), xf([0, 0, zb]), tex, [0, 0, N, N], op));
      const mk = maskOf(tex);
      const at = (i, j) => i >= 0 && j >= 0 && i < N && j < N && mk.bits[j * mk.w + i] === 1;
      const side = { ...op, shade: 0.75 };
      // Бортики слева и справа — вертикальными полосками, сверху и снизу — горизонтальными.
      for (let i = 0; i < N; i++) {
        for (const dx of [-1, 1]) {
          let j = 0;
          while (j < N) {
            if (!(at(i, j) && !at(i + dx, j))) {
              j++;
              continue;
            }
            let k = j;
            while (k + 1 < N && at(i, k + 1) && !at(i + dx, k + 1)) k++;
            const x = (dx < 0 ? i : i + 1) * s;
            out.push(quad(xf([x, 16 - j * s, zf]), xf([x, 16 - j * s, zb]), xf([x, 16 - (k + 1) * s, zf]), tex, [i, j, i + 1, k + 1], side));
            j = k + 1;
          }
        }
      }
      for (let j = 0; j < N; j++) {
        for (const dy of [-1, 1]) {
          let i = 0;
          while (i < N) {
            if (!(at(i, j) && !at(i, j + dy))) {
              i++;
              continue;
            }
            let k = i;
            while (k + 1 < N && at(k + 1, j) && !at(k + 1, j + dy)) k++;
            const y = 16 - (dy < 0 ? j : j + 1) * s;
            out.push(quad(xf([i * s, y, zf]), xf([(k + 1) * s, y, zf]), xf([i * s, y, zb]), tex, [i, j, k + 1, j + 1], { ...side, shade: dy < 0 ? 1 : 0.5 }));
            i = k + 1;
          }
        }
      }
    }
  }

  /** Матрица поворота как в игре (display.rotation = XYZ: сначала z, потом y, потом x) — точка → точка. */
  const rotXYZ = ([x, y, z]) => (p) => rotate(rotate(rotate(p, [0, 0, z]), [0, y, 0]), [x, 0, 0]);

  /**
   * Предмет в руке или на голове: цепочка как в игре (ItemInHandLayer / CustomHeadLayer + display модели),
   * плюс свои поворот, размер и сдвиг игрока. Возвращает точку модели (0…16) → точку части тела (до её поворота).
   * Голова моба или игрока на голове — как CustomHeadLayer для черепов: от шеи вверх, в 1,1875 раза больше головы.
   */
  function heldTransform(slot, m, entry, slim) {
    const left = slot === 'leftHand';
    const skull = m.kind === 'mesh' && m.skull;
    const ctx = slot === 'head' ? 'head' : left ? 'thirdperson_lefthand' : 'thirdperson_righthand';
    let d = m.display[ctx];
    if (!d && left && m.display.thirdperson_righthand) {
      const r = m.display.thirdperson_righthand;
      d = { rotation: [(r.rotation || [0, 0, 0])[0], -(r.rotation || [0, 0, 0])[1], -(r.rotation || [0, 0, 0])[2]], translation: [-(r.translation || [0, 0, 0])[0], (r.translation || [0, 0, 0])[1], (r.translation || [0, 0, 0])[2]], scale: r.scale };
    }
    if (skull && slot === 'head') d = { scale: [1, 1, 1] };
    d = d || {};
    const t = d.translation || [0, 0, 0];
    const s = (d.scale || [1, 1, 1]).map((k) => k * (entry.size || 1));
    const R = rotXYZ(d.rotation || [0, 0, 0]);
    const user = entry.rot || [0, 0, 0];
    const at = entry.at || [0, 0, 0];
    // Точка модели → система «руки/головы» игры (y вниз, лицо к −z) → наша (y вверх, лицо к +z).
    // fromUser — то же, но для точки уже после своего поворота rot (центр модели — [0, 0, 0]): по ней студия
    // считает оси колец поворота предмета.
    const center = skull && slot === 'head' ? [8, 0, 8] : [8, 8, 8];
    const fromUser = (v) => add(add(t, at), R(v));
    const inDisplay = (p) => fromUser(rotate([(p[0] - center[0]) * s[0], (p[1] - center[1]) * s[1], (p[2] - center[2]) * s[2]], user));
    let place;
    if (slot === 'head') {
      place = skull
        ? (q) => [q[0] * 1.1875, 24 + q[1] * 1.1875, q[2] * 1.1875]
        : (q) => {
            const r = rotate([q[0] * 0.625, -q[1] * 0.625, -q[2] * 0.625], [0, 180, 0]);
            return [r[0], 24 - (r[1] - 4), -r[2]];
          };
    } else {
      const pivot = left ? [5, slim ? 21.5 : 22, 0] : [-5, slim ? 21.5 : 22, 0];
      const hand = [left ? 1 : -1, 2, -10];
      place = (q) => {
        const r = rotate(rotate(add(hand, q), [0, 180, 0]), [-90, 0, 0]);
        return [pivot[0] + r[0], pivot[1] - r[1], pivot[2] - r[2]];
      };
    }
    const local = (p) => place(inDisplay(p));
    local.fromUser = (v) => place(fromUser(v));
    // Для стрелок сдвига at в студии: точка системы display → часть тела, и где в ней центр предмета.
    local.place = place;
    local.base = add(t, at);
    // Точка части тела, за которую держится предмет: растянули руку или голову — предмет едет за ней, не растягиваясь.
    local.anchor = slot === 'head' ? [0, 32, 0] : [left ? 5 : -5, 12, 0];
    return local;
  }

  /* ------------------------------------------------------------ головы и мобы (McMobs) */

  const skinTextures = new Map();
  /** Текстура скина для головы или моба-игрока: хеш скина с сайта или стандартный скин игры ('wide/steve'). */
  function skinTexture(skin, onReady) {
    const s = skin || 'wide/steve';
    if (/^(wide|slim)\/[a-z]+$/.test(s)) return window.McArt ? window.McArt.entityTexture('player/' + s, onReady) : null;
    if (!/^[0-9a-f]{64}$/.test(s)) return null;
    let m = skinTextures.get(s);
    if (!m) {
      m = { value: null, waiting: [] };
      skinTextures.set(s, m);
      load(`/api/skins/${s}.png`)
        .then((c) => {
          m.value = c;
          m.waiting.splice(0).forEach((f) => f());
        })
        .catch(() => (m.waiting.length = 0));
    }
    if (!m.value && onReady && !m.waiting.includes(onReady)) m.waiting.push(onReady);
    return m.value;
  }

  /**
   * Части модели (McMobs.build) → функция «точка части → точка модели» для каждой части, с позой.
   * angles — { часть: [x, y, z] в градусах, как у персонажа } — заменяют поворот части из модели игры.
   */
  function partChains(parts, angles) {
    const byName = Object.fromEntries(parts.map((p) => [p.name, p]));
    const xf = {};
    const make = (p) => {
      if (xf[p.name]) return xf[p.name];
      const parent = p.parent && byName[p.parent] ? make(byName[p.parent]) : (q) => q;
      const own = angles && angles[p.name];
      const f = (q) => {
        const local = mul(q, p.scale);
        const r = own ? rotate(local, own) : rotateXYZ(local, p.rot);
        return parent(add(r, p.pivot));
      };
      xf[p.name] = f;
      return f;
    };
    parts.forEach(make);
    return xf;
  }

  const headMeshes = new Map();
  /** Голова (череп) как модель для руки, головы и блока: грани в системе блока (0…16), лицом к +z. */
  function headModel(id, skin, onReady) {
    const def = window.McMobs && window.McMobs.head(id);
    if (!def || !window.McArt) return null;
    const key = id + '|' + (def.skin ? skin || '' : '');
    if (headMeshes.has(key)) return headMeshes.get(key);
    const tex = def.skin ? skinTexture(skin, onReady) : window.McArt.entityTexture(def.tex[0], onReady);
    const display = window.McArt.display(def.display, onReady);
    if (!tex || !display) return null;
    const chains = partChains(def.parts, null);
    const quads = [];
    for (const p of def.parts) {
      for (const box of p.boxes) boxQuads(quads, { ...box, texture: tex }, (q) => add(chains[p.name](q), [8, 0, 8]), { cut: 0.1, skin: !!def.skin });
    }
    const m = { kind: 'mesh', quads, display, skull: true };
    headMeshes.set(key, m);
    return m;
  }

  /** Модель для руки, головы или блока: блок или предмет игры, голова, своя картинка. null — ещё грузится. */
  function itemModel(entry, onModel, textures, flat, asBlock) {
    if (window.McMobs && window.McMobs.isHead(entry.id)) return headModel(entry.id, entry.skin, onModel);
    return window.McArt ? window.McArt.model(entry.id, onModel, textures, flat, asBlock) : null;
  }

  /** Углы частей моба для позы: человекоподобным — позы персонажа, остальным — свои из McMobs. */
  function mobAngles(def, key) {
    const k = def.poses.includes(key) ? key : def.pose || 'stand';
    if (def.bones) {
      const p = pose(k, null);
      const out = {};
      for (const [ours, theirs] of Object.entries(def.bones)) out[theirs] = p[ours];
      return { angles: out, lift: p.lift };
    }
    return { angles: (def.quad && def.quad[k]) || {}, lift: 0 };
  }

  /** Моб на сцене → грани. world — точка модели моба (ноги на y = 0) → вид. */
  function mobQuads(out, e, world, onModel, key) {
    const def = window.McMobs && window.McMobs.mob(e.type, e.type === 'player' && (e.slim || /^slim\//.test(e.skin || '')));
    if (!def || !window.McArt) return false;
    const texs = def.skin ? [skinTexture(e.skin, onModel)] : def.tex.map((t) => window.McArt.entityTexture(t, onModel));
    if (texs.some((t) => !t)) return false;
    const { angles, lift } = mobAngles(def, e.pose);
    const chains = partChains(def.parts, angles);
    const k = def.scale;
    const xf = (name) => (q) => world(add(mul(chains[name](q), k), [0, lift * k, 0]));
    const layers = [{ tex: null, grow: 0 }, ...def.layers];
    for (const p of def.parts) {
      for (const layer of layers) {
        for (const box of p.boxes) {
          const texIndex = layer.tex === null ? box.tex : layer.tex;
          const g = layer.grow;
          const b = g ? { ...box, from: box.from.map((v) => v - g), to: box.to.map((v) => v + g) } : box;
          boxQuads(out, { ...b, texture: texs[texIndex] }, xf(p.name), { key, cut: 0.1, skin: !!def.skin });
        }
      }
    }
    // Блоки на мобе (тыква снежного голема).
    for (const bl of def.blocks || []) {
      const m = window.McArt.model(bl.id, onModel, null, false);
      if (!m) continue;
      const c = chains[bl.bone];
      const at = [bl.at[0], -bl.at[1], -bl.at[2]];
      modelQuads(out, m, (p) => world(add(mul(c(add(mul(sub(p, [8, 8, 8]), bl.size), at)), k), [0, lift * k, 0])), { key });
    }
    return true;
  }

  /* ------------------------------------------------------------ рисование */

  const ATTACHED = new Set(['head', 'rightArm', 'leftArm']);
  // Где голова и руки крепятся к телу: тело растянули — они остаются на его краях.
  const ATTACH_AT = { head: [0, 24, 0], rightArm: [-4, 22, 0], leftArm: [4, 22, 0] };
  const CENTER_Y = 17; // середина модели по высоте (с поднятыми руками)
  const HEIGHT = 40; // сколько единиц модели помещается по высоте холста
  const WIDTH = 26;
  const BLOCK = 16; // блок Minecraft в единицах модели (персонаж — 32)

  /**
   * Грань скина (или текстуры предмета/блока) отдельной картинкой с рамкой в 1 точку из её же крайних пикселей. Браузер при повороте и масштабе
   * берёт пиксели чуть за краем прямоугольника — из соседнего места скина, отсюда тёмные полосы по краям частей (2D-путь).
   */
  const tiles = new WeakMap();
  function faceTile(skin, sx, sy, tw, th) {
    let map = tiles.get(skin);
    if (!map) tiles.set(skin, (map = new Map()));
    const key = `${sx},${sy},${tw},${th}`;
    let c = map.get(key);
    if (!c) {
      c = document.createElement('canvas');
      c.width = tw + 2;
      c.height = th + 2;
      const t = c.getContext('2d');
      t.imageSmoothingEnabled = false;
      t.drawImage(skin, sx, sy, tw, th, 1, 1, tw, th);
      t.drawImage(c, 1, 1, tw, 1, 1, 0, tw, 1); // верх
      t.drawImage(c, 1, th, tw, 1, 1, th + 1, tw, 1); // низ
      t.drawImage(c, 1, 0, 1, th + 2, 0, 0, 1, th + 2); // лево
      t.drawImage(c, tw, 0, 1, th + 2, tw + 1, 0, 1, th + 2); // право
      map.set(key, c);
    }
    return c;
  }

  /* ---------------- WebGL: один общий холст на всю страницу, картинка копируется на нужный 2D-холст */

  const GLX = { tried: false, gl: null, canvas: null, prog: null, buf: null, loc: null, tex: new WeakMap(), max: 0 };

  function glGet() {
    if (GLX.tried) return GLX.gl ? GLX : null;
    GLX.tried = true;
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl', { alpha: true, premultipliedAlpha: true, antialias: true, depth: true, stencil: false, preserveDrawingBuffer: true });
      if (!gl) return null;
      const shader = (type, src) => {
        const s = gl.createShader(type);
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
        return s;
      };
      const prog = gl.createProgram();
      gl.attachShader(
        prog,
        shader(
          gl.VERTEX_SHADER,
          `attribute vec3 aPos; attribute vec2 aUv; attribute vec3 aCol;
           uniform vec2 uSize; uniform vec2 uDepth;
           varying vec2 vUv; varying vec3 vCol;
           void main() {
             gl_Position = vec4(aPos.x / uSize.x * 2.0 - 1.0, 1.0 - aPos.y / uSize.y * 2.0, (aPos.z - uDepth.x) * uDepth.y, 1.0);
             vUv = aUv; vCol = aCol;
           }`
        )
      );
      gl.attachShader(
        prog,
        shader(
          gl.FRAGMENT_SHADER,
          `precision highp float;
           uniform sampler2D uTex; uniform vec2 uCut;
           varying vec2 vUv; varying vec3 vCol;
           void main() {
             vec4 c = texture2D(uTex, vUv);
             if (c.a < uCut.x || c.a >= uCut.y) discard;
             float a = uCut.y > 1.5 ? 1.0 : c.a;
             gl_FragColor = vec4(c.rgb * vCol * a, a);
           }`
        )
      );
      gl.linkProgram(prog);
      if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
      GLX.loc = {
        pos: gl.getAttribLocation(prog, 'aPos'),
        uv: gl.getAttribLocation(prog, 'aUv'),
        col: gl.getAttribLocation(prog, 'aCol'),
        size: gl.getUniformLocation(prog, 'uSize'),
        depth: gl.getUniformLocation(prog, 'uDepth'),
        cut: gl.getUniformLocation(prog, 'uCut'),
        tex: gl.getUniformLocation(prog, 'uTex'),
      };
      GLX.buf = gl.createBuffer();
      GLX.prog = prog;
      GLX.canvas = c;
      GLX.gl = gl;
      const dims = gl.getParameter(gl.MAX_VIEWPORT_DIMS);
      GLX.max = Math.min(dims[0], dims[1], gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
      c.addEventListener('webglcontextlost', (e) => {
        e.preventDefault();
        GLX.gl = null;
      });
      c.addEventListener('webglcontextrestored', () => {
        GLX.tried = false;
        GLX.tex = new WeakMap();
      });
      return GLX;
    } catch (e) {
      console.warn('Skin3D: WebGL недоступен, рисую по-старому', e && e.message);
      GLX.gl = null;
      return null;
    }
  }

  function glTexture(src) {
    const gl = GLX.gl;
    let t = GLX.tex.get(src);
    if (!t) {
      t = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      GLX.tex.set(src, t);
    }
    return t;
  }

  /** Вершины грани: 2 треугольника × (x, y на холсте; z вида; u, v; r, g, b). */
  function pushVerts(arr, q, toScreen) {
    const c = add(q.b, sub(q.d, q.a));
    const pts = [q.a, q.b, c, q.d].map((p) => {
      const s = toScreen(p);
      return [s[0], s[1], p[2]];
    });
    const W = q.tex.width;
    const H = q.tex.height;
    // Чуть внутрь, чтобы на краях не брались соседние точки текстуры.
    const e = 0.002;
    const su = Math.sign(q.uv[2] - q.uv[0]) * e;
    const sv = Math.sign(q.uv[3] - q.uv[1]) * e;
    const u0 = (q.uv[0] + su) / W;
    const u1 = (q.uv[2] - su) / W;
    const v0 = (q.uv[1] + sv) / H;
    const v1 = (q.uv[3] - sv) / H;
    const uv = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    const col = q.tint ? hexRgb(q.tint).map((k) => k * q.shade) : [q.shade, q.shade, q.shade];
    for (const i of [0, 1, 2, 0, 2, 3]) arr.push(pts[i][0], pts[i][1], pts[i][2], uv[i][0], uv[i][1], col[0], col[1], col[2]);
  }

  /** Нарисовать грани через WebGL на холст W×H. Возвращает холст WebGL (скопировать drawImage) или null. */
  function glRender(W, H, quads, toScreen) {
    const X = glGet();
    if (!X || W > X.max || H > X.max || W < 1 || H < 1) return null;
    const gl = X.gl;
    if (gl.isContextLost()) return null;
    if (X.canvas.width !== W) X.canvas.width = W;
    if (X.canvas.height !== H) X.canvas.height = H;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!quads.length) return X.canvas;
    let zmin = Infinity;
    let zmax = -Infinity;
    for (const q of quads) {
      for (const p of [q.a, q.b, q.d]) {
        if (p[2] < zmin) zmin = p[2];
        if (p[2] > zmax) zmax = p[2];
      }
      const c = q.b[2] + q.d[2] - q.a[2];
      if (c < zmin) zmin = c;
      if (c > zmax) zmax = c;
    }
    const half = Math.max(1, (zmax - zmin) / 2) * 1.02;
    gl.useProgram(X.prog);
    gl.uniform2f(X.loc.size, W, H);
    gl.uniform2f(X.loc.depth, (zmax + zmin) / 2, -0.98 / half);
    gl.uniform1i(X.loc.tex, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindBuffer(gl.ARRAY_BUFFER, X.buf);
    const stride = 8 * 4;
    gl.enableVertexAttribArray(X.loc.pos);
    gl.enableVertexAttribArray(X.loc.uv);
    gl.enableVertexAttribArray(X.loc.col);
    gl.vertexAttribPointer(X.loc.pos, 3, gl.FLOAT, false, stride, 0);
    gl.vertexAttribPointer(X.loc.uv, 2, gl.FLOAT, false, stride, 12);
    gl.vertexAttribPointer(X.loc.col, 3, gl.FLOAT, false, stride, 20);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);
    const run = (list, lo, hi) => {
      if (!list.length) return;
      const arr = [];
      for (const q of list) pushVerts(arr, q, toScreen);
      gl.bindTexture(gl.TEXTURE_2D, glTexture(list[0].tex));
      gl.uniform2f(X.loc.cut, lo, hi);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STREAM_DRAW);
      gl.drawArrays(gl.TRIANGLES, 0, list.length * 6);
    };
    // 1. Непрозрачное и «вырезанное» (листва, предметы) — с записью глубины. У полупрозрачных текстур — только
    //    совсем непрозрачные точки. Порядок групп — как пришли грани: второй слой моба (одежда жителя) ложится поверх.
    gl.disable(gl.BLEND);
    gl.depthMask(true);
    const groups = new Map();
    const glass = [];
    for (const q of quads) {
      const translucent = !q.skin && maskOf(q.tex).translucent;
      const cut = translucent ? 0.996 : q.cut;
      const k = groups.get(q.tex) || new Map();
      groups.set(q.tex, k);
      if (!k.has(cut)) k.set(cut, []);
      k.get(cut).push(q);
      if (translucent) glass.push(q);
    }
    for (const byCut of groups.values()) for (const [cut, list] of byCut) run(list, cut, 2);
    // 2. Полупрозрачные точки (стекло, вода, лёд, слизень) — от дальних к ближним, без записи глубины.
    if (glass.length) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      glass.sort((p, q) => p.b[2] + p.d[2] - (q.b[2] + q.d[2]));
      let batch = [];
      for (const q of glass) {
        if (batch.length && batch[0].tex !== q.tex) {
          run(batch, 0.004, 0.996);
          batch = [];
        }
        batch.push(q);
      }
      run(batch, 0.004, 0.996);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
    return X.canvas;
  }

  /** Запасной путь без WebGL: грани от дальних к ближним, каждая — drawImage с аффинным преобразованием. */
  function paint2D(g, quads, toScreen) {
    const list = quads
      .map((q) => {
        const du = sub(q.b, q.a);
        const dv = sub(q.d, q.a);
        return { q, nz: dv[0] * du[1] - dv[1] * du[0], depth: (q.b[2] + q.d[2]) / 2 };
      })
      .filter((x) => !x.q.cull || x.nz > 1e-6)
      .sort((x, y) => x.depth - y.depth);
    for (const { q } of list) {
      const [u0, v0, u1, v1] = q.uv;
      const sa = toScreen(q.a);
      const sb = toScreen(q.b);
      const sd = toScreen(q.d);
      const cu = [(sb[0] - sa[0]) / (u1 - u0), (sb[1] - sa[1]) / (u1 - u0)];
      const cv = [(sd[0] - sa[0]) / (v1 - v0), (sd[1] - sa[1]) / (v1 - v0)];
      g.setTransform(cu[0], cu[1], cv[0], cv[1], sa[0] - u0 * cu[0] - v0 * cv[0], sa[1] - u0 * cu[1] - v0 * cv[1]);
      const sx = Math.min(u0, u1);
      const sy = Math.min(v0, v1);
      const sw = Math.abs(u1 - u0);
      const sh = Math.abs(v1 - v0);
      // Чуть шире, чтобы между гранями не просвечивали щели (у плоских предметов — нельзя, видно край).
      const e = !q.skin && q.cut <= 0.1 ? 0 : Math.min(0.3, 0.5 / Math.max(1e-6, Math.hypot(cu[0], cu[1])));
      const img = (q.tint || q.shade < 0.999) && window.McArt ? window.McArt.prepared(q.tex, q.tint, q.shade) : q.tex;
      if ([sx, sy, sw, sh].every(Number.isInteger) && sw > 0 && sh > 0) g.drawImage(faceTile(img, sx, sy, sw, sh), 1, 1, sw, sh, sx - e, sy - e, sw + 2 * e, sh + 2 * e);
      else g.drawImage(img, sx, sy, sw, sh, sx, sy, sw, sh);
    }
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Грани → на 2D-холст: через WebGL, а если его нет — по-старому. */
  function render(g, W, H, quads, toScreen) {
    const out = glRender(W, H, quads, toScreen);
    if (out) {
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(out, 0, 0);
    } else paint2D(g, quads, toScreen);
  }

  /** Грани с ключом → области для выбора мышью: { key, poly (холст), z (вид: углы a, b, d), tex, uv, normal (вид, к зрителю) }. */
  function hitsOf(quads, toScreen, out) {
    for (const q of quads) {
      if (!q.key) continue;
      const du = sub(q.b, q.a);
      const dv = sub(q.d, q.a);
      const nz = dv[0] * du[1] - dv[1] * du[0];
      if (q.cull ? nz <= 1e-6 : Math.abs(nz) <= 1e-9) continue;
      const sa = toScreen(q.a);
      const sb = toScreen(q.b);
      const sd = toScreen(q.d);
      let n = norm(cross(dv, du));
      if (n[2] < 0) n = mul(n, -1);
      out.push({ key: q.key, poly: [sa, sb, [sb[0] + sd[0] - sa[0], sb[1] + sd[1] - sa[1]], sd], z: [q.a[2], q.b[2], q.d[2]], tex: q.tex, uv: q.uv, normal: n });
    }
  }

  /** Точка (x, y) внутри грани: { s, t } вдоль a→b и a→d или null. */
  function paramIn([a, b, , d], x, y) {
    const ux = b[0] - a[0];
    const uy = b[1] - a[1];
    const vx = d[0] - a[0];
    const vy = d[1] - a[1];
    const det = ux * vy - uy * vx;
    if (Math.abs(det) < 1e-9) return null;
    const px = x - a[0];
    const py = y - a[1];
    const s = (px * vy - py * vx) / det;
    const t = (ux * py - uy * px) / det;
    return s >= 0 && s <= 1 && t >= 0 && t <= 1 ? { s, t } : null;
  }

  /** Что видно в точке холста: ближайшая к камере грань, где точка текстуры не прозрачная. */
  function topHit(hits, x, y) {
    let best = null;
    let bz = -Infinity;
    for (const h of hits) {
      const st = paramIn(h.poly, x, y);
      if (!st) continue;
      const z = h.z[0] + st.s * (h.z[1] - h.z[0]) + st.t * (h.z[2] - h.z[0]);
      if (z <= bz) continue;
      if (h.tex) {
        const m = maskOf(h.tex);
        const u = Math.floor(h.uv[0] + st.s * (h.uv[2] - h.uv[0]) - (h.uv[2] < h.uv[0] ? 1e-6 : 0));
        const v = Math.floor(h.uv[1] + st.t * (h.uv[3] - h.uv[1]) - (h.uv[3] < h.uv[1] ? 1e-6 : 0));
        const i = Math.max(0, Math.min(m.w - 1, u));
        const j = Math.max(0, Math.min(m.h - 1, v));
        if (m.alpha && m.alpha[(j * m.w + i) * 4 + 3] < 26) continue;
      }
      best = h;
      bz = z;
    }
    return best;
  }

  // Позы, которые бывают у игрока на сцене (как у персонажа, плюс «Руки вперёд»).
  const MOB_POSE_KEYS = [...POSE_KEYS, 'zombie'];
  const BODY_PIVOT = [0, 12, 0];

  /**
   * Скелет игрока: персонаж или другой игрок на сцене. angles — поза (pose() или customPose()),
   * place — { pos, size, turn }: где стоит, размер, поворот вокруг себя; view — мир → вид.
   * Часть тела → фигура: поворот вокруг сустава, крепление к телу, подъём (сидит). Фигура → мир (place) → вид.
   * Голова и руки крепятся к телу: наклонили тело — они наклоняются вместе с ним (ноги — нет).
   */
  function rig(angles, slim, place, view) {
    const pos = Array.isArray(place.pos) ? place.pos.map((v) => Number(v) || 0) : [0, 0, 0];
    const size = Number(place.size) > 0 ? Number(place.size) : 1;
    const turn = Number(place.turn) || 0;
    const fig = (p) => add(rotate(mul(p, size), [0, turn, 0]), pos);
    const bodyTurned = angles.body.some((x) => x);
    const parts = model(slim);
    const byKey = Object.fromEntries(parts.map((p) => [p.key, p]));
    // Растяжение части вдоль её осей: в длину — от сустава (рука остаётся у плеча), вширь и вглубь — от середины коробки.
    // Ноги длиннее или короче — вся фигура выше или ниже, ступни на полу. d — точка относительно сустава.
    const stretchOf = (key) => (angles.stretch && angles.stretch[key]) || null;
    const scaled = (key, d) => {
      const k = stretchOf(key);
      if (!k) return d;
      const { at, size: s, pivot } = byKey[key];
      const o = [at[0] + s[0] / 2 - pivot[0], 0, at[2] + s[2] / 2 - pivot[2]];
      return [o[0] + (d[0] - o[0]) * k[0], d[1] * k[1], o[2] + (d[2] - o[2]) * k[2]];
    };
    const legs = Math.max((stretchOf('rightLeg') || [1, 1, 1])[1], (stretchOf('leftLeg') || [1, 1, 1])[1]);
    const ground = 12 * (legs - 1);
    /** anchor — точка части, за которую держится предмет: он не растягивается, а едет вместе с ней. */
    const toWorld = (part, p, anchor) => {
      let d = sub(p, part.pivot);
      if (stretchOf(part.key)) {
        if (anchor) {
          const a = sub(anchor, part.pivot);
          d = add(d, sub(scaled(part.key, a), a));
        } else d = scaled(part.key, d);
      }
      let local = add(rotate(d, angles[part.key]), part.pivot);
      if (ATTACHED.has(part.key) && stretchOf('body')) {
        const a = sub(ATTACH_AT[part.key], BODY_PIVOT);
        local = add(local, sub(scaled('body', a), a));
      }
      if (bodyTurned && ATTACHED.has(part.key)) local = add(rotate(sub(local, BODY_PIVOT), angles.body), BODY_PIVOT);
      if (angles.move) {
        // Свой сдвиг части; голова и руки едут и вместе с телом.
        if (angles.move[part.key]) local = add(local, angles.move[part.key]);
        if (ATTACHED.has(part.key) && angles.move.body) local = add(local, angles.move.body);
      }
      local[1] += angles.lift + ground;
      return fig(local);
    };
    return { angles, parts, byKey, toWorld, toView: (part, p, anchor) => view(toWorld(part, p, anchor)), fig, size, turn, ground, bodyTurned, view };
  }

  /** Коробки частей скелета и второй слой (у второго слоя видна и изнанка — как у шапки в игре). prefix — начало ключа. */
  function rigQuads(Q, r, skin, prefix) {
    for (const part of r.parts) {
      const [w, h, d] = part.size;
      const [x0, y0, z0] = part.at;
      const xf = (p) => r.toView(part, p);
      boxQuads(Q, { from: [x0, y0, z0], to: [x0 + w, y0 + h, z0 + d], uv: part.uv, size: part.size, texture: skin }, xf, { key: prefix + part.key, cull: true, cut: 0.1, skin: true });
      const gr = part.grow;
      boxQuads(Q, { from: [x0 - gr, y0 - gr, z0 - gr], to: [x0 + w + gr, y0 + h + gr, z0 + d + gr], uv: part.ov, size: part.size, texture: skin }, xf, { key: prefix + part.key, cut: 0.1, skin: true });
    }
  }

  /** Как скелет лёг в вид — для ручек редактора: суставы, середины, оси частей и всей фигуры. */
  function rigApi(r, camera, toWorldDir) {
    const { angles, byKey } = r;
    const figDir = (d) => rotate(d, [0, r.turn, 0]);
    // Направление из системы родителя части в вид.
    const fromParent = (key, d) => camera(figDir(r.bodyTurned && ATTACHED.has(key) ? rotate(d, angles.body) : d));
    return {
      /** Сустав части в координатах вида. */
      pivot: (key) => {
        const part = byKey[key];
        return r.toView(part, part.pivot);
      },
      /** Середина коробки части (вид) — там ручки сдвига и растяжения. */
      center: (key) => {
        const part = byKey[key];
        const [w, h, d] = part.size;
        const [x0, y0, z0] = part.at;
        return r.toView(part, [x0 + w / 2, y0 + h / 2, z0 + d / 2]);
      },
      /** Свои оси части после поворота (вид): вдоль них растягивается часть. */
      partAxes: (key) => [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((d) => norm(fromParent(key, rotate(d, angles[key])))),
      /** Оси фигуры (вид): вдоль них сдвиг частей тела (angles.move); длина — на единицу сдвига (с размером фигуры). */
      figureAxes: () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((d) => camera(figDir(mul(d, r.size)))),
      /** Середина фигуры (вид). */
      figureCenter: () => r.view(r.fig([0, 16 + angles.lift + r.ground, 0])),
      /**
       * Оси, вокруг которых поворачивают углы [rx, ry, rz] этой части (как «гимбал» в Blockbench):
       * поворот считается rz → rx → ry, поэтому ось ry — вертикаль родителя, rx — после ry, rz — после rx и ry.
       */
      axes: (key) => {
        const [rx, ry] = angles[key];
        return [rotate([1, 0, 0], [0, ry, 0]), [0, 1, 0], rotate([0, 0, 1], [rx, ry, 0])].map((d) => norm(fromParent(key, d)));
      },
      /** «Вниз» фигуры (вид) на единицу подъёма lift — для стрелки «присесть». */
      down: () => camera(figDir(mul([0, -1, 0], r.size))),
      /** Направление из вида в систему фигуры (сдвиг части тела мышью): с её поворотом и размером. */
      toFigureDir: (v) => mul(rotate(toWorldDir(v), [0, -r.turn, 0]), 1 / r.size),
    };
  }

  /**
   * Один кадр. canvas — уже нужного размера (в пикселях устройства), skin — 64×64 из load().
   *   yaw/pitch — камера в градусах; pose — ключ позы ('custom' — углы из angles); time — секунды анимации (null — без неё);
   *   zoom — приближение кадра (растёт от ног: ноги остаются на месте); offset — [x, y] сдвиг кадра;
   *   frame — { x, y, w, h }: где на холсте «карточка» (по умолчанию весь холст), viewZoom — ещё приближение;
   *   фигура: pos [x, y, z] — где стоит, size — размер (только её), figTurn — поворот вокруг себя;
   *   held — { rightHand, leftHand, head: { id, rot, size, at, skin? } }, blocks — [{ id, at, rot, size, skin? }],
   *   mobs — [{ type, at, rot, size, pose, skin?, slim? }], textures — свои картинки (см. Api.LOOK);
   *   пока модели грузятся у Mojang, их нет, по готовности вызывается onModel() — перерисовать.
   *   hits — массив: в него попадут видимые грани { key, poly, z, normal } (для выбора мышью; key — часть тела,
   *   'held:<слот>', 'block:<i>', 'mob:<i>'). Камера редактора: pan — [x, y] сдвиг в пикселях холста, floor — сетка на полу.
   * Возвращает, как сцена легла на холст (для ручек редактора), или null без скина.
   */
  function draw(canvas, skin, opts = {}) {
    const g = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!skin) return null;
    g.imageSmoothingEnabled = false;
    const fr = opts.frame || { x: 0, y: 0, w: W, h: H };
    const fitScale = Math.min(fr.w / WIDTH, fr.h / HEIGHT) * (opts.viewZoom || 1);
    const zoom = opts.zoom || 1;
    const scale = fitScale * zoom;
    const offset = Array.isArray(opts.offset) ? opts.offset : [0, 0];
    const pan = Array.isArray(opts.pan) ? opts.pan : [0, 0];
    const cx = fr.x + fr.w / 2 + pan[0] + (Number(offset[0]) || 0) * fitScale;
    const cy = fr.y + fr.h / 2 + pan[1] + (opts.shiftY || 0) * scale + CENTER_Y * fitScale * (1 - zoom) - (Number(offset[1]) || 0) * fitScale;
    const yaw = opts.yaw === undefined ? 25 : opts.yaw;
    const pitch = opts.pitch === undefined ? 10 : opts.pitch;
    const angles = opts.pose === 'custom' && opts.angles ? customPose(opts.angles) : pose(POSE_KEYS.includes(opts.pose) ? opts.pose : 'stand', opts.time);
    const camera = (d) => rotate(rotate(d, [0, yaw, 0]), [pitch, 0, 0]);
    const view = (w) => camera([w[0], w[1] - CENTER_Y, w[2]]);
    const toScreen = (p) => [cx + p[0] * scale, cy - p[1] * scale];
    toScreen.scale = scale;
    const toWorldDir = (v) => rotate(rotate(v, [-pitch, 0, 0]), [0, -yaw, 0]);

    // Персонаж: где стоит, какого размера, куда повёрнут.
    const me = rig(angles, opts.slim, { pos: opts.pos, size: opts.size, turn: opts.figTurn }, view);
    const { byKey, toWorld } = me;

    const Q = [];
    rigQuads(Q, me, skin, '');

    // Предметы в руках и на голове, блоки, мобы.
    const heldXf = {};
    const mobRigs = [];
    if (window.McArt) {
      const held = opts.held || {};
      for (const slot of HELD_SLOTS) {
        const entry = held[slot];
        if (!entry || !entry.id) continue;
        const m = itemModel(entry, opts.onModel, opts.textures, slot !== 'head');
        if (!m) continue;
        const local = heldTransform(slot, m, entry, opts.slim);
        const part = byKey[slot === 'head' ? 'head' : slot === 'leftHand' ? 'leftArm' : 'rightArm'];
        const xf = (p) => view(toWorld(part, local(p), local.anchor));
        heldXf[slot] = { xf, part, local };
        modelQuads(Q, m, xf, { key: 'held:' + slot });
      }
      const blocks = opts.blocks || [];
      const modelOf = (b) => (b && b.id ? itemModel(b, opts.onModel, opts.textures, false, true) : null);
      blocks.forEach((b, i) => {
        if (!b || !b.id) return;
        const m = modelOf(b);
        if (!m) return;
        const k = (b.size || 1) * (BLOCK / 16);
        const at = b.at || [0, 0, 0];
        const xf = (p) => view(add(rotate([(p[0] - 8) * k, p[1] * k, (p[2] - 8) * k], [0, b.rot || 0, 0]), at));
        const state = m.kind === 'block' && m.parts.some((p) => p.when) ? connectState(blocks, i, modelOf) : null;
        modelQuads(Q, m, xf, { key: 'block:' + i, state });
      });
      (opts.mobs || []).forEach((e, i) => {
        if (!e || !e.type) return;
        const k = e.size || 1;
        const at = e.at || [0, 0, 0];
        if (e.type === 'player') {
          // Другой игрок — тот же скелет, что у персонажа: свои углы, сдвиг и растяжение каждой части.
          const tex = skinTexture(e.skin, opts.onModel);
          if (!tex) return;
          const a = e.pose === 'custom' && e.angles ? customPose(e.angles) : pose(MOB_POSE_KEYS.includes(e.pose) ? e.pose : 'stand', null);
          const r = rig(a, e.slim || /^slim\//.test(e.skin || ''), { pos: at, size: k, turn: e.rot || 0 }, view);
          mobRigs[i] = r;
          rigQuads(Q, r, tex, `mob:${i}:`);
          return;
        }
        mobQuads(Q, e, (p) => view(add(rotate(mul(p, k), [0, e.rot || 0, 0]), at)), opts.onModel, 'mob:' + i);
      });
    }

    // Сетка на полу (редактор): клетка — блок, линии по краям блоков, стоящих в кратных 16 точках.
    if (opts.floor) {
      const edge = 6.5 * BLOCK;
      const line = (a, b) => {
        const p = toScreen(view(a));
        const q = toScreen(view(b));
        g.moveTo(p[0], p[1]);
        g.lineTo(q[0], q[1]);
      };
      g.save();
      g.lineWidth = Math.max(1, scale * 0.08);
      g.strokeStyle = 'rgba(255, 255, 255, 0.09)';
      g.beginPath();
      for (let k = -edge; k <= edge; k += BLOCK) {
        line([k, 0, -edge], [k, 0, edge]);
        line([-edge, 0, k], [edge, 0, k]);
      }
      g.stroke();
      g.restore();
    }

    render(g, W, H, Q, toScreen);
    if (opts.hits) hitsOf(Q, toScreen, opts.hits);
    g.setTransform(1, 0, 0, 1, 0, 0);

    return {
      scale,
      toScreen,
      camera,
      view,
      frame: fr,
      // Персонаж: суставы, середины частей, их оси (см. rigApi).
      ...rigApi(me, camera, toWorldDir),
      /** Другой игрок на сцене (моб 'player' с номером i) — то же, что у персонажа; null — нет или не загрузился. */
      mobRig: (i) => (mobRigs[i] ? rigApi(mobRigs[i], camera, toWorldDir) : null),
      /** Оси мира (вид): вдоль них двигаются блоки, мобы и вся фигура. Длина — на единицу сдвига. */
      worldAxes: () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((d) => camera(d)),
      /**
       * Предмет в слоте: центр (вид) и оси его своего поворота rot — или null, если его нет/не загрузился.
       * Оси — «гимбал», как у частей тела (rot считается rz → rx → ry): ry — вертикаль системы предмета,
       * rx — после ry, rz — после rx и ry. Направления переводятся в вид той же цепочкой, что и сам предмет.
       */
      held: (slot, rot = [0, 0, 0]) => {
        const h = heldXf[slot];
        if (!h) return null;
        const P = (v) => view(toWorld(h.part, h.local.fromUser(v), h.local.anchor));
        // Сдвиг at на единицу вдоль x, y, z — куда и насколько едет предмет (вид).
        const Qp = (q) => view(toWorld(h.part, h.local.place(q), h.local.anchor));
        const base = Qp(h.local.base);
        const moveDirs = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((e) => sub(Qp(add(h.local.base, e)), base));
        const c = P([0, 0, 0]);
        const L = (d) => sub(P(mul(d, 4)), c);
        // Цепочка — повороты и одинаковый масштаб, но если в модели есть отражение, кольца крутили бы наоборот.
        const flip = det3(L([1, 0, 0]), L([0, 1, 0]), L([0, 0, 1])) < 0 ? -1 : 1;
        const [rx, ry] = rot;
        return { center: c, moveDirs, axes: [rotate([1, 0, 0], [0, ry, 0]), [0, 1, 0], rotate([0, 0, 1], [rx, ry, 0])].map((d) => norm(mul(L(d), flip))) };
      },
      /** Точка на холсте → точка мира на высоте y (пол — 0) или null (луч вдоль пола). */
      unproject: (sx, sy, y = 0) => {
        const back = (v) => rotate(rotate(v, [-pitch, 0, 0]), [0, -yaw, 0]);
        const a = back([(sx - cx) / scale, (cy - sy) / scale, 0]);
        const b = back([0, 0, 1]);
        if (Math.abs(b[1]) < 1e-6) return null;
        const t = (y - CENTER_Y - a[1]) / b[1];
        return [a[0] + b[0] * t, y, a[2] + b[2] * t];
      },
      /** Направление из вида в мир (для нормали грани блока под мышью). */
      toWorldDir,
    };
  }

  /** Значок блока или головы для палитры: как в инвентаре игры (display.gui модели). */
  function drawIcon(canvas, m) {
    const g = canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    g.imageSmoothingEnabled = false;
    const d = (m.display && m.display.gui) || { rotation: [30, 225, 0], scale: [0.625, 0.625, 0.625] };
    const R = rotXYZ(d.rotation || [0, 0, 0]);
    const s = d.scale || [1, 1, 1];
    const t = d.translation || [0, 0, 0];
    const k = canvas.width / 16;
    const xf = (p) => add(t, R([(p[0] - 8) * s[0], (p[1] - 8) * s[1], (p[2] - 8) * s[2]]));
    const toScreen = (p) => [canvas.width / 2 + p[0] * k, canvas.height / 2 - p[1] * k];
    toScreen.scale = k;
    const Q = [];
    modelQuads(Q, m, xf, {});
    render(g, canvas.width, canvas.height, Q, toScreen);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  /** Значок моба для палитры (вполоборота, во весь квадрат). false — текстуры ещё грузятся (onReady позовут). */
  function drawMob(canvas, type, { skin, slim, onReady } = {}) {
    const g = canvas.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, canvas.width, canvas.height);
    const def = window.McMobs && window.McMobs.mob(type, slim);
    if (!def) return false;
    // Размер модели — по её коробкам.
    const chains = partChains(def.parts, mobAngles(def, def.pose).angles);
    let lo = [Infinity, Infinity, Infinity];
    let hi = [-Infinity, -Infinity, -Infinity];
    for (const p of def.parts) {
      for (const b of p.boxes) {
        for (const x of [b.from[0], b.to[0]]) for (const y of [b.from[1], b.to[1]]) for (const z of [b.from[2], b.to[2]]) {
          const q = chains[p.name]([x, y, z]);
          lo = lo.map((v, i) => Math.min(v, q[i]));
          hi = hi.map((v, i) => Math.max(v, q[i]));
        }
      }
    }
    const cam = (p) => rotate(rotate(sub(p, mul(add(lo, hi), 0.5)), [0, 35, 0]), [12, 0, 0]);
    const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) * 1.1 || 1;
    const k = canvas.width / span;
    const toScreen = (p) => [canvas.width / 2 + p[0] * k, canvas.height / 2 - p[1] * k];
    toScreen.scale = k;
    const Q = [];
    if (!mobQuads(Q, { type, pose: def.pose, skin, slim }, (p) => cam(mul(p, 1 / def.scale)), onReady, null)) return false;
    render(g, canvas.width, canvas.height, Q, toScreen);
    g.setTransform(1, 0, 0, 1, 0, 0);
    return true;
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
    const BASE_PITCH = 10;
    const state = { url: opts.url, slim: !!opts.slim, look: opts.look || { pose: opts.pose || 'stand' }, yaw: BASE_YAW, pitch: BASE_PITCH, skin: null, playing: !reducedMotion() && opts.animate !== false };
    const camOf = (look) => {
      const o = lookOpts(look, BASE_YAW, BASE_PITCH);
      return [o.yaw, o.pitch];
    };
    [state.yaw, state.pitch] = camOf(state.look);
    const canvas = document.createElement('canvas');
    canvas.className = 'skin3d__canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    const rotatable = opts.rotate !== false;
    if (!rotatable) canvas.classList.add('skin3d__canvas--fixed');
    const label = () => (rotatable ? `${opts.label || 'Скин'}. Стрелки или перетаскивание — повернуть.` : opts.label || 'Скин');
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
      draw(canvas, state.skin, { ...lookOpts(state.look, 0, 0), slim: state.slim, yaw: state.yaw, pitch: state.pitch, time: state.playing ? (now - started) / 1000 : null, onModel: redraw });
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
      if (!rotatable) return;
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
      if (!rotatable) return;
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
        // Камеру вида поменяли в настройках — она встаёт, как задано; иначе остаётся, куда её повернули.
        const before = camOf(state.look);
        const after = camOf(next.look);
        if (!rotatable || before[0] !== after[0] || before[1] !== after[1]) [state.yaw, state.pitch] = after;
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

  function inPoly(poly, x, y) {
    return !!paramIn(poly, x, y);
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
   * Меняет look на месте; onSelect(key) — выбрали другое, onChange(key) — после каждого шага,
   * onStart/onEnd — начало и конец движения (для «Отменить»).
   *
   * scene: true — редактор всей сцены (студия персонажа):
   *   — выбрать можно и предмет ('held:<слот>'), и блок ('block:<i>'), и моба ('mob:<i>'), и всю фигуру ('figure' —
   *     двойное нажатие на персонажа); пустое место — снять выбор;
   *   — у предмета кольца его своего поворота rot, у блока и моба — зелёное кольцо поворота, у блока ещё стрелка «выше»;
   *     блок и моб тянутся по полу (шаг — snap(key), Shift — наоборот: без сетки или по сетке);
   *   — кольца частей есть и у готовой позы: потянули — поза становится своей (углы — с готовой);
   *   — колёсико (и zoomBy) — приближение, правая или средняя кнопка — сдвинуть кадр, на полу сетка блоков;
   *     приближение и сдвиг кадра из look — это рамка карточки, здесь они не применяются;
   *   — set({ tool }): 'select' | 'place' | 'break'. В 'place' и 'break' нажатие уходит в onTap({ key, normal, ground }):
   *     key — что под мышью, normal — нормаль грани в мире (у блоков), ground — точка пола под мышью;
   *     target(те же данные) → { at, size, rot } | null — где показать рамку будущего блока или моба;
   *   — set({ cameraMode: true }): «камера карточки» — сцена видна через камеру вида (look.camera, scale, offset)
   *     в рамке размера карточки (frame() → { aspect, viewZoom, yaw, pitch }); тянуть — повернуть её, колёсико —
   *     приблизить, правая кнопка — сдвинуть кадр. Это меняет сам look (onStart/onChange/onEnd с ключом 'camera').
   */
  function poser(opts = {}) {
    const scene = !!opts.scene;
    let baseYaw = opts.yaw === undefined ? 25 : opts.yaw;
    let basePitch = opts.pitch === undefined ? 10 : opts.pitch;
    // Приближение кадра в начале (сцена студии: чуть дальше — видно блоки вокруг).
    const baseZoom = Math.max(0.05, Math.min(8, Number(opts.zoom) || 1));
    const state = { url: opts.url, slim: !!opts.slim, look: opts.look, part: opts.part || null, yaw: 0, pitch: basePitch, zoom: baseZoom, pan: [0, 0], tool: 'select', mode: opts.mode || 'rotate', skin: null, cameraMode: false };
    const canvas = document.createElement('canvas');
    canvas.className = 'skin3d__canvas poser__canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute(
      'aria-label',
      scene
        ? `${opts.label || 'Сцена'}. Нажмите на часть тела, предмет, блок или моба и тяните цветные кольца; стрелки — повернуть камеру, плюс и минус — приблизить.`
        : `${opts.label || 'Своя поза'}. Нажмите на часть тела и тяните цветные кольца; стрелки — повернуть камеру.`
    );
    const el = document.createElement('div');
    el.className = 'skin3d poser';
    el.append(canvas);

    let info = null; // как модель легла на холст в последнем кадре
    let hits = [];
    let gizmo = null; // кольца выбранного в пикселях холста
    let hover = null;
    let aim = null; // инструмент 'place' — { at, size, rot } будущего блока; 'break' — ключ блока под мышью
    let drag = null;
    let frame = 0;
    let alive = true;
    let lastTap = null;

    const LOOK = () => (window.Api && window.Api.LOOK) || {};
    const limits = () => LOOK().blocks || { side: 1024, y: [-1024, 1024] };
    const moveLimit = () => LOOK().move || 256;
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const r2 = (v) => Math.round(v * 100) / 100;
    // Ключи: часть тела персонажа ('rightArm'), 'figure', 'held:<слот>', 'block:<i>', 'mob:<i>' и часть игрока на сцене 'mob:<i>:<часть>'.
    const kindOf = (key) =>
      !key ? null : PART_KEYS.has(key) ? 'part' : key === 'figure' ? 'figure' : key.startsWith('held:') ? 'held' : key.startsWith('block:') ? 'block' : key.startsWith('mob:') ? (key.split(':').length === 3 ? 'mobpart' : 'mob') : null;
    const isLimb = (key) => kindOf(key) === 'part' || kindOf(key) === 'mobpart';
    /** Часть тела по ключу: 'mob:2:rightArm' → 'rightArm'. */
    const limbOf = (key) => (kindOf(key) === 'mobpart' ? key.split(':')[2] : key);
    /** Моб, которому принадлежит часть: 'mob:2:rightArm' → 'mob:2'. */
    const mobKeyOf = (key) => key.split(':').slice(0, 2).join(':');
    const heldOf = (key) => (state.look && state.look.held && state.look.held[key.slice(5)]) || null;
    const blockOf = (key) => (state.look && Array.isArray(state.look.blocks) && state.look.blocks[Number(key.slice(6))]) || null;
    const mobOf = (key) => (state.look && Array.isArray(state.look.mobs) && state.look.mobs[Number(key.split(':')[1])]) || null;
    /**
     * Чья часть тела: персонажа (look) или игрока на сцене (запись моба) — у обоих pose и angles; api — как скелет лёг в вид.
     */
    const ownerOf = (key) => {
      if (kindOf(key) === 'mobpart') {
        const m = mobOf(key);
        const api = info && info.mobRig(Number(key.split(':')[1]));
        return m && api ? { obj: m, api } : null;
      }
      return info ? { obj: state.look, api: info } : null;
    };
    /** Углы своей позы части (меняются на месте); готовая поза — сначала стать своей (ensure). */
    const anglesOf = (key) => (ownerOf(key) || {}).obj.angles;
    const ensureCustom = (key) => {
      const o = ownerOf(key);
      if (o && o.obj.pose !== 'custom') {
        o.obj.angles = poseAngles(o.obj.pose);
        o.obj.pose = 'custom';
      }
    };
    const shiftOf = (key) => {
      const a = anglesOf(key);
      const m = a && a.move;
      return (m && Array.isArray(m[limbOf(key)]) && m[limbOf(key)]) || [0, 0, 0];
    };
    /** Блок или моб — то, что стоит в мире и тянется по полу. */
    const thingOf = (key) => (kindOf(key) === 'block' ? blockOf(key) : kindOf(key) === 'mob' ? mobOf(key) : null);
    const dprOf = () => canvas.width / (canvas.clientWidth || canvas.width);

    /** Рамка карточки на холсте (режим камеры): по размеру карточки, с полями. */
    function frameRect() {
      const f = opts.frame ? opts.frame() : null;
      const aspect = (f && f.aspect) || 320 / 270;
      const W = canvas.width;
      const H = canvas.height;
      const h = Math.min(H * 0.86, (W * 0.86) / aspect);
      const w = h * aspect;
      return { x: (W - w) / 2, y: (H - h) / 2, w, h, viewZoom: (f && f.viewZoom) || 1, yaw: f ? f.yaw : baseYaw, pitch: f ? f.pitch : basePitch };
    }

    function resetCamera() {
      const o = lookOpts(state.look, baseYaw, basePitch);
      state.yaw = o.yaw;
      state.pitch = o.pitch;
      state.zoom = baseZoom;
      state.pan = [0, 0];
      redraw();
    }

    /** Приближение к точке холста (x, y): она остаётся под мышью. */
    function zoomAt(x, y, z) {
      if (state.cameraMode) return cameraZoomAt(x, y, z / state.zoom);
      z = clamp(z, 0.05, 8);
      const k = z / state.zoom;
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      state.pan = [x - cx - (x - cx - state.pan[0]) * k, y - cy - (y - cy - state.pan[1]) * k];
      state.zoom = z;
      redraw();
    }

    /* ---------------- камера карточки: приближение (look.scale) и сдвиг кадра (look.offset) */

    function cameraZoomAt(x, y, k) {
      const l = state.look;
      const [lo, hi] = LOOK().scale || [0.05, 20];
      const fr = frameRect();
      const fit = Math.min(fr.w / WIDTH, fr.h / HEIGHT) * fr.viewZoom;
      const z0 = typeof l.scale === 'number' ? l.scale : 1;
      const z1 = clamp(Math.round(z0 * k * 1000) / 1000, lo, hi);
      if (z1 === z0) return;
      const off = Array.isArray(l.offset) ? l.offset.slice() : [0, 0];
      // Точка под мышью остаётся на месте: экран = c + o·fit + C·fit·(1 − z) + p·fit·z (по x без C).
      const fx = fr.x + fr.w / 2;
      const fy = fr.y + fr.h / 2;
      const px = (x - fx - off[0] * fit) / (fit * z0);
      const py = (y - fy + off[1] * fit - CENTER_Y * fit * (1 - z0)) / (fit * z0);
      off[0] = (x - fx - px * fit * z1) / fit;
      off[1] = -(y - fy - CENTER_Y * fit * (1 - z1) - py * fit * z1) / fit;
      const M = LOOK().offset || 2000;
      l.scale = z1;
      l.offset = off.map((v) => clamp(Math.round(v * 10) / 10, -M, M));
      if (opts.onChange) opts.onChange('camera');
      redraw();
    }

    /**
     * Ручки выбранного на сцене. Режимы (как в Blockbench): 'rotate' — кольца поворота, 'move' — стрелки сдвига
     * по осям и кружок в середине (тянуть в плоскости экрана), 'scale' — кубики растяжения по осям части тела
     * и квадрат в середине (всё сразу; у предметов, блоков, мобов и всей фигуры — только он: размер у них один).
     * Ручка: { id, kind: 'axis' | 'stretch' | 'uniform' | 'free', value(), set(v, free) } + где она на холсте.
     */
    function buildGizmo() {
      if (!info || !state.part || state.tool !== 'select' || state.cameraMode) return null;
      const kind = kindOf(state.part);
      const mode = scene ? state.mode : 'rotate';
      if (mode === 'move') return moveGizmo(kind);
      if (mode === 'scale') return scaleGizmo(kind);
      const look = state.look || {};
      const dpr = dprOf();
      // Кольца — пятая часть кадра; в отдалённой сцене меньше, чтобы не закрывали соседние части тела.
      const px = Math.max(44 * dpr, Math.min(canvas.width, canvas.height) * 0.2 * (scene ? Math.min(1, state.zoom) : 1));
      let R = px / info.scale;
      let c;
      let axes;
      let arrow = null;
      if (kind === 'part' || kind === 'mobpart') {
        const o = ownerOf(state.part);
        if (!o || (o.obj.pose !== 'custom' && !scene)) return null;
        c = o.api.pivot(limbOf(state.part));
        axes = o.api.axes(limbOf(state.part)).map((A, i) => ({ i, A }));
      } else if (kind === 'held') {
        const e = heldOf(state.part);
        const held = e && info.held(state.part.slice(5), e.rot || [0, 0, 0]);
        if (!held) return null;
        c = held.center;
        axes = held.axes.map((A, i) => ({ i, A }));
      } else if (kind === 'block' || kind === 'mob' || kind === 'figure') {
        c = centerOf(kind);
        if (!c) return null;
        const size = kind === 'figure' ? look.size || 1 : (thingOf(state.part).size || 1) * (kind === 'mob' ? 1.5 : 1);
        R = Math.max(R * 0.8, 13 * size);
        axes = [{ i: 1, A: norm(info.camera([0, 1, 0])) }];
      } else {
        return null;
      }
      const cs = info.toScreen(c);
      const rings = axes.map(({ i, A }) => {
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
      if (isLimb(state.part) && limbOf(state.part) === 'body') {
        // «Присесть» — стрелка у правого края на высоте пояса: на самой фигуре она закрывала бы ноги.
        const down = ownerOf(state.part).api.down();
        const x = canvas.width - 32 * dpr;
        const y = Math.max(40 * dpr, Math.min(canvas.height - 56 * dpr, cs[1]));
        arrow = { from: [x, y - 26 * dpr], to: [x, y + 26 * dpr], perUnit: [down[0] * info.scale, -down[1] * info.scale], sign: -1, label: 'присесть' };
      } else if (kind === 'block') {
        // «Выше» — стрелка вверх над блоком: тянуть вверх-вниз.
        const b = blockOf(state.part);
        const up = info.camera([0, 1, 0]);
        const top = info.toScreen(info.view(add(b.at, [0, 16 * (b.size || 1) * (BLOCK / 16), 0])));
        const d = norm([up[0], -up[1], 0]);
        arrow = {
          from: [top[0] + d[0] * 10 * dpr, top[1] + d[1] * 10 * dpr],
          to: [top[0] + d[0] * 54 * dpr, top[1] + d[1] * 54 * dpr],
          perUnit: [up[0] * info.scale, -up[1] * info.scale],
          sign: 1,
          label: 'выше',
        };
      }
      const arrows = arrow ? [{ ...arrow, id: 'lift', kind: 'axis', color: AXIS_COLORS[1], tip: 'arrow', value: arrowValue, set: setArrow }] : [];
      return { kind, mode: 'rotate', c, cs, R, px, dpr, rings, arrows, center: null };
    }

    /** Длина стрелок и кубиков на холсте: заметная на большой сцене, не меньше 72 точек. */
    const handleLen = (k) => k * Math.max(72 * dprOf(), Math.min(canvas.width, canvas.height) * 0.17 * (scene ? Math.min(1, Math.sqrt(state.zoom)) : 1));

    /** Ручки вдоль направлений dirs (вид) из точки cs; ось, что смотрит на нас (короткая), не рисуется. */
    function axisHandles(cs, dirs, len, make) {
      const dpr = dprOf();
      const out = [];
      dirs.forEach((v, i) => {
        const sv = [v[0] * info.scale, -v[1] * info.scale];
        const l = Math.hypot(sv[0], sv[1]);
        if (l < 1e-6 || l < 0.2 * Math.hypot(v[0], v[1], v[2]) * info.scale) return;
        const u = [sv[0] / l, sv[1] / l];
        out.push({ i, color: AXIS_COLORS[i], from: [cs[0] + u[0] * 12 * dpr, cs[1] + u[1] * 12 * dpr], to: [cs[0] + u[0] * len, cs[1] + u[1] * len], u, perUnit: sv, ...make(i) });
      });
      return out;
    }

    /** Середина выбранного (вид) или null. */
    function centerOf(kind) {
      if (kind === 'part' || kind === 'mobpart') {
        const o = ownerOf(state.part);
        return o ? o.api.center(limbOf(state.part)) : null;
      }
      if (kind === 'figure') return info.figureCenter();
      if (kind === 'held') {
        const e = heldOf(state.part);
        const held = e && info.held(state.part.slice(5), e.rot || [0, 0, 0]);
        return held ? held.center : null;
      }
      if (kind === 'block') {
        const b = blockOf(state.part);
        return b ? info.view(add(b.at, [0, 8 * (b.size || 1) * (BLOCK / 16), 0])) : null;
      }
      if (kind === 'mob') {
        const m = mobOf(state.part);
        return m ? info.view(add(m.at, [0, 12 * (m.size || 1), 0])) : null;
      }
      return null;
    }

    function moveGizmo(kind) {
      const c = centerOf(kind);
      if (!c) return null;
      const cs = info.toScreen(c);
      let dirs = isLimb(state.part) ? ownerOf(state.part).api.figureAxes() : info.worldAxes();
      if (kind === 'held') {
        const held = info.held(state.part.slice(5), heldOf(state.part).rot || [0, 0, 0]);
        if (!held) return null;
        dirs = held.moveDirs;
      }
      const len = handleLen(1);
      const arrows = axisHandles(cs, dirs, len, (i) => ({
        id: 'm' + i,
        kind: 'axis',
        tip: 'arrow',
        value: () => moveGet()[i],
        set: (x, free) => {
          const m = moveGet();
          m[i] = x;
          moveSet(m, free, i);
        },
      }));
      // Блок и моб и так тянутся по полу, если взять их самих.
      const center = isLimb(state.part) || kind === 'figure' ? { id: 'free', kind: 'free', at: cs, value: moveGet, set: (m, free) => moveSet(m, free) } : null;
      return { kind, mode: 'move', c, cs, px: len, dpr: dprOf(), rings: [], arrows, center };
    }

    function scaleGizmo(kind) {
      const c = centerOf(kind);
      if (!c) return null;
      const cs = info.toScreen(c);
      const len = handleLen(0.85);
      const limb = isLimb(state.part);
      const arrows = limb
        ? axisHandles(cs, ownerOf(state.part).api.partAxes(limbOf(state.part)), len, (i) => ({
              id: 's' + i,
              kind: 'stretch',
              tip: 'cube',
              len,
              value: () => stretchGet()[i],
              set: (x, free) => {
                const k = stretchGet();
                k[i] = x;
                stretchSet(k, free);
              },
            }))
          : [];
      const center = { id: 'uniform', kind: 'uniform', at: cs, value: limb ? stretchGet : sizeGet, set: limb ? stretchSet : sizeSet };
      return { kind, mode: 'scale', c, cs, px: len, dpr: dprOf(), rings: [], arrows, center };
    }

    // Сдвиг: части тела — angles.move, всей фигуры — pos, предмета — at, блока и моба — at (по сетке). only — какую ось округлять.
    function moveGet() {
      const kind = kindOf(state.part);
      if (isLimb(state.part)) return shiftOf(state.part).slice();
      if (kind === 'figure') return (state.look.pos || [0, 0, 0]).slice();
      if (kind === 'held') return (heldOf(state.part).at || [0, 0, 0]).slice();
      return thingOf(state.part).at.slice();
    }
    function moveSet(v, free, only) {
      const kind = kindOf(state.part);
      const snap = (x, i, step, lo, hi) => (only === undefined || only === i ? clamp(Math.round(x / step) * step, lo, hi) : clamp(x, lo, hi));
      if (kind === 'part' || kind === 'mobpart') {
        const M = moveLimit();
        const a = anglesOf(state.part);
        a.move = a.move || {};
        a.move[limbOf(state.part)] = v.map((x, i) => r2(snap(x, i, free ? 1 : 0.5, -M, M)));
      } else if (kind === 'figure') {
        const L = limits();
        state.look.pos = v.map((x, i) => r2(i === 1 ? snap(x, i, free ? 1 : 0.5, L.y[0], L.y[1]) : snap(x, i, free ? 1 : 0.5, -L.side, L.side)));
      } else if (kind === 'held') {
        const M = (LOOK().held && LOOK().held.at) || 128;
        heldOf(state.part).at = v.map((x, i) => r2(snap(x, i, free ? 1 : 0.5, -M, M)));
      } else {
        const L = limits();
        const step = snapStep(state.part, free);
        thingOf(state.part).at = v.map((x, i) => r2(i === 1 ? snap(x, i, step, L.y[0], L.y[1]) : snap(x, i, step, -L.side, L.side)));
      }
    }
    // Растяжение части тела: angles.stretch[часть] = [x, y, z]; у предмета, блока, моба и всей фигуры — один размер.
    function stretchGet() {
      const a = anglesOf(state.part);
      const k = a && a.stretch && a.stretch[limbOf(state.part)];
      return k ? k.slice() : [1, 1, 1];
    }
    function stretchSet(v, free) {
      const [lo, hi] = LOOK().stretch || [0.05, 20];
      const step = free ? 0.25 : 0.05;
      const a = anglesOf(state.part);
      a.stretch = a.stretch || {};
      a.stretch[limbOf(state.part)] = v.map((x) => r2(clamp(Math.round(x / step) * step, lo, hi)));
    }
    function sizeGet() {
      const kind = kindOf(state.part);
      if (kind === 'figure') return state.look.size || 1;
      if (kind === 'held') return heldOf(state.part).size || 1;
      return thingOf(state.part).size || 1;
    }
    function sizeSet(v, free) {
      const kind = kindOf(state.part);
      const L = LOOK();
      const range = kind === 'figure' ? L.size || [0.05, 20] : kind === 'held' ? (L.held && L.held.size) || [0.1, 8] : kind === 'mob' ? (L.mobs && L.mobs.size) || [0.1, 8] : (L.blocks && L.blocks.size) || [0.1, 8];
      const step = free ? 0.25 : 0.05;
      const x = r2(clamp(Math.round(v / step) * step || step, range[0], range[1]));
      if (kind === 'figure') state.look.size = x;
      else if (kind === 'held') heldOf(state.part).size = x;
      else thingOf(state.part).size = x;
    }

    // Значения, которые крутят кольца и тянет стрелка, — у части тела, предмета, блока, моба или всей фигуры.
    function ringValue(i) {
      const kind = kindOf(state.part);
      if (isLimb(state.part)) return anglesOf(state.part)[limbOf(state.part)][i];
      if (kind === 'held') return (heldOf(state.part).rot || [0, 0, 0])[i];
      if (kind === 'figure') return state.look.turn || 0;
      return thingOf(state.part).rot || 0;
    }
    function setRing(i, v) {
      const kind = kindOf(state.part);
      if (isLimb(state.part)) anglesOf(state.part)[limbOf(state.part)][i] = v;
      else if (kind === 'held') {
        const e = heldOf(state.part);
        e.rot = (e.rot || [0, 0, 0]).slice();
        e.rot[i] = v;
      } else if (kind === 'figure') state.look.turn = v;
      else thingOf(state.part).rot = v;
    }
    const arrowValue = () => (kindOf(state.part) === 'block' ? blockOf(state.part).at[1] : anglesOf(state.part).lift || 0);
    function setArrow(v, free) {
      if (kindOf(state.part) === 'block') {
        const b = blockOf(state.part);
        const step = snapStep(state.part, free);
        b.at = [b.at[0], clamp(Math.round(v / step) * step, limits().y[0], limits().y[1]), b.at[2]];
      } else {
        const [lo, hi] = LOOK().lift || [-64, 64];
        anglesOf(state.part).lift = clamp(Math.round(v), lo, hi);
      }
    }
    /** Шаг сетки для блока или моба; Shift (inverse) — наоборот. */
    function snapStep(key, inverse) {
      const step = opts.snap ? opts.snap(key) : 1;
      if (!inverse) return step;
      const b = thingOf(key);
      return step > 1 ? 1 : 16 * ((b && b.size) || 1);
    }

    function paintBox(g, box, dpr) {
      const s = (box.size || 1) * (box.mob ? 0.75 : BLOCK / 16);
      const hgt = box.mob ? 32 * (box.size || 1) : 16 * s;
      const corner = (sx, y, sz) => info.toScreen(info.view(add(rotate([sx * 8 * s, y, sz * 8 * s], [0, box.rot || 0, 0]), box.at)));
      const lo = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => corner(a, 0, b));
      const hi = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => corner(a, hgt, b));
      g.strokeStyle = 'rgba(255, 255, 255, 0.9)';
      g.fillStyle = 'rgba(255, 255, 255, 0.12)';
      g.lineWidth = 1.5 * dpr;
      g.setLineDash([4 * dpr, 3 * dpr]);
      g.beginPath();
      for (const ring of [lo, hi]) {
        ring.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
        g.closePath();
      }
      for (let k = 0; k < 4; k++) {
        g.moveTo(lo[k][0], lo[k][1]);
        g.lineTo(hi[k][0], hi[k][1]);
      }
      g.stroke();
      g.beginPath();
      lo.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.fill();
      g.setLineDash([]);
    }

    /** Режим камеры: всё вне рамки карточки притемнено, рамка — белой линией. */
    function paintFrame(g, fr, dpr) {
      g.fillStyle = 'rgba(8, 10, 14, 0.55)';
      g.beginPath();
      g.rect(0, 0, canvas.width, canvas.height);
      g.rect(fr.x + fr.w, fr.y, -fr.w, fr.h);
      g.fill('evenodd');
      g.strokeStyle = 'rgba(255, 255, 255, 0.85)';
      g.lineWidth = 1.5 * dpr;
      g.strokeRect(fr.x, fr.y, fr.w, fr.h);
      g.font = `600 ${11 * dpr}px system-ui, sans-serif`;
      g.fillStyle = 'rgba(255, 255, 255, 0.9)';
      g.textAlign = 'left';
      g.textBaseline = 'bottom';
      g.fillText('Так увидят на карточке', fr.x + 2 * dpr, fr.y - 5 * dpr);
    }

    function paintOverlay() {
      const g = canvas.getContext('2d');
      const dpr = dprOf();
      g.save();
      g.lineCap = 'round';
      g.lineJoin = 'round';
      if (state.cameraMode) {
        paintFrame(g, info.frame, dpr);
        g.restore();
        return;
      }
      const outline = (key, stroke, fill) => {
        g.strokeStyle = stroke;
        g.lineWidth = 1.25 * dpr;
        if (fill) g.fillStyle = fill;
        for (const hit of hits) {
          // Весь персонаж — все его части и предметы; игрок на сцене ('mob:<i>') — все его части.
          const mine = key === 'figure' ? PART_KEYS.has(hit.key) || hit.key.startsWith('held:') : hit.key === key || hit.key.startsWith(key + ':');
          if (!mine) continue;
          g.beginPath();
          hit.poly.forEach(([x, y], k) => (k ? g.lineTo(x, y) : g.moveTo(x, y)));
          g.closePath();
          if (fill) g.fill();
          g.stroke();
        }
      };
      // Выбранное — тонкий контур.
      if (state.part && state.tool === 'select' && (gizmo || scene)) outline(state.part, 'rgba(255, 255, 255, 0.55)');
      if (state.tool === 'break' && typeof aim === 'string') outline(aim, '#ff6b6b', 'rgba(255, 80, 80, 0.28)');
      if (state.tool === 'place' && aim && aim.at) paintBox(g, aim, dpr);
      if (gizmo) paintGizmo(g);
      g.restore();
    }

    function paintGizmo(g) {
      const z = gizmo;
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
      for (const a of z.arrows) {
        const { from, to } = a;
        const ang = Math.atan2(to[1] - from[1], to[0] - from[0]);
        const head = 9 * z.dpr;
        g.strokeStyle = g.fillStyle = a.color;
        g.lineWidth = (active(a.id) ? 4.5 : 3) * z.dpr;
        g.beginPath();
        g.moveTo(from[0], from[1]);
        const back = a.tip === 'arrow' ? head * 0.6 : 0;
        g.lineTo(to[0] - Math.cos(ang) * back, to[1] - Math.sin(ang) * back);
        g.stroke();
        if (a.tip === 'arrow') {
          g.beginPath();
          g.moveTo(to[0], to[1]);
          g.lineTo(to[0] - Math.cos(ang - 0.45) * head, to[1] - Math.sin(ang - 0.45) * head);
          g.lineTo(to[0] - Math.cos(ang + 0.45) * head, to[1] - Math.sin(ang + 0.45) * head);
          g.closePath();
          g.fill();
        } else {
          const r = (active(a.id) ? 7 : 5.5) * z.dpr;
          g.fillRect(to[0] - r, to[1] - r, 2 * r, 2 * r);
        }
        if (a.label) {
          // Подпись — за остриём: у стрелки вниз под ним, у стрелки вверх над ним.
          const down = to[1] >= from[1];
          g.font = `600 ${11 * z.dpr}px system-ui, sans-serif`;
          g.textAlign = 'center';
          g.textBaseline = down ? 'top' : 'bottom';
          g.fillText(a.label, to[0], to[1] + (down ? 5 : -5) * z.dpr);
        }
      }
      if (z.center) {
        // Середина: кружок — тянуть в плоскости экрана, квадрат — растянуть всё сразу (вправо-вверх — больше).
        const r = (active(z.center.id) ? 9 : 7) * z.dpr;
        const [x, y] = z.center.at;
        g.lineWidth = 2 * z.dpr;
        g.strokeStyle = '#fff';
        g.fillStyle = 'rgba(255, 255, 255, 0.3)';
        g.beginPath();
        if (z.center.kind === 'free') g.arc(x, y, r, 0, Math.PI * 2);
        else g.rect(x - r, y - r, 2 * r, 2 * r);
        g.fill();
        g.stroke();
      } else {
        // Центр поворота.
        g.fillStyle = '#fff';
        g.beginPath();
        g.arc(z.cs[0], z.cs[1], 3 * z.dpr, 0, Math.PI * 2);
        g.fill();
      }
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
      let look;
      let camera;
      if (state.cameraMode) {
        // Через камеру карточки: как у карточки, только крупнее, в рамке её размера.
        const fr = frameRect();
        look = lookOpts(state.look, fr.yaw, fr.pitch);
        camera = { frame: fr, viewZoom: fr.viewZoom, floor: true };
      } else {
        look = lookOpts(state.look, baseYaw, basePitch);
        // В студии рамка карточки (приближение и сдвиг кадра) не нужна: камера своя — приближение, сдвиг и сетка на полу.
        camera = scene ? { zoom: 1, offset: null, viewZoom: state.zoom, pan: state.pan, floor: true, yaw: state.yaw, pitch: state.pitch } : { yaw: state.yaw, pitch: state.pitch };
      }
      hits = [];
      info = draw(canvas, state.skin, { ...look, ...camera, slim: state.slim, time: null, hits, onModel: redraw });
      gizmo = buildGizmo();
      if (info) paintOverlay();
    };
    const redraw = () => {
      if (!frame) frame = requestAnimationFrame(render);
    };

    /** Что под точкой холста: кольцо (0, 1, 2), ручка { target, handle }, часть тела (в сцене — и предмет, блок, моб) { part } или null. */
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
        for (const a of gizmo.arrows) {
          const d = segDist([x, y], a.from, a.to);
          if (d < near && (!best || d < best.d)) best = { d, target: a.id, handle: a };
        }
        if (gizmo.center) {
          const d = Math.hypot(x - gizmo.center.at[0], y - gizmo.center.at[1]) - 3 * gizmo.dpr;
          if (d < near && (!best || d < best.d)) best = { d, target: gizmo.center.id, handle: gizmo.center };
        }
        if (best) return best;
      }
      return hitAt(x, y);
    }

    /** Что нарисовано под точкой (без колец): { part } или null. */
    function hitAt(x, y) {
      const top = topHit(hits, x, y);
      if (!top) return null;
      // Предметы, блоки и мобы закрывают тело; выбрать их можно только в редакторе сцены (студии).
      return PART_KEYS.has(top.key) || scene ? { part: top.key } : null;
    }

    /** Для инструментов «ставить»/«ломать»: что под мышью, нормаль грани (в мире), точка пола. */
    function under(x, y) {
      const top = topHit(hits, x, y);
      return { key: top ? top.key : null, normal: top && top.normal && info ? info.toWorldDir(top.normal) : null, ground: info ? info.unproject(x, y, 0) : null };
    }

    const pointer = (e) => {
      const r = canvas.getBoundingClientRect();
      return [((e.clientX - r.left) * canvas.width) / (r.width || 1), ((e.clientY - r.top) * canvas.height) / (r.height || 1)];
    };

    function select(key) {
      if (key === state.part) return;
      state.part = key;
      if (opts.onSelect) opts.onSelect(key);
    }

    /** Начало движения кольцом или стрелкой: запомнить «как было» и, если поза готовая, сделать её своей. */
    function begin() {
      if (opts.onStart) opts.onStart(state.part);
      if (isLimb(state.part)) ensureCustom(state.part);
    }

    const capture = (e) => {
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // указатель уже отпущен — тянуть всё равно можно, пока он над холстом
      }
    };

    canvas.addEventListener('pointerdown', (e) => {
      const [x, y] = pointer(e);
      if (state.cameraMode) {
        e.preventDefault();
        capture(e);
        const l = state.look;
        const cam = l.camera || { yaw: baseYaw, pitch: basePitch };
        drag = { target: e.button === 1 || e.button === 2 ? 'cam-pan' : 'cam-turn', x, y, cam: { ...cam }, offset: Array.isArray(l.offset) ? l.offset.slice() : [0, 0], started: false };
        return;
      }
      if (scene && (e.button === 1 || e.button === 2)) {
        e.preventDefault();
        capture(e);
        drag = { target: 'pan', x, y, pan: state.pan.slice() };
        return;
      }
      if (e.button !== undefined && e.button !== 0) return;
      const hit = state.tool === 'select' ? pick(x, y) : null;
      capture(e);
      if (state.tool !== 'select') {
        // «Ставить» и «Ломать»: нажатие без движения — действие, с движением — повернуть камеру.
        drag = { target: 'camera', x, y, yaw: state.yaw, pitch: state.pitch, moved: false, tap: true };
        return;
      }
      const angles = state.look && state.look.angles;
      // Двойное нажатие на персонажа (или игрока на сцене) — выбрать его целиком (что под мышью — без колец: они у выбранной части).
      const now = performance.now();
      const below = scene ? hitAt(x, y) : null;
      const whole = below && (kindOf(below.part) === 'part' || below.part.startsWith('held:') ? 'figure' : kindOf(below.part) === 'mobpart' ? mobKeyOf(below.part) : null);
      const twice = whole && lastTap && now - lastTap.t < 400 && Math.hypot(x - lastTap.x, y - lastTap.y) < 8 * dprOf();
      lastTap = { t: now, x, y };
      if (twice) {
        select(whole);
        drag = null;
        redraw();
        return;
      }
      // Кольцо и стрелка: изменение (и шаг отмены) — с первого движения; просто нажатие — выбрать то, что под ними.
      if (hit && hit.handle && (angles || scene)) {
        drag = { target: hit.target, handle: hit.handle, x, y, from: null, started: false };
      } else if (hit && hit.target !== undefined && (angles || scene)) {
        const { A } = hit.ring;
        const r = sub(hit.at.p, gizmo.c);
        const t3 = cross(A, r);
        drag = {
          target: hit.target,
          x,
          y,
          from: 0,
          started: false,
          // Кольцо смотрит на нас — крутим вокруг центра; стоит ребром — тянем вдоль касательной.
          facing: Math.abs(A[2]) > 0.3 ? Math.sign(A[2]) : 0,
          phi: Math.atan2(y - gizmo.cs[1], x - gizmo.cs[0]),
          turned: 0,
          tangent: [t3[0] * info.scale, -t3[1] * info.scale],
          px: gizmo.px,
        };
      } else if (scene && state.mode === 'move' && hit && hit.part && (hit.part === state.part || (state.part === 'figure' && kindOf(hit.part) === 'part')) && isLimb(hit.part) && info) {
        // «Двигать»: уже выбранную часть тела (или всю фигуру) тянем — она сдвигается в плоскости экрана.
        drag = { target: 'free', handle: { kind: 'free', value: moveGet, set: (m, free) => moveSet(m, free) }, x, y, from: null, started: false };
      } else if (scene && hit && (kindOf(hit.part) === 'block' || kindOf(hit.part) === 'mob' || (kindOf(hit.part) === 'mobpart' && mobKeyOf(hit.part) === state.part)) && info) {
        // Блок или моб (игрок на сцене — когда выбран целиком): выбрать и сразу тянуть по полу (на его высоте).
        // Игрок выбран целиком: потянули — едет по полу, просто нажали на часть тела — выбрать её.
        const key = kindOf(hit.part) === 'mobpart' ? mobKeyOf(hit.part) : hit.part;
        const b = thingOf(key);
        select(key);
        drag = { target: 'move', key, x, y, from: b.at.slice(), start: info.unproject(x, y, b.at[1]), moved: false, tapPart: kindOf(hit.part) === 'mobpart' ? hit.part : null };
        redraw();
        return;
      } else {
        drag = { target: 'camera', x, y, yaw: state.yaw, pitch: state.pitch, moved: false, part: hit ? hit.part : null };
        return;
      }
      redraw();
    });

    canvas.addEventListener('pointermove', (e) => {
      const [x, y] = pointer(e);
      if (!drag) {
        if (state.cameraMode) {
          canvas.style.cursor = 'grab';
          return;
        }
        if (state.tool !== 'select') {
          const u = under(x, y);
          const next = state.tool === 'place' ? (opts.target ? opts.target(u) : null) : kindOf(u.key) === 'block' || kindOf(u.key) === 'mob' ? u.key : kindOf(u.key) === 'mobpart' ? mobKeyOf(u.key) : null;
          canvas.style.cursor = next ? 'crosshair' : '';
          if (JSON.stringify(next) !== JSON.stringify(aim)) {
            aim = next;
            redraw();
          }
          return;
        }
        const hit = pick(x, y);
        const next = hit ? (hit.target !== undefined ? hit.target : 'part') : null;
        canvas.style.cursor =
          next === null ? '' : next === 'part' ? (scene && state.mode === 'move' && isLimb(hit.part) && (hit.part === state.part || (state.part === 'figure' && kindOf(hit.part) === 'part') || mobKeyOf(hit.part) === state.part) ? 'move' : 'pointer') : 'grab';
        if (next !== hover) {
          hover = next;
          redraw();
        }
        return;
      }
      const dpr = dprOf();
      if (drag.target === 'cam-turn' || drag.target === 'cam-pan') {
        if (!drag.started) {
          if (Math.hypot(x - drag.x, y - drag.y) < 3 * dpr) return;
          drag.started = true;
          if (opts.onStart) opts.onStart('camera');
        }
        const l = state.look;
        if (drag.target === 'cam-turn') {
          l.camera = { yaw: Math.round(wrap180(drag.cam.yaw + ((x - drag.x) / dpr) * 0.5)), pitch: Math.round(clamp(drag.cam.pitch + ((y - drag.y) / dpr) * 0.35, -89, 89)) };
        } else {
          const fr = frameRect();
          const fit = Math.min(fr.w / WIDTH, fr.h / HEIGHT) * fr.viewZoom;
          const M = LOOK().offset || 2000;
          l.offset = [clamp(Math.round((drag.offset[0] + (x - drag.x) / fit) * 10) / 10, -M, M), clamp(Math.round((drag.offset[1] - (y - drag.y) / fit) * 10) / 10, -M, M)];
        }
        redraw();
        if (opts.onChange) opts.onChange('camera');
        return;
      }
      if (drag.target === 'pan') {
        state.pan = [drag.pan[0] + x - drag.x, drag.pan[1] + y - drag.y];
        redraw();
        return;
      }
      if (drag.target === 'camera') {
        if (Math.hypot(x - drag.x, y - drag.y) > 4 * dpr) drag.moved = true;
        state.yaw = drag.yaw + ((x - drag.x) / dpr) * 0.7;
        state.pitch = Math.max(-89, Math.min(89, drag.pitch + ((y - drag.y) / dpr) * 0.4));
        redraw();
        return;
      }
      if (drag.target === 'move') {
        if (!drag.moved) {
          if (Math.hypot(x - drag.x, y - drag.y) < 4 * dpr) return;
          drag.moved = true;
          if (opts.onStart) opts.onStart(drag.key);
        }
        const b = thingOf(drag.key);
        const p = info && info.unproject(x, y, drag.from[1]);
        if (!b || !p || !drag.start) return;
        const step = snapStep(drag.key, e.shiftKey);
        const S = limits().side;
        const snap = (v) => clamp(Math.round(v / step) * step, -S, S);
        b.at = [r2(snap(drag.from[0] + p[0] - drag.start[0])), drag.from[1], r2(snap(drag.from[2] + p[2] - drag.start[2]))];
        redraw();
        if (opts.onChange) opts.onChange(drag.key);
        return;
      }
      if (!drag.started) {
        if (Math.hypot(x - drag.x, y - drag.y) < 3 * dpr) return;
        drag.started = true;
        begin();
        if (drag.handle) {
          const v = drag.handle.value();
          drag.from = Array.isArray(v) ? v.slice() : v;
        } else drag.from = ringValue(drag.target);
      }
      if (drag.handle) {
        const hd = drag.handle;
        const dx = x - drag.x;
        const dy = y - drag.y;
        if (hd.kind === 'axis') {
          const u = hd.perUnit;
          hd.set(drag.from + ((dx * u[0] + dy * u[1]) / (u[0] * u[0] + u[1] * u[1] || 1)) * (hd.sign || 1), e.shiftKey);
        } else if (hd.kind === 'stretch') {
          hd.set(drag.from * Math.max(0.05, (hd.len + dx * hd.u[0] + dy * hd.u[1]) / hd.len), e.shiftKey);
        } else if (hd.kind === 'uniform') {
          const f = Math.exp((dx - dy) / (150 * dpr));
          hd.set(Array.isArray(drag.from) ? drag.from.map((v) => v * f) : drag.from * f, e.shiftKey);
        } else if (hd.kind === 'free') {
          if (!info) return;
          const v = [dx / info.scale, -dy / info.scale, 0];
          const d = isLimb(state.part) ? ownerOf(state.part).api.toFigureDir(v) : info.toWorldDir(v);
          hd.set(drag.from.map((w, i) => w + d[i]), e.shiftKey);
        }
      } else {
        if (!gizmo) return;
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
        setRing(drag.target, Math.round(wrap180(v)));
      }
      redraw();
      if (opts.onChange) opts.onChange(state.part);
    });

    const stop = () => {
      if (!drag) return;
      const was = drag;
      drag = null;
      if (was.target === 'pan') return;
      if (was.target === 'cam-turn' || was.target === 'cam-pan') {
        if (was.started && opts.onEnd) opts.onEnd('camera');
        return;
      }
      if (was.target === 'camera') {
        if (!was.moved && was.tap) {
          aim = null;
          if (opts.onTap) opts.onTap(under(was.x, was.y));
        } else if (!was.moved && (was.part || scene) && was.part !== state.part) {
          select(was.part || null);
        }
      } else if (was.target === 'move') {
        if (was.moved && opts.onEnd) opts.onEnd(was.key);
        else if (!was.moved && was.tapPart) select(was.tapPart);
      } else if (!was.started) {
        const below = hitAt(was.x, was.y);
        if (below && below.part !== state.part && !(state.part === 'figure' && kindOf(below.part) === 'part' && was.target === 'free')) select(below.part);
      } else if (opts.onEnd) opts.onEnd(state.part);
      redraw();
    };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    canvas.addEventListener('pointerleave', () => {
      if (drag) return;
      if (hover !== null || aim !== null) {
        hover = null;
        aim = null;
        redraw();
      }
    });
    if (scene) {
      canvas.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          const [x, y] = pointer(e);
          const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
          const k = Math.exp(-dy * 0.0015);
          if (state.cameraMode) {
            if (opts.onStart && !state.wheelGroup) opts.onStart('camera');
            clearTimeout(state.wheelGroup);
            state.wheelGroup = setTimeout(() => {
              state.wheelGroup = 0;
              if (opts.onEnd) opts.onEnd('camera');
            }, 400);
            cameraZoomAt(x, y, k);
          } else zoomAt(x, y, state.zoom * k);
        },
        { passive: false }
      );
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    }
    canvas.addEventListener('keydown', (e) => {
      if (scene && (e.key === '+' || e.key === '=' || e.key === '-')) {
        e.preventDefault();
        zoomBy(e.key === '-' ? 1 / 1.25 : 1.25);
        return;
      }
      const step = { ArrowLeft: [-15, 0], ArrowRight: [15, 0], ArrowUp: [0, -8], ArrowDown: [0, 8] }[e.key];
      if (!step) return;
      e.preventDefault();
      if (state.cameraMode) {
        if (opts.onStart) opts.onStart('camera');
        const cam = state.look.camera || { yaw: baseYaw, pitch: basePitch };
        state.look.camera = { yaw: Math.round(wrap180(cam.yaw + step[0])), pitch: clamp(cam.pitch + step[1], -89, 89) };
        if (opts.onChange) opts.onChange('camera');
        if (opts.onEnd) opts.onEnd('camera');
      } else {
        state.yaw += step[0];
        state.pitch = Math.max(-89, Math.min(89, state.pitch + step[1]));
      }
      redraw();
    });

    /** Приблизить (k > 1) или отдалить к центру кадра. */
    function zoomBy(k) {
      if (state.cameraMode) {
        if (opts.onStart) opts.onStart('camera');
        const fr = frameRect();
        cameraZoomAt(fr.x + fr.w / 2, fr.y + fr.h / 2, k);
        if (opts.onEnd) opts.onEnd('camera');
        return;
      }
      zoomAt(canvas.width / 2, canvas.height / 2, state.zoom * k);
    }

    function set(next = {}) {
      if (next.camera) {
        // Другой вид — камера встаёт, как в нём.
        if (next.camera.yaw !== undefined) baseYaw = next.camera.yaw;
        if (next.camera.pitch !== undefined) basePitch = next.camera.pitch;
        if (next.look) state.look = next.look;
        resetCamera();
      }
      if (next.look) state.look = next.look;
      if (next.part !== undefined) state.part = next.part;
      if (next.slim !== undefined) state.slim = !!next.slim;
      if (next.mode && next.mode !== state.mode) {
        state.mode = next.mode;
        hover = null;
      }
      if (next.tool && next.tool !== state.tool) {
        state.tool = next.tool;
        aim = null;
        hover = null;
        canvas.style.cursor = '';
      }
      if (next.cameraMode !== undefined && !!next.cameraMode !== state.cameraMode) {
        state.cameraMode = !!next.cameraMode;
        el.classList.toggle('is-camera', state.cameraMode);
        hover = null;
        aim = null;
        canvas.style.cursor = state.cameraMode ? 'grab' : '';
      }
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
    return {
      el,
      canvas,
      set,
      resetCamera,
      zoomBy,
      destroy,
      redraw,
      get part() {
        return state.part;
      },
      get zoom() {
        return state.zoom;
      },
      /** Камера студии сейчас: { yaw, pitch } — «снять кадр отсюда». */
      get view() {
        return { yaw: Math.round(wrap180(state.yaw)), pitch: Math.round(clamp(state.pitch, -89, 89)) };
      },
    };
  }

  /**
   * Неподвижная картинка для карточки в сетке: персонаж в позе, вполоборота.
   * Возвращает <canvas>; скин догружается сам.
   */
  function figure({ url, slim, pose: poseKey, look, width = 150, height = 190, viewZoom = 1, label }) {
    const canvas = document.createElement('canvas');
    canvas.className = 'skin3d__figure';
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', label || 'Скин игрока');
    fit(canvas, width, height);
    let current = look || { pose: poseKey };
    let skin = null;
    const paint = () => skin && draw(canvas, skin, { slim, viewZoom, ...lookOpts(current, 28, 8), onModel: paint });
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

  window.Skin3D = { POSES, PARTS, AXIS_COLORS, load, draw, drawIcon, drawMob, viewer, poser, figure, poseAngles, lookOpts, guessSlim, fit, topHit, headModel };
})();
