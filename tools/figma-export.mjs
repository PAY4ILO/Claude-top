#!/usr/bin/env node
/**
 * Выгрузка макета из Figma: картинки в оригинальном качестве, логотип и иконки
 * в SVG, фреймы в PNG (для сравнения со скриншотами) и дизайн-токены.
 *
 *   FIGMA_TOKEN=... node tools/figma-export.mjs
 *   node tools/figma-export.mjs --file YKqqIlIyP7Xq28pw7R1e5T --scale 2
 *
 * Токену нужен скоуп "File content: Read-only" (file_content:read).
 * Токен читается только из переменной окружения и никуда не сохраняется.
 *
 * Результат:
 *   assets/img/figma/            — растровые заливки (IMAGE fills), как загружены в Figma
 *   assets/img/figma/svg/        — логотип и иконки в SVG
 *   design/figma/frames/         — PNG каждого фрейма (эталон для tools/compare.mjs)
 *   design/figma/tokens.json     — цвета, шрифты, радиусы, тени с частотой использования
 *   design/figma/tokens.css      — те же токены как CSS-переменные (для сверки с assets/css/tokens.css)
 *   design/figma/layout.json     — координаты и размеры всех слоёв каждого фрейма
 *   design/figma/manifest.json   — какой слой в какой файл выгружен
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Встроенный fetch в Node не читает HTTPS_PROXY без NODE_USE_ENV_PROXY=1 (Node >= 22.21).
if ((process.env.HTTPS_PROXY || process.env.https_proxy) && !process.env.NODE_USE_ENV_PROXY) {
  const r = spawnSync(process.execPath, process.argv.slice(1), {
    stdio: 'inherit',
    env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
  });
  process.exit(r.status ?? 1);
}

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.figma.com/v1';

const args = parseArgs(process.argv.slice(2));
const FILE_KEY = args.file || 'YKqqIlIyP7Xq28pw7R1e5T';
const FRAME_SCALE = Number(args.scale || 1);
const OUT_DESIGN = path.join(ROOT, args.out || 'design/figma');
const OUT_IMG = path.join(ROOT, 'assets/img/figma');
const TOKEN = process.env.FIGMA_TOKEN;

const VECTOR_TYPES = new Set(['VECTOR', 'BOOLEAN_OPERATION', 'STAR', 'LINE', 'ELLIPSE', 'REGULAR_POLYGON', 'RECTANGLE']);
const CONTAINER_TYPES = new Set(['GROUP', 'FRAME', 'COMPONENT', 'INSTANCE', 'COMPONENT_SET']);
const ICON_NAME = /(logo|лого|icon|иконк|ico[-_ ]|telegram|телеграм|svg)/i;

main().catch((err) => {
  console.error('\n✖', err.message);
  process.exit(1);
});

async function main() {
  if (!TOKEN) throw new Error('Переменная окружения FIGMA_TOKEN не задана.');
  console.log(`Файл ${FILE_KEY}: читаю документ…`);

  const file = await api(`/files/${FILE_KEY}`);
  await mkdir(OUT_DESIGN, { recursive: true });
  await writeFile(path.join(OUT_DESIGN, 'file.json'), JSON.stringify(file));

  const frames = [];
  const imageNodes = new Map(); // imageRef -> [{id,name,frame}]
  const vectorNodes = [];
  const tokens = { colors: {}, gradients: {}, text: {}, radii: {}, shadows: {} };
  const layout = {};

  for (const page of file.document.children || []) {
    for (const top of page.children || []) {
      if (!top.absoluteBoundingBox) continue;
      const frame = { id: top.id, name: top.name, page: page.name, ...size(top.absoluteBoundingBox) };
      frames.push(frame);
      layout[frameKey(frame)] = [];
      walk(top, top, frame);
    }
  }

  function walk(node, top, frame) {
    const bb = node.absoluteBoundingBox;
    const origin = top.absoluteBoundingBox;
    if (bb && node !== top) {
      layout[frameKey(frame)].push(describe(node, bb, origin));
    }
    collectTokens(node, tokens);
    for (const fill of node.fills || []) {
      if (fill.type === 'IMAGE' && fill.imageRef && fill.visible !== false) {
        if (!imageNodes.has(fill.imageRef)) imageNodes.set(fill.imageRef, []);
        imageNodes.get(fill.imageRef).push({ id: node.id, name: node.name, frame: frame.name });
      }
    }
    if (node !== top && isVectorLike(node)) {
      vectorNodes.push({ id: node.id, name: node.name, frame: frame.name, ...size(bb) });
      return; // не спускаемся внутрь: экспортируем группу целиком
    }
    for (const child of node.children || []) walk(child, top, frame);
  }

  console.log(`Фреймов: ${frames.length}, растровых заливок: ${imageNodes.size}, векторных узлов: ${vectorNodes.length}`);

  const manifest = { file: FILE_KEY, name: file.name, version: file.version, exportedAt: new Date().toISOString(), frames: [], images: [], svg: [] };

  // 1. Растровые заливки в оригинальном качестве (как их загрузили в Figma).
  if (imageNodes.size) {
    const { meta } = await api(`/files/${FILE_KEY}/images`);
    await mkdir(OUT_IMG, { recursive: true });
    const used = new Set();
    for (const [ref, nodes] of imageNodes) {
      const url = meta.images?.[ref];
      if (!url) continue;
      const { buf, ext } = await download(url);
      const base = uniqueName(slug(nodes[0].name) || 'image', used);
      const rel = `assets/img/figma/${base}.${ext}`;
      await writeFile(path.join(ROOT, rel), buf);
      manifest.images.push({ file: rel, imageRef: ref, bytes: buf.length, nodes });
      console.log(`  ↓ ${rel} (${kb(buf.length)})`);
    }
  }

  // 2. Логотип и иконки в SVG.
  if (vectorNodes.length) {
    await mkdir(path.join(OUT_IMG, 'svg'), { recursive: true });
    const used = new Set();
    for (const batch of chunks(vectorNodes, 40)) {
      const ids = batch.map((n) => n.id).join(',');
      const { images } = await api(`/images/${FILE_KEY}?ids=${encodeURIComponent(ids)}&format=svg&svg_include_id=true&svg_simplify_stroke=true`);
      for (const node of batch) {
        if (!images?.[node.id]) continue;
        const { buf } = await download(images[node.id]);
        const rel = `assets/img/figma/svg/${uniqueName(slug(node.name) || 'vector', used)}.svg`;
        await writeFile(path.join(ROOT, rel), buf);
        manifest.svg.push({ file: rel, ...node });
        console.log(`  ↓ ${rel}`);
      }
    }
  }

  // 3. Фреймы целиком — эталон для сравнения со скриншотами сайта.
  await mkdir(path.join(OUT_DESIGN, 'frames'), { recursive: true });
  const usedFrames = new Set();
  for (const batch of chunks(frames, 10)) {
    const ids = batch.map((f) => f.id).join(',');
    const { images } = await api(`/images/${FILE_KEY}?ids=${encodeURIComponent(ids)}&format=png&scale=${FRAME_SCALE}`);
    for (const frame of batch) {
      if (!images?.[frame.id]) continue;
      const { buf } = await download(images[frame.id]);
      const rel = `design/figma/frames/${uniqueName(slug(frame.name) || 'frame', usedFrames)}.png`;
      await writeFile(path.join(ROOT, rel), buf);
      manifest.frames.push({ file: rel, scale: FRAME_SCALE, ...frame });
      console.log(`  ↓ ${rel} (${frame.width}×${frame.height})`);
    }
  }

  const sorted = sortTokens(tokens);
  await writeFile(path.join(OUT_DESIGN, 'tokens.json'), JSON.stringify(sorted, null, 2));
  await writeFile(path.join(OUT_DESIGN, 'tokens.css'), tokensToCss(sorted));
  await writeFile(path.join(OUT_DESIGN, 'layout.json'), JSON.stringify(layout, null, 2));
  await writeFile(path.join(OUT_DESIGN, 'manifest.json'), JSON.stringify(manifest, null, 2));

  console.log('\nГотово. Шрифты в макете:');
  for (const [k, v] of Object.entries(sorted.text).slice(0, 12)) console.log(`  ${v.count}× ${k}`);
  console.log('Цвета:');
  for (const [k, v] of Object.entries(sorted.colors).slice(0, 12)) console.log(`  ${v.count}× ${k}`);
}

/* ---------- токены ---------- */

