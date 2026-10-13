/*
 * Скин Minecraft в 3D на <canvas>, без библиотек. Проекция ортогональная, поэтому каждая грань коробки —
 * параллелограмм, и её можно нарисовать одним drawImage с аффинным преобразованием. Пиксели не размываются
 * (imageSmoothingEnabled = false). Позы — повороты рук, ног и головы вокруг суставов.
 *
 *   Skin3D.load(url)                     → Promise<canvas 64×64> (старые скины 64×32 достраиваются)
 *   Skin3D.draw(canvas, skin, opts)      — один кадр: { slim, pose, angles, zoom, yaw, pitch, time }
 *   Skin3D.viewer({ url, slim, pose, look, label, rotate }) → { el, set({url, slim, pose, look}), destroy() } — крутится мышью/пальцем/стрелками
 *                                        (rotate: false — не крутится, стоит, как задано в look)
 *   Skin3D.figure({ url, slim, pose, look }) → <canvas> с методом update(look) — неподвижная картинка для карточки
 *   Skin3D.poser({ url, slim, look, part, yaw, pitch, zoom, scene, snap, target, onSelect, onStart, onChange, onEnd, onTap })
 *                                        → { el, set({look, part, tool, camera}), resetCamera(), zoomBy(k), destroy() }
 *                                        — редактор позы как в Blockbench: нажать на часть тела, тянуть цветные кольца;
 *                                          scene: true — вся сцена студии: предметы, блоки, приближение, сдвиг кадра
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

  /** look → настройки draw(): поза, свои углы, размер, поворот, сдвиг, предметы, блоки (yaw — поворот камеры по умолчанию для этого вида). */
  function lookOpts(look, yaw) {
    const l = look || {};
    return {
      pose: l.pose === 'custom' && l.angles ? 'custom' : l.pose,
      angles: l.pose === 'custom' ? l.angles : null,
      zoom: typeof l.scale === 'number' ? l.scale : 1,
      yaw: yaw + (Number(l.turn) || 0),
      offset: l.offset || null,
      held: l.held || null,
      blocks: l.blocks || null,
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

  const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
  const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
  const mul = (a, k) => [a[0] * k, a[1] * k, a[2] * k];
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
  const norm = (a) => mul(a, 1 / (Math.hypot(a[0], a[1], a[2]) || 1));

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

  const det3 = (a, b, c) => a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0]);

  /**
   * Грани модели игры для отрисовки. xf — точка модели (0…16) → координаты вида; toScreen — вид → холст.
   * Возвращает { depth, paint(g, hits, key) } — по глубине модель встаёт среди частей тела.
   */
  function modelDrawable(m, xf, toScreen) {
    const o = xf([0, 0, 0]);
    const flip = det3(sub(xf([1, 0, 0]), o), sub(xf([0, 1, 0]), o), sub(xf([0, 0, 1]), o)) < 0;
    const faces = [];
    if (m.kind === 'block') {
      for (const part of m.parts) {
        for (const el of part.elements) {
          for (const f of el.faces) {
            if (!f.tex) continue;
            const [a, U, V] = FACE_GEO[f.dir](el.from, el.to);
            const place = (p) => {
              let q = elementPoint(el.rotation, p);
              if (part.x || part.y) q = add(rotate(sub(q, [8, 8, 8]), [-part.x, -part.y, 0]), [8, 8, 8]);
              return xf(q);
            };
            const G = [a, add(a, U), add(add(a, U), V), add(a, V)].map(place);
            const du = sub(G[1], G[0]);
            const dv = sub(G[3], G[0]);
            const nz = (dv[0] * du[1] - dv[1] * du[0]) * (flip ? -1 : 1);
            if (nz <= 1e-6) continue;
            faces.push({ G, tex: f.tex, uv: f.uv, rotation: f.rotation, tint: f.tint, shade: el.shade ? FACE_SHADE[f.dir] : 1, depth: (G[0][2] + G[2][2]) / 2 });
          }
        }
      }
    } else {
      // Плоский предмет: картинка с толщиной в 1 пиксель — несколько слоёв, внутренние темнее.
      const thick = Math.hypot(...sub(xf([8, 8, 8.5]), xf([8, 8, 7.5]))) * (toScreen.scale || 1);
      const n = Math.max(2, Math.min(10, Math.round(thick) + 1));
      for (let k = 0; k < n; k++) {
        const z = 7.5 + k / (n - 1);
        const G = [[0, 16, z], [16, 16, z], [16, 0, z], [0, 0, z]].map(xf);
        for (const l of m.layers) faces.push({ G, tex: l.tex, uv: [0, 0, 16, 16], rotation: 0, tint: l.tint, shade: 1, depth: (G[0][2] + G[2][2]) / 2, layer: true });
      }
      faces.sort((a, b) => a.depth - b.depth);
      const top = faces.length ? faces[faces.length - 1].depth : 0;
      for (const f of faces) if (f.depth < top - 1e-6) f.shade = 0.55;
    }
    faces.sort((a, b) => a.depth - b.depth);
    const center = xf([8, 8, 8]);
    return {
      depth: center[2],
      paint(g, hits, key) {
        for (const f of faces) {
          const tw = f.tex.width / 16;
          const [u1, v1, u2, v2] = f.uv;
          if (u1 === u2 || v1 === v2) continue;
          const r = ((Math.round((f.rotation || 0) / 90) % 4) + 4) % 4;
          const S = f.G.map(toScreen);
          const tl = S[r % 4];
          const tr = S[(1 + r) % 4];
          const bl = S[(3 + r) % 4];
          const cu = [(tr[0] - tl[0]) / ((u2 - u1) * tw), (tr[1] - tl[1]) / ((u2 - u1) * tw)];
          const cv = [(bl[0] - tl[0]) / ((v2 - v1) * tw), (bl[1] - tl[1]) / ((v2 - v1) * tw)];
          g.setTransform(cu[0], cu[1], cv[0], cv[1], tl[0] - u1 * tw * cu[0] - v1 * tw * cv[0], tl[1] - u1 * tw * cu[1] - v1 * tw * cv[1]);
          const sx = Math.min(u1, u2) * tw;
          const sy = Math.min(v1, v2) * tw;
          const sw = Math.abs(u2 - u1) * tw;
          const sh = Math.abs(v2 - v1) * tw;
          // Чуть шире, чтобы между гранями не просвечивали щели (у плоских предметов — нельзя, видно край).
          const e = f.layer ? 0 : Math.min(0.3, 0.5 / Math.max(1e-6, Math.hypot(cu[0], cu[1])));
          g.drawImage(window.McArt.prepared(f.tex, f.tint, f.shade), sx, sy, sw, sh, sx - e, sy - e, sw + 2 * e, sh + 2 * e);
          if (hits && key) {
            const n = cross(sub(f.G[3], f.G[0]), sub(f.G[1], f.G[0]));
            hits.push({ key, poly: [S[0], S[1], S[2], S[3]], normal: norm(flip ? mul(n, -1) : n) });
          }
        }
      },
    };
  }

  /** Матрица поворота как в игре (display.rotation = XYZ: сначала z, потом y, потом x) — точка → точка. */
  const rotXYZ = ([x, y, z]) => (p) => rotate(rotate(rotate(p, [0, 0, z]), [0, y, 0]), [x, 0, 0]);

  /**
   * Предмет в руке или на голове: цепочка как в игре (ItemInHandLayer / CustomHeadLayer + display модели),
   * плюс свои поворот, размер и сдвиг игрока. Возвращает точку модели (0…16) → точку части тела (до её поворота).
   */
  function heldTransform(slot, m, entry, slim) {
    const left = slot === 'leftHand';
    const ctx = slot === 'head' ? 'head' : left ? 'thirdperson_lefthand' : 'thirdperson_righthand';
    let d = m.display[ctx];
    if (!d && left && m.display.thirdperson_righthand) {
      const r = m.display.thirdperson_righthand;
      d = { rotation: [(r.rotation || [0, 0, 0])[0], -(r.rotation || [0, 0, 0])[1], -(r.rotation || [0, 0, 0])[2]], translation: [-(r.translation || [0, 0, 0])[0], (r.translation || [0, 0, 0])[1], (r.translation || [0, 0, 0])[2]], scale: r.scale };
    }
    d = d || {};
    const t = d.translation || [0, 0, 0];
    const s = (d.scale || [1, 1, 1]).map((k) => k * (entry.size || 1));
    const R = rotXYZ(d.rotation || [0, 0, 0]);
    const user = entry.rot || [0, 0, 0];
    const at = entry.at || [0, 0, 0];
    // Точка модели → система «руки/головы» игры (y вниз, лицо к −z) → наша (y вверх, лицо к +z).
    // fromUser — то же, но для точки уже после своего поворота rot (центр модели — [0, 0, 0]): по ней студия
    // считает оси колец поворота предмета.
    const fromUser = (v) => add(add(t, at), R(v));
    const inDisplay = (p) => fromUser(rotate([(p[0] - 8) * s[0], (p[1] - 8) * s[1], (p[2] - 8) * s[2]], user));
    let place;
    if (slot === 'head') {
      place = (q) => {
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

  /* ------------------------------------------------------------ рисование */

  const ATTACHED = new Set(['head', 'rightArm', 'leftArm']);
  // Где голова и руки крепятся к телу: тело растянули — они остаются на его краях.
  const ATTACH_AT = { head: [0, 24, 0], rightArm: [-4, 22, 0], leftArm: [4, 22, 0] };
  const CENTER_Y = 17; // середина модели по высоте (с поднятыми руками)
  const HEIGHT = 40; // сколько единиц модели помещается по высоте холста
  const WIDTH = 26;
  const BLOCK = 16; // блок Minecraft в единицах модели (персонаж — 32)

  /**
   * Один кадр. canvas — уже нужного размера (в пикселях устройства), skin — 64×64 из load().
   * yaw/pitch — поворот камеры в градусах, pose — ключ позы ('custom' — углы из angles), time — секунды анимации (null — без анимации).
   * zoom — размер фигуры: растёт вверх от ног, ноги остаются на месте. offset — [x, y] сдвиг всей сцены в кадре.
   * held — { rightHand, leftHand, head: { id, rot, size, at } }, blocks — [{ id, at, rot, size }], textures — свои картинки
   * (см. Api.LOOK); пока модели грузятся у Mojang, их нет, по готовности вызывается onModel() — перерисовать.
   * hits — массив: в него попадут нарисованные грани { key, poly, normal } (для выбора мышью), в порядке рисования;
   * key — часть тела, 'held:rightHand' или 'block:3'.
   * Камера редактора (студия): viewZoom — приближение всего кадра, pan — [x, y] сдвиг в пикселях холста,
   * floor — сетка блоков на полу.
   * Возвращает, как сцена легла на холст (для колец редактора), или null без скина.
   */
  /**
   * Грань скина отдельной картинкой с рамкой в 1 точку из её же крайних пикселей. Браузер при повороте и масштабе
   * берёт пиксели чуть за краем прямоугольника — из соседнего места скина, отсюда тёмные полосы по краям частей.
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

  function draw(canvas, skin, opts = {}) {
    const g = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    if (!skin) return null;
    g.imageSmoothingEnabled = false;
    const fitScale = Math.min(W / WIDTH, H / HEIGHT) * (opts.viewZoom || 1);
    const zoom = opts.zoom || 1;
    const scale = fitScale * zoom;
    const offset = Array.isArray(opts.offset) ? opts.offset : [0, 0];
    const pan = Array.isArray(opts.pan) ? opts.pan : [0, 0];
    const cx = W / 2 + pan[0] + (Number(offset[0]) || 0) * fitScale;
    const cy = H / 2 + pan[1] + (opts.shiftY || 0) * scale + CENTER_Y * fitScale * (1 - zoom) - (Number(offset[1]) || 0) * fitScale;
    const yaw = opts.yaw === undefined ? 25 : opts.yaw;
    const pitch = opts.pitch === undefined ? 10 : opts.pitch;
    const angles = opts.pose === 'custom' && opts.angles ? customPose(opts.angles) : pose(POSE_KEYS.includes(opts.pose) ? opts.pose : 'stand', opts.time);

    // Часть тела → мир: поворот вокруг сустава, крепление к телу, подъём (сидит). Мир → вид: камера.
    // Голова и руки крепятся к телу: наклонили тело — они наклоняются вместе с ним (ноги — нет).
    const BODY_PIVOT = [0, 12, 0];
    const bodyTurned = angles.body.some((x) => x);
    const parts = model(opts.slim);
    const byKey = Object.fromEntries(parts.map((p) => [p.key, p]));
    // Растяжение части вдоль её осей: в длину — от сустава (рука остаётся у плеча), вширь и вглубь — от середины коробки.
    // Ноги длиннее или короче — вся фигура выше или ниже, ступни на полу. d — точка относительно сустава.
    const stretchOf = (key) => (angles.stretch && angles.stretch[key]) || null;
    const scaled = (key, d) => {
      const k = stretchOf(key);
      if (!k) return d;
      const { at, size, pivot } = byKey[key];
      const o = [at[0] + size[0] / 2 - pivot[0], 0, at[2] + size[2] / 2 - pivot[2]];
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
      return local;
    };
    const camera = (d) => rotate(rotate(d, [0, yaw, 0]), [pitch, 0, 0]);
    const view = (w) => camera([w[0], w[1] - CENTER_Y, w[2]]);
    const toView = (part, p) => view(toWorld(part, p));
    const toScreen = (p) => [cx + p[0] * scale, cy - p[1] * scale];
    toScreen.scale = scale;
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
          g.drawImage(faceTile(skin, sx, sy, tw, th), 1, 1, tw, th, -seam, -seam, tw + 2 * seam, th + 2 * seam);
          if (opts.hits) opts.hits.push({ key: part.key, poly: [s0, su, [su[0] + sv[0] - s0[0], su[1] + sv[1] - s0[1]], sv] });
        },
      };
    };

    const queue = parts.map((part) => {
      const [w, h, d] = part.size;
      const [x0, y0, z0] = part.at;
      const box = (grow, [u, v]) => faces(x0 - grow, y0 - grow, z0 - grow, x0 + w + grow, y0 + h + grow, z0 + d + grow, u, v, w, h, d).map((f) => drawFace(f, part));
      const center = toView(part, [x0 + w / 2, y0 + h / 2, z0 + d / 2]);
      const inner = box(0, part.uv);
      const outer = box(part.grow, part.ov);
      return {
        depth: center[2],
        paint() {
          // Изнанка второго слоя, сама часть, второй слой.
          for (const f of outer) if (f.nz < -1e-6) f.paint();
          for (const f of inner) if (f.nz > 1e-6) f.paint();
          for (const f of outer) if (f.nz > 1e-6) f.paint();
        },
      };
    });

    // Предметы в руках и на голове, блоки вокруг.
    const art = window.McArt;
    const heldXf = {};
    if (art) {
      const held = opts.held || {};
      for (const slot of HELD_SLOTS) {
        const entry = held[slot];
        if (!entry || !entry.id) continue;
        const m = art.model(entry.id, opts.onModel, opts.textures, slot !== 'head');
        if (!m) continue;
        const local = heldTransform(slot, m, entry, opts.slim);
        const part = byKey[slot === 'head' ? 'head' : slot === 'leftHand' ? 'leftArm' : 'rightArm'];
        const xf = (p) => view(toWorld(part, local(p), local.anchor));
        heldXf[slot] = { xf, part, local };
        const d = modelDrawable(m, xf, toScreen);
        queue.push({ depth: d.depth + 0.01, paint: () => d.paint(g, opts.hits, 'held:' + slot) });
      }
      (opts.blocks || []).forEach((b, i) => {
        if (!b || !b.id) return;
        const m = art.model(b.id, opts.onModel, opts.textures, false);
        if (!m) return;
        const k = (b.size || 1) * (BLOCK / 16);
        const at = b.at || [0, 0, 0];
        const xf = (p) => view(add(rotate([(p[0] - 8) * k, p[1] * k, (p[2] - 8) * k], [0, b.rot || 0, 0]), at));
        const d = modelDrawable(m, xf, toScreen);
        queue.push({ depth: d.depth, paint: () => d.paint(g, opts.hits, 'block:' + i) });
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

    // Дальнее — первым.
    queue.sort((a, b) => a.depth - b.depth);
    for (const q of queue) q.paint();
    g.setTransform(1, 0, 0, 1, 0, 0);

    // Направление из системы родителя части в вид.
    const fromParent = (key, d) => camera(bodyTurned && ATTACHED.has(key) ? rotate(d, angles.body) : d);
    return {
      scale,
      toScreen,
      camera,
      view,
      /** Сустав части в координатах вида. */
      pivot: (key) => {
        const part = byKey[key];
        return toView(part, part.pivot);
      },
      /** Середина коробки части (вид) — там ручки сдвига и растяжения. */
      center: (key) => {
        const part = byKey[key];
        const [w, h, d] = part.size;
        const [x0, y0, z0] = part.at;
        return toView(part, [x0 + w / 2, y0 + h / 2, z0 + d / 2]);
      },
      /** Свои оси части после поворота (вид): вдоль них растягивается часть. */
      partAxes: (key) => [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((d) => norm(fromParent(key, rotate(d, angles[key])))),
      /** Оси фигуры (вид): вдоль них сдвиг частей (angles.move) и блоков. */
      worldAxes: () => [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((d) => camera(d)),
      /**
       * Оси, вокруг которых поворачивают углы [rx, ry, rz] этой части (как «гимбал» в Blockbench):
       * поворот считается rz → rx → ry, поэтому ось ry — вертикаль родителя, rx — после ry, rz — после rx и ry.
       */
      axes: (key) => {
        const [rx, ry] = angles[key];
        return [rotate([1, 0, 0], [0, ry, 0]), [0, 1, 0], rotate([0, 0, 1], [rx, ry, 0])].map((d) => norm(fromParent(key, d)));
      },
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
        const Q = (q) => view(toWorld(h.part, h.local.place(q), h.local.anchor));
        const base = Q(h.local.base);
        const moveDirs = [[1, 0, 0], [0, 1, 0], [0, 0, 1]].map((e) => sub(Q(add(h.local.base, e)), base));
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
      toWorldDir: (v) => rotate(rotate(v, [-pitch, 0, 0]), [0, -yaw, 0]),
    };
  }

  /** Значок блока для палитры: как в инвентаре игры (display.gui модели). */
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
    modelDrawable(m, xf, toScreen).paint(g);
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
    const BASE_YAW = 25;
    const state = { url: opts.url, slim: !!opts.slim, look: opts.look || { pose: opts.pose || 'stand' }, yaw: BASE_YAW, pitch: 10, skin: null, playing: !reducedMotion() && opts.animate !== false };
    state.yaw = lookOpts(state.look, BASE_YAW).yaw;
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
      draw(canvas, state.skin, { ...lookOpts(state.look, 0), slim: state.slim, yaw: state.yaw, pitch: state.pitch, time: state.playing ? (now - started) / 1000 : null, onModel: redraw });
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
   * Меняет look на месте; onSelect(key) — выбрали другое, onChange(key) — после каждого шага,
   * onStart/onEnd — начало и конец движения (для «Отменить»).
   *
   * scene: true — редактор всей сцены (студия персонажа):
   *   — выбрать можно и предмет ('held:<слот>'), и блок ('block:<i>'); пустое место — снять выбор;
   *   — у предмета кольца его своего поворота rot, у блока — зелёное кольцо поворота, стрелка «выше» и сам блок
   *     тянется по полу (шаг — snap(key), Shift — наоборот: без сетки или по сетке);
   *   — кольца частей есть и у готовой позы: потянули — поза становится своей (углы — с готовой);
   *   — колёсико (и zoomBy) — приближение, правая или средняя кнопка — сдвинуть кадр, на полу сетка блоков;
   *     размер и сдвиг из look — это рамка карточки, здесь они не применяются;
   *   — set({ tool }): 'select' | 'place' | 'break'. В 'place' и 'break' нажатие уходит в onTap({ key, normal, ground }):
   *     key — что под мышью, normal — нормаль грани в мире (у блоков), ground — точка пола под мышью;
   *     target(те же данные) → { at, size, rot } | null — где показать рамку будущего блока.
   */
  function poser(opts = {}) {
    const scene = !!opts.scene;
    let baseYaw = opts.yaw === undefined ? 25 : opts.yaw;
    let basePitch = opts.pitch === undefined ? 10 : opts.pitch;
    // Приближение кадра в начале (сцена студии: чуть дальше — видно блоки вокруг).
    const baseZoom = Math.max(0.25, Math.min(4, Number(opts.zoom) || 1));
    const state = { url: opts.url, slim: !!opts.slim, look: opts.look, part: opts.part || null, yaw: 0, pitch: basePitch, zoom: baseZoom, pan: [0, 0], tool: 'select', mode: opts.mode || 'rotate', skin: null, turn: 0 };
    const canvas = document.createElement('canvas');
    canvas.className = 'skin3d__canvas poser__canvas';
    canvas.tabIndex = 0;
    canvas.setAttribute('role', 'img');
    canvas.setAttribute(
      'aria-label',
      scene
        ? `${opts.label || 'Сцена'}. Нажмите на часть тела, предмет или блок и тяните цветные кольца; стрелки — повернуть камеру, плюс и минус — приблизить.`
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

    const limits = () => (window.Api && window.Api.LOOK && window.Api.LOOK.blocks) || { side: 96, y: [-48, 96] };
    const moveLimit = () => (window.Api && window.Api.LOOK && window.Api.LOOK.move) || 32;
    const shiftOf = (key) => {
      const m = state.look && state.look.angles && state.look.angles.move;
      return (m && Array.isArray(m[key]) && m[key]) || [0, 0, 0];
    };
    const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
    const LOOK = () => (window.Api && window.Api.LOOK) || {};
    const r2 = (v) => Math.round(v * 100) / 100;
    const kindOf = (key) => (!key ? null : PART_KEYS.has(key) ? 'part' : key.startsWith('held:') ? 'held' : key.startsWith('block:') ? 'block' : null);
    const heldOf = (key) => (state.look && state.look.held && state.look.held[key.slice(5)]) || null;
    const blockOf = (key) => (state.look && Array.isArray(state.look.blocks) && state.look.blocks[Number(key.slice(6))]) || null;
    const dprOf = () => canvas.width / (canvas.clientWidth || canvas.width);

    function resetCamera() {
      state.turn = Number(state.look && state.look.turn) || 0;
      state.yaw = baseYaw + state.turn;
      state.pitch = basePitch;
      state.zoom = baseZoom;
      state.pan = [0, 0];
      redraw();
    }

    /** Приближение к точке холста (x, y): она остаётся под мышью. */
    function zoomAt(x, y, z) {
      z = clamp(z, 0.25, 4);
      const k = z / state.zoom;
      const cx = canvas.width / 2;
      const cy = canvas.height / 2;
      state.pan = [x - cx - (x - cx - state.pan[0]) * k, y - cy - (y - cy - state.pan[1]) * k];
      state.zoom = z;
      redraw();
    }

    /**
     * Ручки выбранного на сцене. Режимы (как в Blockbench): 'rotate' — кольца поворота, 'move' — стрелки сдвига
     * по осям и кружок в середине (тянуть в плоскости экрана), 'scale' — кубики растяжения по осям части тела
     * и квадрат в середине (всё сразу; у предметов и блоков — только он: размер у них один).
     * Ручка: { id, kind: 'axis' | 'stretch' | 'uniform' | 'free', value(), set(v, free) } + где она на холсте.
     */
    function buildGizmo() {
      if (!info || !state.part || state.tool !== 'select') return null;
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
      if (kind === 'part') {
        if (look.pose !== 'custom' && !scene) return null;
        c = info.pivot(state.part);
        axes = info.axes(state.part).map((A, i) => ({ i, A }));
      } else if (kind === 'held') {
        const e = heldOf(state.part);
        const held = e && info.held(state.part.slice(5), e.rot || [0, 0, 0]);
        if (!held) return null;
        c = held.center;
        axes = held.axes.map((A, i) => ({ i, A }));
      } else if (kind === 'block') {
        const b = blockOf(state.part);
        if (!b) return null;
        const size = (b.size || 1) * (BLOCK / 16);
        c = info.view(add(b.at, [0, 8 * size, 0]));
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
      if (kind === 'part' && state.part === 'body') {
        // «Присесть» — стрелка у правого края на высоте пояса: на самой фигуре она закрывала бы ноги.
        const down = info.camera([0, -1, 0]);
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
      if (kind === 'part') return info.center(state.part);
      if (kind === 'held') {
        const e = heldOf(state.part);
        const held = e && info.held(state.part.slice(5), e.rot || [0, 0, 0]);
        return held ? held.center : null;
      }
      if (kind === 'block') {
        const b = blockOf(state.part);
        return b ? info.view(add(b.at, [0, 8 * (b.size || 1) * (BLOCK / 16), 0])) : null;
      }
      return null;
    }

    function moveGizmo(kind) {
      const c = centerOf(kind);
      if (!c) return null;
      const dpr = dprOf();
      const cs = info.toScreen(c);
      let dirs = info.worldAxes();
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
      // Блок и так тянется по полу, если взять его самого.
      const center = kind === 'part' ? { id: 'free', kind: 'free', at: cs, value: moveGet, set: (m, free) => moveSet(m, free) } : null;
      return { kind, mode: 'move', c, cs, px: len, dpr, rings: [], arrows, center };
    }

    function scaleGizmo(kind) {
      const c = centerOf(kind);
      if (!c) return null;
      const dpr = dprOf();
      const cs = info.toScreen(c);
      const len = handleLen(0.85);
      const arrows =
        kind === 'part'
          ? axisHandles(cs, info.partAxes(state.part), len, (i) => ({
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
      const center = { id: 'uniform', kind: 'uniform', at: cs, value: kind === 'part' ? stretchGet : sizeGet, set: kind === 'part' ? stretchSet : sizeSet };
      return { kind, mode: 'scale', c, cs, px: len, dpr, rings: [], arrows, center };
    }

    // Сдвиг: части тела — angles.move, предмета и блока — at (блока — по сетке). only — какую ось округлять.
    function moveGet() {
      const kind = kindOf(state.part);
      if (kind === 'part') return shiftOf(state.part).slice();
      if (kind === 'held') return (heldOf(state.part).at || [0, 0, 0]).slice();
      return blockOf(state.part).at.slice();
    }
    function moveSet(v, free, only) {
      const kind = kindOf(state.part);
      const snap = (x, i, step, lo, hi) => (only === undefined || only === i ? clamp(Math.round(x / step) * step, lo, hi) : x);
      if (kind === 'part') {
        const M = moveLimit();
        const a = state.look.angles;
        a.move = a.move || {};
        a.move[state.part] = v.map((x, i) => snap(x, i, free ? 1 : 0.5, -M, M));
      } else if (kind === 'held') {
        const M = (LOOK().held && LOOK().held.at) || 16;
        heldOf(state.part).at = v.map((x, i) => snap(x, i, free ? 1 : 0.5, -M, M));
      } else {
        const L = limits();
        const step = snapStep(state.part, free);
        blockOf(state.part).at = v.map((x, i) => (i === 1 ? snap(x, i, step, L.y[0], L.y[1]) : snap(x, i, step, -L.side, L.side)));
      }
    }
    // Растяжение части тела: angles.stretch[часть] = [x, y, z]; у предмета и блока — один размер.
    function stretchGet() {
      const k = state.look.angles && state.look.angles.stretch && state.look.angles.stretch[state.part];
      return k ? k.slice() : [1, 1, 1];
    }
    function stretchSet(v, free) {
      const [lo, hi] = LOOK().stretch || [0.25, 3];
      const step = free ? 0.25 : 0.05;
      const a = state.look.angles;
      a.stretch = a.stretch || {};
      a.stretch[state.part] = v.map((x) => r2(clamp(Math.round(x / step) * step, lo, hi)));
    }
    function sizeGet() {
      return (kindOf(state.part) === 'held' ? heldOf(state.part).size : blockOf(state.part).size) || 1;
    }
    function sizeSet(v, free) {
      const held = kindOf(state.part) === 'held';
      const [lo, hi] = held ? (LOOK().held && LOOK().held.size) || [0.5, 2] : (LOOK().blocks && LOOK().blocks.size) || [0.25, 2];
      const step = free ? 0.25 : 0.05;
      const x = r2(clamp(Math.round(v / step) * step, lo, hi));
      if (held) heldOf(state.part).size = x;
      else blockOf(state.part).size = x;
    }

    // Значения, которые крутят кольца и тянет стрелка, — у части тела, предмета или блока.
    function ringValue(i) {
      const kind = kindOf(state.part);
      if (kind === 'part') return state.look.angles[state.part][i];
      if (kind === 'held') return (heldOf(state.part).rot || [0, 0, 0])[i];
      return blockOf(state.part).rot || 0;
    }
    function setRing(i, v) {
      const kind = kindOf(state.part);
      if (kind === 'part') state.look.angles[state.part][i] = v;
      else if (kind === 'held') {
        const e = heldOf(state.part);
        e.rot = (e.rot || [0, 0, 0]).slice();
        e.rot[i] = v;
      } else blockOf(state.part).rot = v;
    }
    const arrowValue = () => (kindOf(state.part) === 'block' ? blockOf(state.part).at[1] : state.look.angles.lift || 0);
    function setArrow(v, free) {
      if (kindOf(state.part) === 'block') {
        const b = blockOf(state.part);
        const step = snapStep(state.part, free);
        b.at = [b.at[0], clamp(Math.round(v / step) * step, limits().y[0], limits().y[1]), b.at[2]];
      } else {
        state.look.angles.lift = clamp(Math.round(v), -12, 0);
      }
    }
    /** Шаг сетки для блока; Shift (inverse) — наоборот. */
    function snapStep(key, inverse) {
      const step = opts.snap ? opts.snap(key) : 1;
      if (!inverse) return step;
      const b = blockOf(key);
      return step > 1 ? 1 : 16 * ((b && b.size) || 1);
    }

    function paintBox(g, box, dpr) {
      const s = (box.size || 1) * (BLOCK / 16);
      const corner = (sx, y, sz) => info.toScreen(info.view(add(rotate([sx * 8 * s, y, sz * 8 * s], [0, box.rot || 0, 0]), box.at)));
      const lo = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => corner(a, 0, b));
      const hi = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => corner(a, 16 * s, b));
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

    function paintOverlay() {
      const g = canvas.getContext('2d');
      const dpr = dprOf();
      g.save();
      g.lineCap = 'round';
      g.lineJoin = 'round';
      const outline = (key, stroke, fill) => {
        g.strokeStyle = stroke;
        g.lineWidth = 1.25 * dpr;
        if (fill) g.fillStyle = fill;
        for (const hit of hits) {
          if (hit.key !== key) continue;
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
      // Поворот фигуры (look.turn) поменяли — ползунком или прямо в look: фигура поворачивается, камера остаётся.
      const turn = Number(state.look && state.look.turn) || 0;
      if (turn !== state.turn) {
        state.yaw += turn - state.turn;
        state.turn = turn;
      }
      const look = lookOpts(state.look, 0);
      // В студии рамка карточки (размер и сдвиг фигуры) не нужна: камера своя — приближение, сдвиг и сетка на полу.
      const camera = scene ? { zoom: 1, offset: null, viewZoom: state.zoom, pan: state.pan, floor: true } : {};
      hits = [];
      info = draw(canvas, state.skin, { ...look, ...camera, slim: state.slim, yaw: state.yaw, pitch: state.pitch, time: null, hits, onModel: redraw });
      gizmo = buildGizmo();
      if (info) paintOverlay();
    };
    const redraw = () => {
      if (!frame) frame = requestAnimationFrame(render);
    };

    /** Что под точкой холста: кольцо (0, 1, 2), ручка { target, handle }, часть тела (в сцене — и предмет, блок) { part } или null. */
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
      for (let k = hits.length - 1; k >= 0; k--) {
        if (!inPoly(hits[k].poly, x, y)) continue;
        // Предметы и блоки закрывают тело; выбрать их можно только в редакторе сцены (студии).
        return PART_KEYS.has(hits[k].key) || scene ? { part: hits[k].key } : null;
      }
      return null;
    }

    /** Для инструментов «ставить»/«ломать»: что под мышью, нормаль грани (в мире), точка пола. */
    function under(x, y) {
      let top = null;
      for (let k = hits.length - 1; k >= 0; k--) {
        if (inPoly(hits[k].poly, x, y)) {
          top = hits[k];
          break;
        }
      }
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
      if (kindOf(state.part) === 'part' && state.look.pose !== 'custom') {
        state.look.angles = poseAngles(state.look.pose);
        state.look.pose = 'custom';
      }
    }

    canvas.addEventListener('pointerdown', (e) => {
      const [x, y] = pointer(e);
      if (scene && (e.button === 1 || e.button === 2)) {
        e.preventDefault();
        try {
          canvas.setPointerCapture(e.pointerId);
        } catch {
          // указатель уже отпущен
        }
        drag = { target: 'pan', x, y, pan: state.pan.slice() };
        return;
      }
      if (e.button !== undefined && e.button !== 0) return;
      const hit = state.tool === 'select' ? pick(x, y) : null;
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // указатель уже отпущен — тянуть всё равно можно, пока он над холстом
      }
      if (state.tool !== 'select') {
        // «Ставить» и «Ломать»: нажатие без движения — действие, с движением — повернуть камеру.
        drag = { target: 'camera', x, y, yaw: state.yaw, pitch: state.pitch, moved: false, tap: true };
        return;
      }
      const angles = state.look && state.look.angles;
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
      } else if (scene && state.mode === 'move' && hit && hit.part && hit.part === state.part && kindOf(hit.part) === 'part' && info) {
        // «Двигать»: уже выбранную часть тела тянем — она сдвигается в плоскости экрана.
        drag = { target: 'free', handle: { kind: 'free', value: moveGet, set: (m, free) => moveSet(m, free) }, x, y, from: null, started: false };
      } else if (scene && hit && kindOf(hit.part) === 'block' && info) {
        // Блок: выбрать и сразу тянуть по полу (на его высоте).
        const b = blockOf(hit.part);
        select(hit.part);
        drag = { target: 'move', key: hit.part, x, y, from: b.at.slice(), start: info.unproject(x, y, b.at[1]), moved: false };
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
        if (state.tool !== 'select') {
          const u = under(x, y);
          const next = state.tool === 'place' ? (opts.target ? opts.target(u) : null) : kindOf(u.key) === 'block' ? u.key : null;
          canvas.style.cursor = next ? 'crosshair' : '';
          if (JSON.stringify(next) !== JSON.stringify(aim)) {
            aim = next;
            redraw();
          }
          return;
        }
        const hit = pick(x, y);
        const next = hit ? (hit.target !== undefined ? hit.target : 'part') : null;
        canvas.style.cursor = next === null ? '' : next === 'part' ? (scene && state.mode === 'move' && hit.part === state.part && kindOf(hit.part) === 'part' ? 'move' : 'pointer') : 'grab';
        if (next !== hover) {
          hover = next;
          redraw();
        }
        return;
      }
      const dpr = dprOf();
      if (drag.target === 'pan') {
        state.pan = [drag.pan[0] + x - drag.x, drag.pan[1] + y - drag.y];
        redraw();
        return;
      }
      if (drag.target === 'camera') {
        if (Math.hypot(x - drag.x, y - drag.y) > 4 * dpr) drag.moved = true;
        state.yaw = drag.yaw + ((x - drag.x) / dpr) * 0.7;
        state.pitch = Math.max(-30, Math.min(45, drag.pitch + ((y - drag.y) / dpr) * 0.4));
        redraw();
        return;
      }
      if (drag.target === 'move') {
        if (!drag.moved) {
          if (Math.hypot(x - drag.x, y - drag.y) < 4 * dpr) return;
          drag.moved = true;
          if (opts.onStart) opts.onStart(drag.key);
        }
        const b = blockOf(drag.key);
        const p = info && info.unproject(x, y, drag.from[1]);
        if (!b || !p || !drag.start) return;
        const step = snapStep(drag.key, e.shiftKey);
        const S = limits().side;
        const snap = (v) => clamp(Math.round(v / step) * step, -S, S);
        b.at = [snap(drag.from[0] + p[0] - drag.start[0]), drag.from[1], snap(drag.from[2] + p[2] - drag.start[2])];
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
          const d = info.toWorldDir([dx / info.scale, -dy / info.scale, 0]);
          hd.set(drag.from.map((v, i) => v + d[i]), e.shiftKey);
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
      if (was.target === 'camera') {
        if (!was.moved && was.tap) {
          aim = null;
          if (opts.onTap) opts.onTap(under(was.x, was.y));
        } else if (!was.moved && (was.part || scene) && was.part !== state.part) {
          select(was.part || null);
        }
      } else if (was.target === 'move') {
        if (was.moved && opts.onEnd) opts.onEnd(was.key);
      } else if (!was.started) {
        const under = hitAt(was.x, was.y);
        if (under && under.part !== state.part) select(under.part);
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
          zoomAt(x, y, state.zoom * Math.exp(-dy * 0.0015));
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
      state.yaw += step[0];
      state.pitch = Math.max(-30, Math.min(45, state.pitch + step[1]));
      redraw();
    });

    /** Приблизить (k > 1) или отдалить к центру кадра. */
    function zoomBy(k) {
      zoomAt(canvas.width / 2, canvas.height / 2, state.zoom * k);
    }

    function set(next = {}) {
      if (next.camera) {
        // Другой вид — камера встаёт, как в нём (поворот фигуры look.turn — тоже).
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
      get part() {
        return state.part;
      },
      get zoom() {
        return state.zoom;
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
    const paint = () => skin && draw(canvas, skin, { slim, pitch: 8, viewZoom, ...lookOpts(current, 28), onModel: paint });
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

  window.Skin3D = { POSES, PARTS, AXIS_COLORS, load, draw, drawIcon, viewer, poser, figure, poseAngles, lookOpts, guessSlim, fit };
})();
