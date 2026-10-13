/*
 * Блоки и предметы Minecraft для студии персонажа — настоящие модели и текстуры игры.
 *
 * В репозитории их нет: assets/js/mc-index.json (собирает tools/mc-index.mjs) говорит только, где в официальном
 * client.jar с серверов Mojang лежит каждый файл. Браузер скачивает нужные куски jar запросами Range прямо
 * у Mojang (piston-data.mojang.com, разрешён в CSP), распаковывает (DecompressionStream) и держит в памяти;
 * повторно куски берутся из кеша браузера. Сервер сайта сам ничего у Mojang не качает.
 *
 *   McArt.load()               → Promise: оглавление загружено (до этого list/has — пустые)
 *   McArt.has(id) / kind(id)   — есть ли такой блок/предмет; 'item' | 'block' | 'texture' | null
 *   McArt.list()               → { blocks: [id], items: [id] }
 *   McArt.label(id)            — название (английское, из игры; до loadNames() — из id)
 *   McArt.loadNames()          → Promise: названия загружены
 *   McArt.model(id, onReady, textures, flat) → готовая модель или null (тогда грузится, по готовности — onReady()):
 *        { kind: 'block', parts: [{ elements, x, y }], display }
 *        { kind: 'item', layers: [{ tex, tint }], display, handheld }
 *     id 'tex1'…'tex3' — своя картинка игрока (textures[0…2], data:image/png): flat — плоский предмет, иначе куб.
 *   McArt.prepared(tex, tint, shade) — текстура с оттенком и затенением (кешируется)
 *   McArt.icon(id, px, onReady, textures) → <canvas> для палитры (дорисуется сам, когда загрузится)
 */