function collectTokens(node, t) {
  for (const paint of [...(node.fills || []), ...(node.strokes || [])]) {
    if (paint.visible === false) continue;
    if (paint.type === 'SOLID') bump(t.colors, color(paint.color, paint.opacity), node);
    if (paint.type?.startsWith('GRADIENT_')) {
      const css = `${paint.type.replace('GRADIENT_', '').toLowerCase()}: ` + paint.gradientStops.map((s) => `${color(s.color)} ${Math.round(s.position * 100)}%`).join(', ');
      bump(t.gradients, css, node);
    }
  }
  if (node.type === 'TEXT' && node.style) {
    const s = node.style;
    const key = `${s.fontFamily} ${s.fontWeight} ${s.fontSize}px/${round(s.lineHeightPx)}px` + (s.letterSpacing ? ` ls:${round(s.letterSpacing)}px` : '') + (s.textCase && s.textCase !== 'ORIGINAL' ? ` ${s.textCase}` : '');
    bump(t.text, key, node, (node.characters || '').slice(0, 60));
  }
  if (typeof node.cornerRadius === 'number' && node.cornerRadius > 0) bump(t.radii, `${round(node.cornerRadius)}px`, node);
  if (Array.isArray(node.rectangleCornerRadii) && node.rectangleCornerRadii.some(Boolean)) bump(t.radii, node.rectangleCornerRadii.map((r) => `${round(r)}px`).join(' '), node);
  for (const e of node.effects || []) {
    if (e.visible === false || !e.type.includes('SHADOW')) continue;
    const inset = e.type === 'INNER_SHADOW' ? 'inset ' : '';
    bump(t.shadows, `${inset}${round(e.offset.x)}px ${round(e.offset.y)}px ${round(e.radius)}px ${round(e.spread || 0)}px ${color(e.color)}`, node);
  }
}

