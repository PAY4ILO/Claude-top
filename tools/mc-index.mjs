/*
 * Оглавление блоков и предметов Minecraft для студии персонажа → assets/js/mc-index.json.
 *
 *   node tools/mc-index.mjs [версия]      (по умолчанию 26.3)
 *
 * Читает официальный client.jar с серверов Mojang кусками (Range): сначала оглавление архива, потом JSON-файлы
 * состояний блоков, предметов и моделей. Картинки и модели в репозиторий НЕ попадают — только где они лежат в jar
 * (смещение и размер) и какие модели нужны каждому блоку и предмету. Браузер потом сам берёт нужные куски
 * у Mojang (assets/js/mc-art.js). Запускать на машине разработчика, не на сервере сайта.
 *
 *   MC_JAR=путь/к/client.jar node tools/mc-index.mjs   — читать уже скачанный jar (той же версии), а не кусками из сети
 */
import { openSync, readSync, fstatSync, writeFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';

const VERSION = process.argv[2] || '26.3';
const OUT = new URL('../assets/js/mc-index.json', import.meta.url);

// Головы и мобы студии (assets/js/mc-mobs.js): их текстуры не упомянуты в моделях, поэтому перечислены здесь.
const EXTRA_FILES = [
  'models/item/template_skull.json',
  'models/item/dragon_head.json',
  ...[
    'zombie/zombie', 'zombie/husk', 'zombie/drowned', 'zombie/drowned_outer_layer',
    'skeleton/skeleton', 'skeleton/stray', 'skeleton/stray_overlay', 'skeleton/wither_skeleton', 'skeleton/bogged', 'skeleton/bogged_overlay',
    'creeper/creeper', 'piglin/piglin', 'piglin/zombified_piglin', 'piglin/piglin_brute', 'enderdragon/dragon', 'enderman/enderman',
    'pig/pig_temperate', 'cow/cow_temperate', 'sheep/sheep', 'sheep/sheep_wool', 'chicken/chicken_temperate',
    'villager/villager', 'villager/type/plains', 'witch/witch', 'iron_golem/iron_golem', 'snow_golem/snow_golem',
    'wolf/wolf', 'spider/spider', 'spider/cave_spider', 'slime/slime', 'slime/magmacube',
    ...['steve', 'alex', 'ari', 'efe', 'kai', 'makena', 'noor', 'sunny', 'zuri'].flatMap((n) => [`player/wide/${n}`, `player/slim/${n}`]),
  ].map((t) => `textures/entity/${t}.png`),
];

const getJson = async (url) => {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
};

const manifest = await getJson('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json');
const entry = manifest.versions.find((v) => v.id === VERSION);
if (!entry) throw new Error(`Нет версии ${VERSION}`);
const client = (await getJson(entry.url)).downloads.client;
const JAR = client.url;
const SIZE = client.size;

const local = process.env.MC_JAR ? openSync(process.env.MC_JAR, 'r') : null;
if (local && fstatSync(local).size !== SIZE) throw new Error(`MC_JAR — не тот jar: размер ${fstatSync(local).size}, у версии ${VERSION} — ${SIZE}`);

async function range(a, b) {
  if (local) {
    const buf = Buffer.alloc(b - a + 1);
    readSync(local, buf, 0, buf.length, a);
    return buf;
  }
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(JAR, { headers: { Range: `bytes=${a}-${b}` } });
      if (res.status !== 206) throw new Error(`Range ${a}-${b}: ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (e) {
      if (attempt >= 5) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}

/* ---------------------------------------------------------------- оглавление архива */

const tail = await range(SIZE - 65536, SIZE - 1);
const eocd = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
const cdSize = tail.readUInt32LE(eocd + 12);
const cdOff = tail.readUInt32LE(eocd + 16);
const cd = await range(cdOff, cdOff + cdSize - 1);
const dir = new Map(); // имя без assets/minecraft/ → { off, csize, method, full }
for (let p = 0; p < cd.length; ) {
  const method = cd.readUInt16LE(p + 10);
  const csize = cd.readUInt32LE(p + 20);
  const n = cd.readUInt16LE(p + 28);
  const x = cd.readUInt16LE(p + 30);
  const c = cd.readUInt16LE(p + 32);
  const off = cd.readUInt32LE(p + 42);
  const full = cd.toString('utf8', p + 46, p + 46 + n);
  if (full.startsWith('assets/minecraft/')) dir.set(full.slice(17), { off, csize, method, full });
  p += 46 + n + x + c;
}

/** Достать много файлов: соседние куски склеиваются в один запрос. */
async function readMany(names) {
  const list = names.map((n) => ({ n, ...dir.get(n) })).sort((a, b) => a.off - b.off);
  const out = new Map();
  let i = 0;
  while (i < list.length) {
    let j = i;
    const end = (e) => e.off + 30 + e.full.length + e.csize + 256;
    while (j + 1 < list.length && list[j + 1].off - end(list[j]) < 64 * 1024) j++;
    const start = list[i].off;
    const buf = await range(start, Math.min(SIZE - 1, end(list[j])));
    for (let k = i; k <= j; k++) {
      const e = list[k];
      const at = e.off - start;
      const data = at + 30 + buf.readUInt16LE(at + 26) + buf.readUInt16LE(at + 28);
      const raw = buf.subarray(data, data + e.csize);
      out.set(e.n, (e.method === 8 ? inflateRawSync(raw) : raw).toString('utf8'));
    }
    i = j + 1;
  }
  return out;
}

const pick = (prefix) => [...dir.keys()].filter((k) => k.startsWith(prefix) && k.endsWith('.json'));
const files = await readMany([...pick('blockstates/'), ...pick('items/'), ...pick('models/')]);
const json = (name) => (files.has(name) ? JSON.parse(files.get(name)) : null);
const strip = (s) => String(s).replace(/^minecraft:/, '');

/* ---------------------------------------------------------------- модели */

const modelFile = (m) => `models/${strip(m)}.json`;
/** Цепочка родителей модели: [модель, родитель, …]. Пустая — модели нет. */
function chain(model) {
  const out = [];
  let m = strip(model);
  while (m && !m.startsWith('builtin/') && files.has(modelFile(m)) && !out.includes(m)) {
    out.push(m);
    m = json(modelFile(m)).parent ? strip(json(modelFile(m)).parent) : null;
  }
  return { list: out, builtin: m && m.startsWith('builtin/') ? m : null };
}
const hasElements = (list) => list.some((m) => Array.isArray(json(modelFile(m)).elements));

/* ---------------------------------------------------------------- блоки */

// Служебные и «невидимые» блоки не показываем.
const SKIP_BLOCKS = /^(air|cave_air|void_air|barrier|light|structure_void|moving_piston|piston_head|end_portal|end_gateway|nether_portal|bubble_column|fire|soul_fire|redstone_wire|tripwire|test_block|test_instance_block|jigsaw|structure_block|command_block|chain_command_block|repeating_command_block|.*_wall_(sign|hanging_sign|banner|torch|fan|head|skull)|frosted_ice|powder_snow|.*cauldron)$/;
const PREFER = ['facing=south', 'axis=y', 'half=bottom', 'half=lower', 'type=bottom', 'face=floor', 'waterlogged=false', 'lit=false', 'powered=false', 'open=false', 'hinge=left', 'attachment=floor', 'snowy=false', 'part=foot'];
// Блоки, которые соединяются с соседями (заборы, стены, стёкла, решётки): в оглавление идут все их части с условием
// `when` — какие рисовать, решает студия по соседним блокам (skin3d.js → connectState).
const CONNECTING = /(_fence|_wall|_pane|_bars)$|^glass_pane$/;
const FACING_STEP = { south: [0, 0, 16], north: [0, 0, -16], east: [16, 0, 0], west: [-16, 0, 0] };

/** Части блока: [{ model, x, y, when?, off? }] — off — сдвиг второй половины (дверь, высокий цветок, изголовье кровати). */
function defaultParts(id, state) {
  const one = (v) => (Array.isArray(v) ? v[0] : v);
  if (state.variants) {
    const keys = Object.keys(state.variants);
    const score = (k) => PREFER.filter((t) => k.split(',').includes(t)).length;
    const key = keys.reduce((best, k) => (score(k) > score(best) ? k : best), keys[0]);
    const out = [one(state.variants[key])];
    const props = key.split(',');
    // Двойные по высоте (двери, высокие цветы и трава): верхняя половина — тем же ключом с half=upper.
    if (props.includes('half=lower')) {
      const up = state.variants[key.replace('half=lower', 'half=upper')];
      if (up) out.push({ ...one(up), off: [0, 16, 0] });
    }
    // Кровать: изголовье — следующий блок в сторону facing.
    if (props.includes('part=foot')) {
      const head = state.variants[key.replace('part=foot', 'part=head')];
      const facing = (props.find((p) => p.startsWith('facing=')) || '').slice(7);
      if (head && FACING_STEP[facing]) out.push({ ...one(head), off: FACING_STEP[facing] });
    }
    return out;
  }
  if (state.multipart) {
    if (CONNECTING.test(id)) return state.multipart.map((p) => ({ ...one(p.apply), when: p.when || null }));
    const always = state.multipart.filter((p) => !p.when).map((p) => one(p.apply));
    return always.length ? always : [one(state.multipart[0].apply)];
  }
  return [];
}

const blocks = [];
const usedModels = new Set();
for (const name of pick('blockstates/')) {
  const id = name.slice(12, -5);
  if (SKIP_BLOCKS.test(id)) continue;
  const parts = defaultParts(id, json(name));
  const out = [];
  for (const p of parts) {
    const c = chain(p.model);
    if (!c.list.length || !hasElements(c.list)) continue;
    c.list.forEach((m) => usedModels.add(m));
    // [модель, x, y] или [модель, x, y, { w: условие, o: сдвиг }].
    const part = [strip(p.model)];
    const extra = {};
    if (p.when) extra.w = p.when;
    if (p.off) extra.o = p.off;
    if (p.x || p.y || Object.keys(extra).length) part.push(p.x || 0, p.y || 0);
    if (Object.keys(extra).length) part.push(extra);
    out.push(part);
  }
  if (out.length) blocks.push([id, ...out]);
}
// Вода и лава: в игре это не модели, а особая отрисовка — показываем кубом с их текстурой.
blocks.push(['water', ['@water']], ['lava', ['@lava']]);

/* ---------------------------------------------------------------- предметы */

/** Из определения предмета (items/*.json) — обычная модель и оттенки слоёв. */
function itemModel(node) {
  if (!node || typeof node !== 'object') return null;
  const t = strip(node.type || '');
  if (t === 'model') return { model: strip(node.model), tints: node.tints || [] };
  if (t === 'condition') return itemModel(node.on_false) || itemModel(node.on_true);
  if (t === 'select') return itemModel(node.fallback) || itemModel(node.cases && node.cases[0] && node.cases[0].model);
  if (t === 'range_dispatch') return itemModel(node.fallback) || itemModel(node.entries && node.entries[0] && node.entries[0].model);
  if (t === 'composite') return itemModel(node.models && node.models[0]);
  return null; // special (щит, сундук, трезубец…), empty, bundle — не плоские, пропускаем
}

/** Оттенок слоя: число ARGB или null. */
function tintColor(t) {
  if (!t) return null;
  const type = strip(t.type || '');
  const v = type === 'constant' ? t.value : t.default;
  if (typeof v === 'number') return '#' + ((v >>> 0) & 0xffffff).toString(16).padStart(6, '0');
  if (Array.isArray(v)) return '#' + v.map((x) => Math.round(x * 255).toString(16).padStart(2, '0')).join('');
  return null;
}

const SKIP_ITEMS = /^(air|debug_stick|.*_spawn_egg|filled_map|knowledge_book|light|barrier|structure_void|jigsaw|command_block_minecart)$/;
const items = [];
for (const name of pick('items/')) {
  const id = name.slice(6, -5);
  if (SKIP_ITEMS.test(id)) continue;
  const m = itemModel(json(name).model);
  if (!m) continue;
  const c = chain(m.model);
  if (!c.list.length) continue;
  // Блок в руке — это блок из списка блоков; здесь только плоские предметы.
  if (!c.list.some((x) => x === 'item/generated' || x === 'item/handheld' || x.startsWith('item/handheld'))) continue;
  if (hasElements(c.list)) continue;
  c.list.forEach((x) => usedModels.add(x));
  const tints = m.tints.map(tintColor);
  items.push(tints.some(Boolean) ? [id, m.model, tints] : [id, m.model]);
}

/* ---------------------------------------------------------------- какие файлы нужны браузеру */

const textures = new Set(['textures/block/water_still.png', 'textures/block/lava_still.png']);
// Головы: положение в руке и на полке — из моделей item/template_skull и item/dragon_head.
for (const m of ['item/template_skull', 'item/dragon_head']) if (files.has(modelFile(m))) chain(m).list.forEach((x) => usedModels.add(x));
const parents = {};
for (const m of usedModels) {
  const j = json(modelFile(m));
  if (j.parent) parents[m] = strip(j.parent);
  for (const v of Object.values(j.textures || {})) {
    const t = v && typeof v === 'object' ? v.sprite : v; // в новых версиях — { sprite, force_translucent }
    if (typeof t === 'string' && !t.startsWith('#')) textures.add(`textures/${strip(t)}.png`);
  }
}

const missing = EXTRA_FILES.filter((n) => !dir.has(n));
if (missing.length) console.warn('В jar нет:', missing.join(', '));
const need = [...new Set([...[...usedModels].map(modelFile), ...textures, ...EXTRA_FILES, 'lang/en_us.json'])].filter((n) => dir.has(n)).sort();
const table = {};
for (const n of need) {
  const e = dir.get(n);
  const slash = n.lastIndexOf('/');
  const folder = n.slice(0, slash + 1);
  const base = n.slice(slash + 1).replace(/\.(json|png)$/, '');
  (table[folder] = table[folder] || {})[base] = e.method === 8 ? [e.off, e.csize] : [e.off, e.csize, e.method];
}

const index = { version: VERSION, jar: JAR, size: SIZE, files: table, parents, blocks, items };
writeFileSync(OUT, JSON.stringify(index));
console.log(`${VERSION}: блоков ${blocks.length}, предметов ${items.length}, моделей ${usedModels.size}, текстур ${textures.size}, файлов ${need.length}`);