(function () {
  'use strict';

  // Рядом с этим файлом (страницы сайта лежат в корне, но так работает и из других мест).
  const INDEX_URL = new URL('mc-index.json', (document.currentScript && document.currentScript.src) || location.href).href;
  const CHUNK = 32 * 1024; // куски jar выровнены, чтобы одни и те же запросы попадали в кеш браузера

  let index = null;
  let indexPromise = null;
  const blockIds = new Map(); // id → [{ model, x, y }]
  const itemIds = new Map(); // id → { model, tints }

  function load() {
    if (!indexPromise) {
      indexPromise = fetch(INDEX_URL)
        .then((r) => {
          if (!r.ok) throw new Error('index ' + r.status);
          return r.json();
        })
        .then((ix) => {
          index = ix;
          for (const [id, ...parts] of ix.blocks) blockIds.set(id, parts.map(([m, x = 0, y = 0]) => ({ model: m, x, y })));
          for (const [id, m, tints] of ix.items) itemIds.set(id, { model: m, tints: tints || [] });
          return ix;
        })
        .catch((e) => {
          indexPromise = null;
          throw e;
        });
    }
    return indexPromise;
  }

  const isTex = (id) => /^tex[1-3]$/.test(id);
  const kind = (id) => (isTex(id) ? 'texture' : itemIds.has(id) ? 'item' : blockIds.has(id) ? 'block' : null);

  /* ------------------------------------------------------------ чтение jar кусками */

  const chunks = new Map(); // номер куска → Promise<Uint8Array>
  // Куски храним сами (Cache Storage): обычный кеш браузера с запросами Range иногда отдаёт весь jar (41 МБ) целиком.
  let storePromise = null;
  const store = () => {
    if (!storePromise) storePromise = (typeof caches !== 'undefined' && window.isSecureContext ? caches.open('mc-jar-' + index.version).catch(() => null) : Promise.resolve(null));
    return storePromise;
  };
  const chunkKey = (n) => `${index.jar}?chunk=${n}`;

  function fetchChunks(list) {
    const todo = [...new Set(list)].filter((c) => !chunks.has(c)).sort((a, b) => a - b);
    if (todo.length) {
      const waiting = new Map();
      for (const c of todo) {
        let resolve;
        let reject;
        const promise = new Promise((res, rej) => {
          resolve = res;
          reject = rej;
        });
        promise.catch(() => chunks.delete(c));
        chunks.set(c, promise);
        waiting.set(c, { resolve, reject });
      }
      (async () => {
        const cache = await store();
        // Что уже сохранено — из хранилища.
        const missing = [];
        await Promise.all(
          todo.map(async (c) => {
            const hit = cache && (await cache.match(chunkKey(c)).catch(() => null));
            if (hit) waiting.get(c).resolve(new Uint8Array(await hit.arrayBuffer()));
            else missing.push(c);
          })
        );
        missing.sort((a, b) => a - b);
        // Остальное — у Mojang; соседние куски одним запросом.
        let i = 0;
        while (i < missing.length) {
          let j = i;
          while (j + 1 < missing.length && missing[j + 1] === missing[j] + 1 && j - i < 63) j++;
          const run = missing.slice(i, j + 1);
          const start = run[0] * CHUNK;
          const end = Math.min(index.size, (run[run.length - 1] + 1) * CHUNK) - 1;
          fetch(index.jar, { headers: { Range: `bytes=${start}-${end}` }, cache: 'no-store' })
            .then((r) => {
              if (r.status !== 206) throw new Error('jar ' + r.status);
              return r.arrayBuffer();
            })
            .then((b) => {
              const buf = new Uint8Array(b);
              run.forEach((c, k) => {
                const piece = buf.slice(k * CHUNK, (k + 1) * CHUNK);
                waiting.get(c).resolve(piece);
                if (cache) cache.put(chunkKey(c), new Response(piece)).catch(() => {});
              });
            })
            .catch((e) => run.forEach((c) => waiting.get(c).reject(e)));
          i = j + 1;
        }
      })().catch((e) => todo.forEach((c) => waiting.get(c).reject(e)));
    }
    return Promise.all(list.map((c) => chunks.get(c)));
  }

  async function readBytes(start, length) {
    const first = Math.floor(start / CHUNK);
    const last = Math.floor((start + length - 1) / CHUNK);
    const list = [];
    for (let c = first; c <= last; c++) list.push(c);
    const parts = await fetchChunks(list);
    const out = new Uint8Array(length);
    let at = 0;
    for (let k = 0; k < parts.length && at < length; k++) {
      const offset = k === 0 ? start - first * CHUNK : 0;
      const piece = parts[k].subarray(offset, offset + (length - at));
      out.set(piece, at);
      at += piece.length;
    }
    return out;
  }

  function entry(name) {
    const slash = name.lastIndexOf('/');
    const folder = index.files[name.slice(0, slash + 1)];
    const e = folder && folder[name.slice(slash + 1).replace(/\.(json|png)$/, '')];
    return e ? { off: e[0], csize: e[1], method: e[2] === undefined ? 8 : e[2], full: 'assets/minecraft/' + name } : null;
  }

  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  const files = new Map(); // имя → Promise<Uint8Array>
  /** Файл из jar (имя без assets/minecraft/), распакованный. */
  function file(name) {
    if (!files.has(name)) {
      const e = entry(name);
      const p = !e
        ? Promise.reject(new Error('нет файла ' + name))
        : readBytes(e.off, 30 + e.full.length + 64 + e.csize).then(async (head) => {
            const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
            if (view.getUint32(0, true) !== 0x04034b50) throw new Error('jar: не тот кусок');
            const at = e.off + 30 + view.getUint16(26, true) + view.getUint16(28, true);
            const raw = await readBytes(at, e.csize);
            return e.method === 8 ? inflate(raw) : raw;
          });
      p.catch(() => files.delete(name));
      files.set(name, p);
    }
    return files.get(name);
  }

  const jsonFile = (name) => file(name).then((b) => JSON.parse(new TextDecoder().decode(b)));

  /* ------------------------------------------------------------ текстуры */

  const textures = new Map(); // 'block/stone' → Promise<canvas>
  function texture(ref) {
    const key = String(ref).replace(/^minecraft:/, '');
    if (!textures.has(key)) {
      const p = file(`textures/${key}.png`)
        .then((bytes) => createImageBitmap(new Blob([bytes], { type: 'image/png' })))
        .then((bmp) => {
          // У анимированных текстур кадры идут столбиком — берём первый.
          const c = document.createElement('canvas');
          c.width = bmp.width;
          c.height = Math.min(bmp.height, bmp.width);
          c.getContext('2d').drawImage(bmp, 0, 0);
          return c;
        });
      p.catch(() => textures.delete(key));
      textures.set(key, p);
    }
    return textures.get(key);
  }

  /** Своя картинка игрока: data:image/png → canvas 16×16 (без сглаживания). */
  const customs = new Map();
  function custom(url) {
    if (!customs.has(url)) {
      customs.set(
        url,
        new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = () => {
            const c = document.createElement('canvas');
            c.width = 16;
            c.height = 16;
            const g = c.getContext('2d');
            g.imageSmoothingEnabled = false;
            g.drawImage(img, 0, 0, 16, 16);
            resolve(c);
          };
          img.onerror = () => reject(new Error('картинка'));
          img.src = url;
        })
      );
      if (customs.size > 60) customs.delete(customs.keys().next().value);
    }
    return customs.get(url);
  }

  const tintCache = new WeakMap();
  /** Текстура с оттенком (как трава и листва в игре) и затенением грани (1 — без него). */
  function prepared(tex, tint, shade = 1) {
    if (!tex || (!tint && shade >= 0.999)) return tex;
    let m = tintCache.get(tex);
    if (!m) tintCache.set(tex, (m = new Map()));
    const key = (tint || '') + '|' + Math.round(shade * 100);
    if (!m.has(key)) {
      const c = document.createElement('canvas');
      c.width = tex.width;
      c.height = tex.height;
      const g = c.getContext('2d');
      g.drawImage(tex, 0, 0);
      if (tint) {
        g.globalCompositeOperation = 'multiply';
        g.fillStyle = tint;
        g.fillRect(0, 0, c.width, c.height);
        g.globalCompositeOperation = 'destination-in';
        g.drawImage(tex, 0, 0);
      }
      if (shade < 0.999) {
        g.globalCompositeOperation = 'source-atop';
        g.fillStyle = `rgba(0, 0, 0, ${1 - shade})`;
        g.fillRect(0, 0, c.width, c.height);
      }
      m.set(key, c);
    }
    return m.get(key);
  }

  /* ------------------------------------------------------------ модели */

  const modelJson = (m) => jsonFile(`models/${m}.json`);

  /** Цепочка [модель, родитель, …]: родители известны из оглавления, поэтому все файлы грузятся разом. */
  function chainOf(m) {
    const out = [];
    for (let x = m; x && !out.includes(x); x = index.parents[x]) out.push(x);
    return out;
  }

  /** Слить цепочку: текстуры и display — дочерние поверх родительских, elements — ближайшие. */
  async function resolveModel(m) {
    const list = chainOf(m);
    const jsons = await Promise.all(list.map((x) => modelJson(x).catch(() => ({}))));
    const out = { textures: {}, display: {}, elements: null, handheld: list.some((x) => x.startsWith('item/handheld')) };
    for (let i = jsons.length - 1; i >= 0; i--) {
      Object.assign(out.textures, jsons[i].textures || {});
      Object.assign(out.display, jsons[i].display || {});
    }
    for (const j of jsons) {
      if (Array.isArray(j.elements)) {
        out.elements = j.elements;
        break;
      }
    }
    return out;
  }

  /** '#side' → 'block/oak_log' по таблице текстур модели (в новых версиях там бывает { sprite, force_translucent }). */
  function texRef(map, ref) {
    const name = (v) => (v && typeof v === 'object' ? v.sprite : v);
    let r = name(ref);
    for (let k = 0; k < 8 && typeof r === 'string' && r.startsWith('#'); k++) r = name(map[r.slice(1)]);
    return typeof r === 'string' ? r.replace(/^minecraft:/, '') : null;
  }

  // Оттенки «из биома» — как на равнине.
  function biomeTint(id) {
    if (/birch_leaves/.test(id)) return '#80a755';
    if (/spruce_leaves/.test(id)) return '#619961';
    if (/leaves|vine/.test(id)) return '#77ab2f';
    if (/lily_pad/.test(id)) return '#208030';
    if (/water/.test(id)) return '#3f76e4';
    if (/stem/.test(id)) return '#8fb32f';
    return '#91bd59';
  }

  const FACE_DIRS = ['north', 'south', 'west', 'east', 'up', 'down'];
  /** uv грани по умолчанию — как считает игра (0…16 по текстуре). */
  function defaultUv(dir, f, t) {
    switch (dir) {
      case 'down':
        return [f[0], 16 - t[2], t[0], 16 - f[2]];
      case 'up':
        return [f[0], f[2], t[0], t[2]];
      case 'north':
        return [16 - t[0], 16 - t[1], 16 - f[0], 16 - f[1]];
      case 'south':
        return [f[0], 16 - t[1], t[0], 16 - f[1]];
      case 'west':
        return [f[2], 16 - t[1], t[2], 16 - f[1]];
      default:
        return [16 - t[2], 16 - t[1], 16 - f[2], 16 - f[1]];
    }
  }

  async function buildBlock(id) {
    const parts = blockIds.get(id);
    const special = parts[0].model[0] === '@' ? parts[0].model.slice(1) : null; // вода, лава
    const tint = biomeTint(id);
    const built = await Promise.all(
      parts.map(async (p) => {
        const r = await resolveModel(special ? 'block/cube_all' : p.model);
        if (special) r.textures = { ...r.textures, all: `block/${special}_still` };
        const refs = new Set();
        for (const e of r.elements || []) for (const f of Object.values(e.faces || {})) refs.add(texRef(r.textures, f.texture));
        refs.delete(null);
        const loaded = new Map();
        await Promise.all([...refs].map((ref) => texture(ref).then((c) => loaded.set(ref, c), (e) => console.warn('McArt:', ref, e && e.message))));
        const elements = (r.elements || []).map((e) => ({
          from: e.from,
          to: e.to,
          rotation: e.rotation || null,
          shade: e.shade !== false,
          faces: FACE_DIRS.filter((d) => e.faces && e.faces[d]).map((d) => {
            const f = e.faces[d];
            const tinted = special === 'water' || (f.tintindex !== undefined && f.tintindex !== -1);
            return { dir: d, tex: loaded.get(texRef(r.textures, f.texture)) || null, uv: f.uv || defaultUv(d, e.from, e.to), rotation: f.rotation || 0, tint: tinted ? tint : null };
          }),
        }));
        return { elements, x: p.x, y: p.y, display: r.display };
      })
    );
    return { kind: 'block', parts: built.map(({ elements, x, y }) => ({ elements, x, y })), display: built[0].display };
  }

  async function buildItem(id) {
    const it = itemIds.get(id);
    const r = await resolveModel(it.model);
    const layers = [];
    for (let i = 0; i < 8; i++) {
      const ref = texRef(r.textures, `#layer${i}`);
      if (!ref) break;
      const tex = await texture(ref).catch(() => null);
      if (tex) layers.push({ tex, tint: it.tints[i] || null });
    }
    if (!layers.length) throw new Error('нет текстуры ' + id);
    return { kind: 'item', layers, display: r.display, handheld: r.handheld };
  }

  // Своя картинка: плоский предмет или куб (display — как у обычного предмета/блока).
  async function buildCustom(id, list, flat) {
    const url = list && list[Number(id.slice(3)) - 1];
    if (!url) throw new Error('нет картинки');
    const tex = await custom(url);
    if (flat) {
      const base = await resolveModel('item/generated');
      return { kind: 'item', layers: [{ tex, tint: null }], display: base.display, handheld: false };
    }
    const base = await resolveModel('block/cube_all');
    const faces = FACE_DIRS.map((d) => ({ dir: d, tex, uv: [0, 0, 16, 16], rotation: 0, tint: null }));
    return { kind: 'block', parts: [{ elements: [{ from: [0, 0, 0], to: [16, 16, 16], rotation: null, shade: true, faces }], x: 0, y: 0 }], display: base.display };
  }

  const models = new Map(); // ключ → { value, promise, waiting }
  /**
   * Готовая модель или null (начнёт грузить и вызовет onReady). Не загрузилась (нет сети, Mojang недоступен) —
   * так и останется null, без повторов до перезагрузки страницы.
   */
  function model(id, onReady, list, flat) {
    const key = isTex(id) ? `${id}|${flat ? 1 : 0}|${list && list[Number(id.slice(3)) - 1]}` : id;
    let m = models.get(key);
    if (!m) {
      m = { value: null, waiting: [] };
      models.set(key, m);
      m.promise = load()
        .then(() => (isTex(id) ? buildCustom(id, list, flat) : itemIds.has(id) ? buildItem(id) : blockIds.has(id) ? buildBlock(id) : Promise.reject(new Error('нет ' + id))))
        .then((v) => {
          m.value = v;
          m.waiting.splice(0).forEach((f) => f());
        })
        .catch((e) => {
          m.waiting.length = 0;
          console.warn('McArt:', id, e && e.message);
        });
    }
    if (!m.value && onReady && !m.waiting.includes(onReady)) m.waiting.push(onReady);
    return m.value;
  }

  /* ------------------------------------------------------------ названия */

  let names = null;
  let namesPromise = null;
  function loadNames() {
    if (!namesPromise) {
      namesPromise = load()
        .then(() => jsonFile('lang/en_us.json'))
        .then((j) => {
          names = j;
        })
        .catch(() => {
          namesPromise = null;
        });
    }
    return namesPromise;
  }
  function label(id) {
    if (names) {
      const v = names[`item.minecraft.${id}`] || names[`block.minecraft.${id}`];
      if (v) return v;
    }
    return id.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
  }

  /* ------------------------------------------------------------ значок для палитры */

  /** Значок: предмет — плоско, блок — кубиком в изометрии (рисует Skin3D.drawIcon). */
  function icon(id, px = 32, onReady, list) {
    const c = document.createElement('canvas');
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    c.width = Math.round(px * dpr);
    c.height = Math.round(px * dpr);
    c.className = 'mc-icon';
    const paint = () => {
      const m = model(id, paint, list, false);
      if (!m) return;
      const g = c.getContext('2d');
      g.clearRect(0, 0, c.width, c.height);
      g.imageSmoothingEnabled = false;
      if (m.kind === 'item') {
        for (const l of m.layers) g.drawImage(prepared(l.tex, l.tint), 0, 0, l.tex.width, l.tex.width, 0, 0, c.width, c.height);
      } else if (window.Skin3D && window.Skin3D.drawIcon) {
        window.Skin3D.drawIcon(c, m);
      }
      if (onReady) onReady();
    };
    paint();
    return c;
  }

  window.McArt = {
    load,
    loadNames,
    has: (id) => kind(id) !== null,
    kind,
    list: () => ({ blocks: [...blockIds.keys()], items: [...itemIds.keys()] }),
    label,
    model,
    prepared,
    icon,
    get ready() {
      return !!index;
    },
  };
})();