function bump(map, key, node, sample) {
  const entry = (map[key] ||= { count: 0, nodes: [] });
  entry.count++;
  if (entry.nodes.length < 6) entry.nodes.push(sample ? `${node.name}: «${sample}»` : node.name);
}

function sortTokens(t) {
  const out = {};
  for (const [group, map] of Object.entries(t)) {
    out[group] = Object.fromEntries(Object.entries(map).sort((a, b) => b[1].count - a[1].count));
  }
  return out;
}

function tokensToCss(t) {
  const lines = ['/* Сгенерировано tools/figma-export.mjs — сверяйте с assets/css/tokens.css */', ':root {'];
  Object.keys(t.colors).forEach((c, i) => lines.push(`  --figma-color-${i + 1}: ${c}; /* ${t.colors[c].count}× ${t.colors[c].nodes.slice(0, 2).join(', ')} */`));
  Object.keys(t.gradients).forEach((g, i) => lines.push(`  --figma-gradient-${i + 1}: /* ${g} */;`));
  Object.keys(t.radii).forEach((r, i) => lines.push(`  --figma-radius-${i + 1}: ${r};`));
  Object.keys(t.shadows).forEach((s, i) => lines.push(`  --figma-shadow-${i + 1}: ${s};`));
  lines.push('}', '', '/* Текстовые стили:');
  for (const [k, v] of Object.entries(t.text)) lines.push(`   ${v.count}× ${k} — ${v.nodes[0]}`);
  lines.push('*/', '');
  return lines.join('\n');
}

function describe(node, bb, origin) {
  const d = {
    id: node.id,
    name: node.name,
    type: node.type,
    x: round(bb.x - origin.x),
    y: round(bb.y - origin.y),
    w: round(bb.width),
    h: round(bb.height),
  };
  const fill = (node.fills || []).find((f) => f.visible !== false);
  if (fill?.type === 'SOLID') d.fill = color(fill.color, fill.opacity);
  else if (fill) d.fill = fill.type;
  if (node.cornerRadius) d.radius = round(node.cornerRadius);
  if (node.layoutMode && node.layoutMode !== 'NONE') {
    d.autoLayout = { mode: node.layoutMode, gap: node.itemSpacing, padding: [node.paddingTop, node.paddingRight, node.paddingBottom, node.paddingLeft] };
  }
  if (node.type === 'TEXT') {
    d.text = node.characters;
    d.font = node.style && `${node.style.fontFamily} ${node.style.fontWeight} ${node.style.fontSize}/${round(node.style.lineHeightPx)}`;
  }
  return d;
}

function isVectorLike(node) {
  if (!node.absoluteBoundingBox) return false;
  if (hasImageFill(node)) return false;
  if (VECTOR_TYPES.has(node.type) && node.type !== 'RECTANGLE') return ICON_NAME.test(node.name) || !node.children;
  if (!CONTAINER_TYPES.has(node.type)) return false;
  if (ICON_NAME.test(node.name) && onlyVectors(node)) return true;
  const { width, height } = node.absoluteBoundingBox;
  return width <= 256 && height <= 256 && onlyVectors(node) && countVectors(node) > 1;
}

function onlyVectors(node) {
  if (hasImageFill(node) || node.type === 'TEXT') return false;
  if (!node.children) return VECTOR_TYPES.has(node.type) || CONTAINER_TYPES.has(node.type);
  return node.children.every(onlyVectors);
}

function countVectors(node) {
  return (VECTOR_TYPES.has(node.type) ? 1 : 0) + (node.children || []).reduce((n, c) => n + countVectors(c), 0);
}

function hasImageFill(node) {
  return (node.fills || []).some((f) => f.type === 'IMAGE' && f.visible !== false) || (node.children || []).some(hasImageFill);
}

/* ---------- сеть ---------- */

async function api(pathname, attempt = 0) {
  const res = await fetch(API + pathname, { headers: { 'X-Figma-Token': TOKEN } });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 4) throw new Error(`Figma API ${res.status} на ${pathname}`);
    const wait = Number(res.headers.get('retry-after')) * 1000 || 2000 * 2 ** attempt;
    console.log(`  … ${res.status}, повтор через ${Math.round(wait / 1000)} с`);
    await new Promise((r) => setTimeout(r, wait));
    return api(pathname, attempt + 1);
  }
  const body = await res.json().catch(() => ({}));
  if (res.status === 403) {
    const msg = body.err || body.message || '';
    throw new Error(`Доступ запрещён (403): ${msg}\nСоздайте токен со скоупом «File content: Read-only» (file_content:read) в Figma → Settings → Security → Personal access tokens и положите его в FIGMA_TOKEN.`);
  }
  if (!res.ok || body.error === true || body.err) throw new Error(`Figma API ${res.status}: ${body.err || body.message || res.statusText}`);
  return body;
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Не удалось скачать ${url}: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, ext: extOf(buf, res.headers.get('content-type')) };
}

function extOf(buf, type = '') {
  const hex = buf.subarray(0, 12).toString('hex');
  if (hex.startsWith('89504e47')) return 'png';
  if (hex.startsWith('ffd8ff')) return 'jpg';
  if (hex.startsWith('47494638')) return 'gif';
  if (hex.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WEBP') return 'webp';
  if (buf.subarray(0, 256).toString().includes('<svg')) return 'svg';
  return (type.split('/')[1] || 'bin').replace('jpeg', 'jpg').replace('svg+xml', 'svg');
}

/* ---------- утилиты ---------- */

function parseArgs(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    if (list[i].startsWith('--')) out[list[i].slice(2)] = list[i + 1] && !list[i + 1].startsWith('--') ? list[++i] : true;
  }
  return out;
}

function size(bb) {
  return { width: round(bb.width), height: round(bb.height) };
}

function frameKey(f) {
  return `${f.page} / ${f.name} (${f.id})`;
}

function color(c, opacity = 1) {
  const a = (c.a ?? 1) * (opacity ?? 1);
  const hex = '#' + [c.r, c.g, c.b].map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('').toUpperCase();
  return a < 0.999 ? `${hex}${Math.round(a * 255).toString(16).padStart(2, '0').toUpperCase()}` : hex;
}

function round(v) {
  return Math.round(v * 100) / 100;
}

function kb(n) {
  return n > 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} МБ` : `${Math.round(n / 1024)} КБ`;
}

function* chunks(list, n) {
  for (let i = 0; i < list.length; i += n) yield list.slice(i, i + n);
}

const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'c', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };

function slug(name = '') {
  return name
    .toLowerCase()
    .replace(/[а-яё]/g, (ch) => TRANSLIT[ch] ?? '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
}

function uniqueName(base, used) {
  let name = base;
  for (let i = 2; used.has(name); i++) name = `${base}-${i}`;
  used.add(name);
  return name;
}
