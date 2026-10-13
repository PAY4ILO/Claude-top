#!/usr/bin/env node
/**
 * Карточки игроков → SVG для Figma: поднимает сайт с временной базой и выдуманными игроками, открывает страницы
 * в браузере и переводит готовую вёрстку в SVG со слоями — тексты остаются текстами (Russo One / Inter),
 * фоны — градиентами, скины — картинками, у каждого блока своя группа с именем класса.
 *
 *   npm run figma:cards
 *   node tools/figma-cards.mjs --channel msedge        # если Chromium от Playwright не установлен
 *
 * Результат — design/figma/cards/:
 *   lwl-cards.svg      — всё на одном холсте (перетащить в Figma одним файлом)
 *   NN-<имя>.svg       — каждый макет отдельно (перетащить пачкой — в Figma будет по фрейму на файл)
 *
 * Только для разработки: на сервер сайта не ставится, живые данные не трогает.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).flatMap((a, i, all) => (a.startsWith('--') ? [[a.slice(2), all[i + 1] && !all[i + 1].startsWith('--') ? all[i + 1] : '1']] : []))
);
const OUT = path.join(ROOT, args.out || 'design/figma/cards');
const TOKEN = 'figma-cards-token-0123456789abcdef';
const HOUR = 3600;

/* ------------------------------------------------------------ выдуманные игроки */

// hue — во что перекрасить одежду стандартного скина (0 — не трогать), skin: false — без своего скина.
const PEOPLE = [
  { nick: 'Hawk_1', pose: 'wave', bg: 'nether', hue: 0, bio: 'Строю мосты над лавой', socials: { telegram: 'hawker_tg', youtube: 'hawker' }, online: true,
    stats: { playTimeSec: 130 * HOUR, deaths: 4, mobKills: 1234, playerKills: 2, blocksMined: 10500, distanceM: 3400, advancements: 37 } },
  { nick: 'Alex_3', pose: 'walk', bg: 'cave', hue: 120, slim: true, bio: 'Копаю алмазы и ищу пещеры', socials: { discord: 'alex.3' }, online: true,
    stats: { playTimeSec: 48 * HOUR, deaths: 19, mobKills: 610, playerKills: 0, blocksMined: 25400, distanceM: 52000, advancements: 21 } },
  { nick: 'Snow_Fox', pose: 'cheer', bg: 'snow', hue: 300, bio: 'Строю ледяной замок на севере', socials: { twitch: 'snowfox' }, seenAgo: 2 * HOUR,
    stats: { playTimeSec: 74 * HOUR, deaths: 8, mobKills: 340, playerKills: 1, blocksMined: 8200, distanceM: 21000, advancements: 30 } },
  { nick: 'Mira_Sea', pose: 'point', bg: 'ocean', hue: 200, slim: true, bio: 'Рыбачу и строю маяки', socials: { vk: 'mira_sea', tiktok: 'mira.sea' }, seenAgo: 3 * 24 * HOUR,
    stats: { playTimeSec: 22 * HOUR, deaths: 2, mobKills: 45, playerKills: 0, blocksMined: 1900, distanceM: 8800, advancements: 14 } },
  { nick: 'Night_Owl', pose: 'sit', bg: 'night', hue: 250, bio: 'Играю по ночам, строю обсерваторию', socials: {}, seenAgo: 20 * 60,
    stats: { playTimeSec: 210 * HOUR, deaths: 41, mobKills: 3900, playerKills: 7, blocksMined: 40100, distanceM: 120000, advancements: 58 } },
  { nick: 'Sunny_Day', pose: 'stand', bg: 'sunset', hue: 40, bio: '', socials: {}, seenAgo: 6 * HOUR,
    stats: { playTimeSec: 9 * HOUR, deaths: 1, mobKills: 12, playerKills: 0, blocksMined: 600, distanceM: 2100, advancements: 6 } },
  { nick: 'Ender_Max', pose: 'wave', bg: 'end', hue: 280, bio: 'Охочусь на драконов', socials: { youtube: 'endermax' }, hide: ['deaths'], seenAgo: 26 * HOUR,
    stats: { playTimeSec: 96 * HOUR, deaths: 66, mobKills: 2200, playerKills: 12, blocksMined: 15000, distanceM: 64000, advancements: 44 } },
  { nick: 'Steve_2', pose: 'stand', bg: 'meadow', skin: false, bio: '', socials: {}, seenAgo: 40,
    stats: { playTimeSec: 5 * HOUR, deaths: 1, mobKills: 12, playerKills: 0, blocksMined: 300, distanceM: 900, advancements: 3 } },
];

/* ------------------------------------------------------------ DOM → SVG (выполняется в браузере) */

async function domToSvg({ selector, name, pad }) {
  const root = typeof selector === 'string' ? document.querySelector(selector) : selector;
  if (!root) throw new Error(`Нет элемента ${selector}`);
  const defs = [];
  const ids = new Map();
  let seq = 0;
  const uid = (p) => `${p}-${++seq}`;
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const num = (v) => Math.round(v * 100) / 100;
  // Имя слоя в Figma = id; повторяющиеся получают номер.
  const layerId = (base) => {
    const clean = String(base).replace(/\s+/g, ' ').trim().slice(0, 40) || 'layer';
    const k = (ids.get(clean) || 0) + 1;
    ids.set(clean, k);
    return esc(k === 1 ? clean : `${clean} ${k}`);
  };

  /* цвета: любой синтаксис CSS → rgba через canvas */
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const colorCache = new Map();
  function color(str) {
    if (colorCache.has(str)) return colorCache.get(str);
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = '#000';
    probe.fillStyle = str;
    probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    const out = { hex: '#' + [r, g, b].map((v) => v.toString(16).padStart(2, '0')).join(''), a: Math.round((a / 255) * 1000) / 1000 };
    colorCache.set(str, out);
    return out;
  }
  const paint = (c, attr = 'fill') => {
    const { hex, a } = color(c);
    return `${attr}="${hex}"${a < 1 ? ` ${attr}-opacity="${a}"` : ''}`;
  };
  const transparent = (c) => !c || color(c).a === 0;

  /* разбор списков CSS: запятые верхнего уровня */
  function splitTop(s, sep = ',') {
    const out = [];
    let depth = 0;
    let cur = '';
    for (const ch of s) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      if (ch === sep && depth === 0) {
        out.push(cur.trim());
        cur = '';
      } else cur += ch;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  // «rgb(…) 10% 20%» → { color, stops: [10, 20] }
  function parseStop(s) {
    const m = s.match(/^((?:rgba?|hsla?|color|oklch|oklab|lab|lch)\([^)]*\)|#[0-9a-f]+|[a-z]+)\s*(.*)$/i);
    if (!m) return null;
    return { color: m[1], at: m[2] ? m[2].split(/\s+/).filter(Boolean) : [] };
  }
  const lenOf = (v, total) => (v.endsWith('%') ? (parseFloat(v) / 100) * total : parseFloat(v));

  function stopsOf(parts, total) {
    const raw = [];
    for (const p of parts) {
      const s = parseStop(p);
      if (!s) continue;
      if (!s.at.length) raw.push({ color: s.color, pos: null });
      for (const a of s.at) raw.push({ color: s.color, pos: lenOf(a, total) / total });
    }
    if (!raw.length) return [];
    if (raw[0].pos == null) raw[0].pos = 0;
    if (raw.at(-1).pos == null) raw.at(-1).pos = 1;
    for (let i = 1; i < raw.length; i++) {
      if (raw[i].pos != null) {
        raw[i].pos = Math.max(raw[i].pos, raw[i - 1].pos ?? 0);
        continue;
      }
      let j = i;
      while (raw[j].pos == null) j++;
      const from = raw[i - 1].pos;
      for (let k = i; k < j; k++) raw[k].pos = from + ((raw[j].pos - from) * (k - i + 1)) / (j - i + 1);
    }
    return raw;
  }
  const stopTags = (stops) =>
    stops
      .map((s) => {
        const { hex, a } = color(s.color);
        return `<stop offset="${num(Math.min(1, Math.max(0, s.pos)))}" stop-color="${hex}"${a < 1 ? ` stop-opacity="${a}"` : ''}/>`;
      })
      .join('');

  /** Слой background-image → SVG поверх прямоугольника box. */
  async function bgLayer(layer, box, shape) {
    const lin = layer.match(/^(repeating-)?linear-gradient\((.*)\)$/s);
    if (lin && !lin[1]) {
      const parts = splitTop(lin[2]);
      let angle = 180;
      if (/^-?[\d.]+(deg|turn|rad)$/.test(parts[0])) {
        const v = parseFloat(parts[0]);
        angle = parts[0].endsWith('turn') ? v * 360 : parts[0].endsWith('rad') ? (v * 180) / Math.PI : v;
        parts.shift();
      } else if (/^to /.test(parts[0])) {
        const d = parts.shift();
        angle = { 'to top': 0, 'to right': 90, 'to bottom': 180, 'to left': 270, 'to top right': 45, 'to right top': 45, 'to bottom right': 135, 'to right bottom': 135, 'to bottom left': 225, 'to left bottom': 225, 'to top left': 315, 'to left top': 315 }[d] ?? 180;
      }
      const rad = (angle * Math.PI) / 180;
      const dx = Math.sin(rad);
      const dy = -Math.cos(rad);
      const L = Math.abs(box.w * dx) + Math.abs(box.h * dy);
      const cx = box.x + box.w / 2;
      const cy = box.y + box.h / 2;
      const stops = stopsOf(parts, L);
      const id = uid('lg');
      defs.push(
        `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="${num(cx - (dx * L) / 2)}" y1="${num(cy - (dy * L) / 2)}" x2="${num(cx + (dx * L) / 2)}" y2="${num(cy + (dy * L) / 2)}">${stopTags(stops)}</linearGradient>`
      );
      return shape(`fill="url(#${id})"`, 'gradient');
    }
    const rad = layer.match(/^radial-gradient\((.*)\)$/s);
    if (rad) {
      const parts = splitTop(rad[1]);
      let rx = Math.hypot(box.w, box.h) / 2;
      let ry = rx;
      let cx = box.x + box.w / 2;
      let cy = box.y + box.h / 2;
      if (!parseStop(parts[0]) || / at /.test(parts[0]) || /^(circle|ellipse|closest|farthest|[\d.])/.test(parts[0])) {
        const head = parts.shift();
        const [shapePart, atPart] = head.split(/\s*at\s+/);
        const sizes = (shapePart || '').split(/\s+/).filter((t) => /^[\d.]+(px|%)$/.test(t));
        if (sizes.length) {
          rx = lenOf(sizes[0], box.w);
          ry = sizes[1] ? lenOf(sizes[1], box.h) : rx;
        }
        if (atPart) {
          const [ax, ay] = atPart.split(/\s+/);
          const pos = (v, total) => (v === 'center' ? total / 2 : v === 'left' || v === 'top' ? 0 : v === 'right' || v === 'bottom' ? total : lenOf(v, total));
          cx = box.x + pos(ax, box.w);
          cy = box.y + pos(ay ?? 'center', box.h);
        }
      }
      const stops = stopsOf(parts, rx);
      // «цвет 99%, прозрачный» — по сути кружок/эллипс с чёткой границей: так его и проще править в Figma.
      if (stops.length === 2 && transparent(stops[1].color) && !transparent(stops[0].color) && stops[0].pos >= 0.85) {
        return `<ellipse id="${layerId('dot')}" cx="${num(cx)}" cy="${num(cy)}" rx="${num(rx * stops[0].pos)}" ry="${num(ry * stops[0].pos)}" ${paint(stops[0].color)}/>`;
      }
      const id = uid('rg');
      defs.push(
        `<radialGradient id="${id}" gradientUnits="userSpaceOnUse" cx="${num(cx)}" cy="${num(cy)}" r="${num(rx)}" gradientTransform="translate(${num(cx)} ${num(cy)}) scale(1 ${num(ry / rx)}) translate(${num(-cx)} ${num(-cy)})">${stopTags(stops)}</radialGradient>`
      );
      return shape(`fill="url(#${id})"`, 'glow');
    }
    const url = layer.match(/^url\("?(.*?)"?\)$/);
    if (url) {
      const href = await dataUrl(url[1]);
      if (!href) return '';
      return `<image id="${layerId('background image')}" x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}" preserveAspectRatio="xMidYMid slice" xlink:href="${href}"/>`;
    }
    return '';
  }

  async function dataUrl(src) {
    try {
      const blob = await (await fetch(src)).blob();
      return await new Promise((res) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result);
        fr.readAsDataURL(blob);
      });
    } catch {
      return null;
    }
  }

  /* формы со скруглением */
  function radii(cs, w, h) {
    const one = (v) => {
      const first = v.split(' ')[0];
      return first.endsWith('%') ? (parseFloat(first) / 100) * Math.min(w, h) : parseFloat(first) || 0;
    };
    const r = [cs.borderTopLeftRadius, cs.borderTopRightRadius, cs.borderBottomRightRadius, cs.borderBottomLeftRadius].map(one);
    const k = Math.min(1, w / Math.max(r[0] + r[1], r[3] + r[2], 1e-9), h / Math.max(r[0] + r[3], r[1] + r[2], 1e-9));
    return r.map((v) => v * Math.min(1, k));
  }
  function shapeTag(box, rs, attrs, nameOf) {
    const { x, y, w, h } = box;
    if (rs.every((v) => Math.abs(v - rs[0]) < 0.01)) {
      return `<rect id="${layerId(nameOf)}" x="${num(x)}" y="${num(y)}" width="${num(w)}" height="${num(h)}"${rs[0] ? ` rx="${num(rs[0])}"` : ''} ${attrs}/>`;
    }
    const [tl, tr, br, bl] = rs;
    const d = `M${num(x + tl)} ${num(y)}H${num(x + w - tr)}${tr ? `A${num(tr)} ${num(tr)} 0 0 1 ${num(x + w)} ${num(y + tr)}` : ''}V${num(y + h - br)}${br ? `A${num(br)} ${num(br)} 0 0 1 ${num(x + w - br)} ${num(y + h)}` : ''}H${num(x + bl)}${bl ? `A${num(bl)} ${num(bl)} 0 0 1 ${num(x)} ${num(y + h - bl)}` : ''}V${num(y + tl)}${tl ? `A${num(tl)} ${num(tl)} 0 0 1 ${num(x + tl)} ${num(y)}` : ''}Z`;
    return `<path id="${layerId(nameOf)}" d="${d}" ${attrs}/>`;
  }

  /* тень — тем же набором фильтров, что пишет сама Figma: при импорте станет Drop shadow */
  function shadowFilter(cs, box) {
    if (!cs.boxShadow || cs.boxShadow === 'none') return '';
    const first = splitTop(cs.boxShadow).find((s) => !/\binset\b/.test(s));
    if (!first) return '';
    const m = first.match(/^(.*\))\s+(-?[\d.]+)px\s+(-?[\d.]+)px(?:\s+([\d.]+)px)?(?:\s+(-?[\d.]+)px)?/) || first.match(/^(\S+)\s+(-?[\d.]+)px\s+(-?[\d.]+)px(?:\s+([\d.]+)px)?/);
    if (!m) return '';
    const c = color(m[1]);
    if (!c.a) return '';
    const dx = +m[2];
    const dy = +m[3];
    const blur = +(m[4] || 0);
    const rgb = [1, 3, 5].map((i) => parseInt(c.hex.slice(i, i + 2), 16) / 255);
    const id = uid('shadow');
    const fx = box.x - blur * 2 - Math.abs(dx);
    const fy = box.y - blur * 2 - Math.abs(dy);
    defs.push(
      `<filter id="${id}" x="${num(fx)}" y="${num(fy)}" width="${num(box.w + blur * 4 + Math.abs(dx) * 2)}" height="${num(box.h + blur * 4 + Math.abs(dy) * 2)}" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB">` +
        `<feFlood flood-opacity="0" result="BackgroundImageFix"/><feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"/>` +
        `<feOffset dx="${dx}" dy="${dy}"/><feGaussianBlur stdDeviation="${num(blur / 2)}"/><feComposite in2="hardAlpha" operator="out"/>` +
        `<feColorMatrix type="matrix" values="0 0 0 0 ${num(rgb[0])} 0 0 0 0 ${num(rgb[1])} 0 0 0 0 ${num(rgb[2])} 0 0 0 ${c.a} 0"/>` +
        `<feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow"/><feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow" result="shape"/></filter>`
    );
    return ` filter="url(#${id})"`;
  }

  /* текст: строки берём из того, как браузер их уже разложил */
  const metricsCache = new Map();
  function metrics(cs) {
    const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    if (!metricsCache.has(font)) {
      probe.font = font;
      const m = probe.measureText('HgЙ');
      metricsCache.set(font, { asc: m.fontBoundingBoxAscent, desc: m.fontBoundingBoxDescent });
    }
    return metricsCache.get(font);
  }
  const family = (cs) => cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
  function transformText(s, cs) {
    if (cs.textTransform === 'uppercase') return s.toUpperCase();
    if (cs.textTransform === 'lowercase') return s.toLowerCase();
    return s;
  }
  function textAttrs(cs, fill) {
    const ls = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing);
    const deco = cs.textDecorationLine && cs.textDecorationLine !== 'none' ? ` text-decoration="${cs.textDecorationLine}"` : '';
    return `font-family="${esc(family(cs))}" font-size="${parseFloat(cs.fontSize)}" font-weight="${cs.fontWeight}"${cs.fontStyle === 'italic' ? ' font-style="italic"' : ''}${ls ? ` letter-spacing="${num(ls)}"` : ''}${deco} ${paint(fill)}`;
  }
  function textNode(tn, cs, ox, oy) {
    const text = tn.data;
    if (!text.trim()) return '';
    const range = document.createRange();
    const lines = [];
    let line = null;
    let space = false;
    for (let i = 0; i < text.length; i++) {
      const len = text.codePointAt(i) > 0xffff ? 2 : 1;
      const ch = text.slice(i, i + len);
      range.setStart(tn, i);
      range.setEnd(tn, i + len);
      i += len - 1;
      if (/\s/.test(ch)) {
        space = true;
        continue;
      }
      const r = [...range.getClientRects()].find((q) => q.width > 0 || q.height > 0);
      if (!r) continue;
      if (!line || Math.abs(r.top - line.top) > r.height / 2) {
        line = { top: r.top, h: r.height, x: r.left, s: '' };
        lines.push(line);
      } else if (space) line.s += ' ';
      space = false;
      line.s += transformText(ch, cs);
    }
    if (!lines.length) return '';
    const { asc, desc } = metrics(cs);
    const spans = lines
      .map((l) => `<tspan x="${num(l.x - ox)}" y="${num(l.top - oy + (l.h - (asc + desc)) / 2 + asc)}">${esc(l.s)}</tspan>`)
      .join('');
    return `<text id="${layerId(lines.map((l) => l.s).join(' '))}" xml:space="preserve" ${textAttrs(cs, cs.color)}>${spans}</text>`;
  }

  /* поля ввода: значение или подсказка */
  function fieldText(el, cs, box) {
    let value = el.value;
    let fill = cs.color;
    if (el.tagName === 'SELECT') value = el.selectedOptions[0]?.textContent || '';
    if (!value && el.placeholder) {
      value = el.placeholder;
      fill = getComputedStyle(el, '::placeholder').color;
    }
    if (!value) return '';
    const { asc, desc } = metrics(cs);
    const x = box.x + parseFloat(cs.paddingLeft) + parseFloat(cs.borderLeftWidth);
    let y;
    if (el.tagName === 'TEXTAREA') {
      const lh = cs.lineHeight === 'normal' ? (asc + desc) * 1.2 : parseFloat(cs.lineHeight);
      y = box.y + parseFloat(cs.paddingTop) + parseFloat(cs.borderTopWidth) + (lh - (asc + desc)) / 2 + asc;
    } else y = box.y + box.h / 2 + (asc - desc) / 2;
    return `<text id="${layerId(value)}" xml:space="preserve" ${textAttrs(cs, fill)}><tspan x="${num(x)}" y="${num(y)}">${esc(value.slice(0, 200))}</tspan></text>`;
  }

  /* вложенный SVG (иконки): цвета из CSS — прямо в атрибуты */
  function inlineSvg(el, box) {
    const clone = el.cloneNode(true);
    const src = [el, ...el.querySelectorAll('*')];
    const dst = [clone, ...clone.querySelectorAll('*')];
    src.forEach((node, i) => {
      const cs = getComputedStyle(node);
      const d = dst[i];
      d.removeAttribute('class');
      d.removeAttribute('style');
      if (node === el) return;
      if (['path', 'circle', 'rect', 'ellipse', 'line', 'polyline', 'polygon'].includes(node.tagName)) {
        const fill = cs.fill;
        const stroke = cs.stroke;
        d.setAttribute('fill', fill === 'none' || transparent(fill) ? 'none' : color(fill).hex);
        if (fill !== 'none' && !transparent(fill) && color(fill).a < 1) d.setAttribute('fill-opacity', color(fill).a);
        if (stroke && stroke !== 'none' && !transparent(stroke)) {
          d.setAttribute('stroke', color(stroke).hex);
          if (color(stroke).a < 1) d.setAttribute('stroke-opacity', color(stroke).a);
          d.setAttribute('stroke-width', cs.strokeWidth);
          d.setAttribute('stroke-linecap', cs.strokeLinecap);
          d.setAttribute('stroke-linejoin', cs.strokeLinejoin);
        }
      }
    });
    clone.setAttribute('x', num(box.x));
    clone.setAttribute('y', num(box.y));
    clone.setAttribute('width', num(box.w));
    clone.setAttribute('height', num(box.h));
    clone.setAttribute('id', layerId(el.getAttribute('aria-label') || 'icon'));
    for (const a of ['aria-hidden', 'focusable', 'role']) clone.removeAttribute(a);
    return new XMLSerializer().serializeToString(clone).replace(/ xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '').replace(/currentColor/g, color(getComputedStyle(el).color).hex);
  }

  async function imageTag(el, box, cs) {
    const src = el.currentSrc || el.src;
    if (/\.svg(\?|$)/.test(src)) {
      try {
        const doc = new DOMParser().parseFromString(await (await fetch(src)).text(), 'image/svg+xml');
        const svg = doc.documentElement;
        svg.setAttribute('x', num(box.x));
        svg.setAttribute('y', num(box.y));
        svg.setAttribute('width', num(box.w));
        svg.setAttribute('height', num(box.h));
        svg.setAttribute('id', layerId(el.alt || 'logo'));
        return new XMLSerializer().serializeToString(svg).replace(/ xmlns="http:\/\/www\.w3\.org\/2000\/svg"/g, '');
      } catch {
        return '';
      }
    }
    const c = document.createElement('canvas');
    c.width = el.naturalWidth || box.w;
    c.height = el.naturalHeight || box.h;
    c.getContext('2d').drawImage(el, 0, 0);
    const fit = cs.objectFit === 'cover' ? 'xMidYMid slice' : cs.objectFit === 'fill' ? 'none' : 'xMidYMid meet';
    return `<image id="${layerId(el.alt || 'image')}" x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}" preserveAspectRatio="${fit}" xlink:href="${c.toDataURL('image/png')}"/>`;
  }

  /* имя слоя для элемента */
  function nameOf(el) {
    if (el.dataset?.nick) return `card ${el.dataset.nick}`;
    if (el.dataset?.figmaName) return el.dataset.figmaName;
    const cls = [...(el.classList || [])].find((c) => !/^(is-|has-|js-)/.test(c));
    return cls || el.getAttribute?.('aria-label') || el.tagName.toLowerCase();
  }

  // Порядок отрисовки, как у браузера (упрощённо): z-index < 0, обычный поток, позиционированные, z-index > 0.
  function paintOrder(el) {
    const layers = [[], [], [], []];
    for (const child of el.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) layers[1].push(child);
      if (child.nodeType !== Node.ELEMENT_NODE) continue;
      const c = getComputedStyle(child);
      const z = parseInt(c.zIndex, 10) || 0;
      layers[z < 0 ? 0 : z > 0 ? 3 : c.position !== 'static' ? 2 : 1].push(child);
    }
    for (const l of [layers[0], layers[3]]) l.sort((a, b) => parseInt(getComputedStyle(a).zIndex, 10) - parseInt(getComputedStyle(b).zIndex, 10));
    return layers.flat();
  }

  // ::before/::after в SVG не попадут — на время съёмки делаем из них настоящие <span> с теми же стилями.
  const made = [];
  const sheet = new CSSStyleSheet();
  sheet.replaceSync('[data-figma-pseudo]::before,[data-figma-pseudo]::after{content:none!important}');
  function materialize(scope) {
    const marked = [];
    for (const el of [scope, ...scope.querySelectorAll('*')]) {
      // У полей ввода детей не бывает — галочку флажка рисует walk() сам.
      if (el.tagName === 'svg' || el.closest('svg') || ['INPUT', 'TEXTAREA', 'SELECT', 'IMG', 'CANVAS'].includes(el.tagName)) continue;
      const add = [];
      for (const which of ['::before', '::after']) {
        const pcs = getComputedStyle(el, which);
        if (!pcs.content || pcs.content === 'none' || pcs.content === 'normal' || pcs.display === 'none') continue;
        const span = document.createElement('span');
        for (let i = 0; i < pcs.length; i++) span.style.setProperty(pcs[i], pcs.getPropertyValue(pcs[i]));
        span.style.transition = 'none';
        span.style.animation = 'none';
        const text = pcs.content.match(/^"(.*)"$/);
        if (text) span.textContent = text[1];
        span.dataset.figmaName = which.slice(2);
        add.push([which, span]);
      }
      if (!add.length) continue;
      marked.push(el);
      for (const [which, span] of add) {
        if (which === '::before') el.prepend(span);
        else el.append(span);
        made.push(span);
      }
    }
    for (const el of marked) el.setAttribute('data-figma-pseudo', '');
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return () => {
      made.forEach((s) => s.remove());
      marked.forEach((el) => el.removeAttribute('data-figma-pseudo'));
      document.adoptedStyleSheets = document.adoptedStyleSheets.filter((s) => s !== sheet);
    };
  }

  const SKIP = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'OPTION', 'DATALIST', 'LINK', 'META']);
  async function walk(el, ox, oy) {
    if (SKIP.has(el.tagName)) return '';
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden' || +cs.opacity === 0) return '';
    if (el.tagName === 'INPUT' && el.type === 'hidden') return '';
    const r = el.getBoundingClientRect();
    // «Только для экранных читалок» (1×1 с обрезкой) — не рисуем.
    if (r.width <= 1 && r.height <= 1 && cs.position === 'absolute') return '';
    const box = { x: r.left - ox, y: r.top - oy, w: r.width, h: r.height };
    const rs = radii(cs, box.w, box.h);
    const own = [];
    const shadow = box.w && box.h ? shadowFilter(cs, box) : '';
    const hasBg = !transparent(cs.backgroundColor);
    if (hasBg) own.push(shapeTag(box, rs, `${paint(cs.backgroundColor)}${shadow}`, 'fill'));
    if (cs.backgroundImage && cs.backgroundImage !== 'none' && box.w && box.h) {
      const layers = splitTop(cs.backgroundImage).reverse();
      const clipId = rs.some(Boolean) ? uid('bgclip') : null;
      if (clipId) defs.push(`<clipPath id="${clipId}">${shapeTag(box, rs, '', 'clip')}</clipPath>`);
      const parts = [];
      for (const layer of layers) parts.push(await bgLayer(layer, box, (attrs, n) => shapeTag(box, [0, 0, 0, 0], attrs, n)));
      own.push(`<g id="${layerId('background')}"${clipId ? ` clip-path="url(#${clipId})"` : ''}${!hasBg ? shadow : ''}>${parts.join('')}</g>`);
    }
    // рамка
    const bw = ['Top', 'Right', 'Bottom', 'Left'].map((s) => parseFloat(cs[`border${s}Width`]) || 0);
    const bc = ['Top', 'Right', 'Bottom', 'Left'].map((s) => cs[`border${s}Color`]);
    const bs = ['Top', 'Right', 'Bottom', 'Left'].map((s) => cs[`border${s}Style`]);
    if (bw.every((v) => v === bw[0]) && bw[0] > 0 && bc.every((c) => c === bc[0]) && bs[0] !== 'none' && !transparent(bc[0])) {
      const b = bw[0];
      own.push(shapeTag({ x: box.x + b / 2, y: box.y + b / 2, w: box.w - b, h: box.h - b }, rs.map((v) => Math.max(0, v - b / 2)), `fill="none" ${paint(bc[0], 'stroke')} stroke-width="${b}"${bs[0] === 'dashed' ? ` stroke-dasharray="${b * 4} ${b * 3}"` : ''}`, 'border'));
    } else {
      const strips = [
        [box.x, box.y, box.w, bw[0]],
        [box.x + box.w - bw[1], box.y, bw[1], box.h],
        [box.x, box.y + box.h - bw[2], box.w, bw[2]],
        [box.x, box.y, bw[3], box.h],
      ];
      strips.forEach(([x, y, w, h], i) => {
        if (bw[i] > 0 && bs[i] !== 'none' && !transparent(bc[i])) own.push(shapeTag({ x, y, w, h }, [0, 0, 0, 0], paint(bc[i]), `border ${['top', 'right', 'bottom', 'left'][i]}`));
      });
    }

    const kids = [];
    if (el.tagName === 'CANVAS') {
      try {
        kids.push(`<image id="${layerId(el.getAttribute('aria-label') || 'skin')}" x="${num(box.x)}" y="${num(box.y)}" width="${num(box.w)}" height="${num(box.h)}" xlink:href="${el.toDataURL('image/png')}"/>`);
      } catch {}
    } else if (el.tagName === 'IMG') {
      kids.push(await imageTag(el, box, cs));
    } else if (el.tagName === 'svg') {
      kids.push(inlineSvg(el, box));
    } else if (['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)) {
      if (['checkbox', 'radio'].includes(el.type) && cs.appearance === 'none') {
        // Свой вид флажка уже нарисован как блок (фон, рамка), остаётся галочка.
        if (el.checked && el.type === 'checkbox') kids.push(`<path id="${layerId('check')}" d="M${num(box.x + box.w * 0.27)} ${num(box.y + box.h * 0.5)}L${num(box.x + box.w * 0.43)} ${num(box.y + box.h * 0.66)}L${num(box.x + box.w * 0.74)} ${num(box.y + box.h * 0.35)}" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>`);
      } else if (['file', 'range', 'color', 'button', 'submit', 'reset', 'image'].includes(el.type)) {
        // не рисуем
      } else if (['checkbox', 'radio'].includes(el.type)) {
        const accent = cs.accentColor === 'auto' ? '#1aa3e0' : cs.accentColor;
        kids.push(shapeTag(box, el.type === 'radio' ? [box.w / 2, box.w / 2, box.w / 2, box.w / 2] : [3, 3, 3, 3], el.checked ? paint(accent) : 'fill="none" stroke="#9a9a9a" stroke-width="1.5"', el.type));
        if (el.checked && el.type === 'checkbox') kids.push(`<path id="${layerId('check')}" d="M${num(box.x + box.w * 0.22)} ${num(box.y + box.h * 0.52)}L${num(box.x + box.w * 0.42)} ${num(box.y + box.h * 0.72)}L${num(box.x + box.w * 0.78)} ${num(box.y + box.h * 0.3)}" fill="none" stroke="#fff" stroke-width="2"/>`);
      } else kids.push(fieldText(el, cs, box));
    } else {
      for (const child of paintOrder(el)) {
        if (child.nodeType === Node.TEXT_NODE) kids.push(textNode(child, cs, ox, oy));
        else kids.push(await walk(child, ox, oy));
      }
    }
    let inner = kids.filter(Boolean).join('');
    if (inner && el.tagName !== 'svg' && (cs.overflow !== 'visible' || cs.overflowX !== 'visible') && box.w && box.h && el !== root) {
      const id = uid('clip');
      defs.push(`<clipPath id="${id}">${shapeTag(box, rs, '', 'clip')}</clipPath>`);
      inner = `<g id="${layerId('content')}" clip-path="url(#${id})">${inner}</g>`;
    }
    const body = own.join('') + inner;
    if (!body) return '';
    const op = +cs.opacity < 1 ? ` opacity="${cs.opacity}"` : '';
    return `<g id="${layerId(nameOf(el))}"${op}>${body}</g>`;
  }

  const restore = materialize(root);
  try {
  // Рамка макета: сам элемент и всё, что из него торчит (голова скина над карточкой и т. п.).
  const rr = root.getBoundingClientRect();
  let [x1, y1, x2, y2] = [rr.left, rr.top, rr.right, rr.bottom];
  const clipped = (el) => {
    for (let p = el.parentElement; p && p !== root; p = p.parentElement) if (getComputedStyle(p).overflow !== 'visible') return true;
    return false;
  };
  for (const el of root.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height || clipped(el) || getComputedStyle(el).display === 'none') continue;
    [x1, y1, x2, y2] = [Math.min(x1, r.left), Math.min(y1, r.top), Math.max(x2, r.right), Math.max(y2, r.bottom)];
  }
  const ox = x1 - pad;
  const oy = y1 - pad;
  const w = Math.ceil(x2 - x1 + pad * 2);
  const h = Math.ceil(y2 - y1 + pad * 2);
  let pageBg = getComputedStyle(document.body).backgroundColor;
  if (transparent(pageBg)) pageBg = getComputedStyle(document.documentElement).backgroundColor;
  const body = await walk(root, ox, oy);
  return { name, w, h, defs: defs.join(''), body: `<rect id="${layerId('page background')}" width="${w}" height="${h}" ${paint(pageBg)}/>${body}` };
  } finally {
    restore();
  }
}

/* ------------------------------------------------------------ запуск */

function recolorSkin(hue) {
  // Стандартный скин с перекрашенной одеждой: у каждого выдуманного игрока свой.
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = img.width;
      c.height = img.height;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(0, 0, c.width, c.height);
      // Верхние 16 строк файла — голова и шапка: лицо и глаза не трогаем.
      for (let i = c.width * 16 * 4; i < d.data.length; i += 4) {
        const [r, gg, b] = [d.data[i] / 255, d.data[i + 1] / 255, d.data[i + 2] / 255];
        const max = Math.max(r, gg, b);
        const min = Math.min(r, gg, b);
        const l = (max + min) / 2;
        const s = max === min ? 0 : l > 0.5 ? (max - min) / (2 - max - min) : (max - min) / (max + min);
        let hh = 0;
        if (max !== min) hh = max === r ? ((gg - b) / (max - min) + (gg < b ? 6 : 0)) * 60 : max === gg ? ((b - r) / (max - min) + 2) * 60 : ((r - gg) / (max - min) + 4) * 60;
        if (s < 0.25 || (hh > 5 && hh < 50)) continue; // кожа, волосы, серое — как было
        hh = (hh + hue) % 360;
        const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        const p = 2 * l - q;
        const f = (t) => {
          t = (t + 1) % 1;
          return t < 1 / 6 ? p + (q - p) * 6 * t : t < 1 / 2 ? q : t < 2 / 3 ? p + (q - p) * (2 / 3 - t) * 6 : p;
        };
        d.data[i] = Math.round(f(hh / 360 + 1 / 3) * 255);
        d.data[i + 1] = Math.round(f(hh / 360) * 255);
        d.data[i + 2] = Math.round(f(hh / 360 - 1 / 3) * 255);
      }
      g.putImageData(d, 0, 0);
      resolve(c.toDataURL('image/png').split(',')[1]);
    };
    img.onerror = reject;
    img.src = '/assets/img/skin-default.png';
  });
}

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwl-figma-'));
const app = createApp(loadConfig({ LWL_DATA_DIR: dataDir, LWL_ADMINS: 'owner@lwl.example', LWL_FAST_HASH: '1', LWL_GAME_TOKEN: TOKEN, LWL_TRUST_PROXY: '1' }));
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${app.server.address().port}`;
const browser = await chromium.launch(args.channel ? { channel: args.channel } : {});

let ip = 0;
function client() {
  const me = { cookie: '', ip: `10.42.0.${++ip}` };
  me.call = async (method, url, body, headers = {}) => {
    const h = { 'X-Requested-With': 'lwl', 'X-Real-IP': me.ip, ...headers };
    if (me.cookie) h.Cookie = me.cookie;
    let payload;
    if (Buffer.isBuffer(body)) payload = body;
    else if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(BASE + url, { method, headers: h, body: payload });
    for (const c of res.headers.getSetCookie()) me.cookie = c.split(';')[0];
    const data = (res.headers.get('content-type') || '').includes('json') ? await res.json() : null;
    if (res.status >= 400) throw new Error(`${method} ${url}: ${res.status} ${JSON.stringify(data)}`);
    return data;
  };
  return me;
}

try {
  const scratch = await browser.newPage();
  await scratch.goto(BASE + '/players.html');

  const owner = client();
  await owner.call('POST', '/api/auth/register', { nickname: 'Owner_1', email: 'owner@lwl.example', password: 'Passw0rd1' });
  const users = {};
  for (const p of PEOPLE) {
    const c = client();
    await c.call('POST', '/api/auth/register', { nickname: p.nick, email: `${p.nick.toLowerCase()}@lwl.example`, password: 'Passw0rd1' });
    app.db.prepare("UPDATE users SET role = 'player' WHERE nickname = ?").run(p.nick);
    users[p.nick] = c;
  }
  const game = (url, data) => fetch(BASE + url, { method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'X-Requested-With': 'lwl', 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
  await game('/api/game/stats', { players: [...PEOPLE.map((p) => ({ nickname: p.nick, ...p.stats })), { nickname: 'Owner_1', playTimeSec: 300 * HOUR, deaths: 12, mobKills: 900, playerKills: 0, blocksMined: 52000, distanceM: 90000, advancements: 61 }] });
  await game('/api/game/presence', { players: PEOPLE.filter((p) => p.online).map((p) => p.nick) });
  for (const p of PEOPLE) {
    const c = users[p.nick];
    await c.call('PATCH', '/api/me/card', { pose: p.pose, background: p.bg, bio: p.bio, socials: p.socials, ...(p.hide ? { hideFields: p.hide } : {}) });
    if (p.skin !== false) {
      const png = Buffer.from(await scratch.evaluate(recolorSkin, p.hue), 'base64');
      await c.call('PUT', '/api/me/skin', png, { 'Content-Type': 'application/octet-stream', 'X-Skin-Model': p.slim ? 'slim' : 'classic' });
    }
    if (p.seenAgo) app.db.prepare('UPDATE player_stats SET last_seen = ?, online = 0 WHERE nick_key = ?').run(Date.now() - p.seenAgo * 1000, p.nick.toLowerCase());
  }
  await owner.call('PATCH', '/api/me/card', { bio: 'Слежу за порядком на сервере', socials: { telegram: 'lwl_owner' } });
  await scratch.close();

  /* съёмка */
  const frames = [];
  async function page({ cookieOf, width = 1280, height = 900 }) {
    const ctx = await browser.newContext({ viewport: { width, height }, reducedMotion: 'reduce' });
    if (cookieOf) {
      const [name, value] = cookieOf.cookie.split('=');
      await ctx.addCookies([{ name, value, url: BASE }]);
    }
    const p = await ctx.newPage();
    p.on('pageerror', (e) => console.error('Ошибка на странице:', e.message));
    return p;
  }
  async function shoot(p, selector, name, pad = 24) {
    await p.waitForSelector(selector);
    await p.waitForTimeout(400);
    // Курсор и фокус не должны попасть в макет.
    await p.mouse.move(0, 0);
    await p.evaluate(() => document.activeElement?.blur());
    frames.push(await p.evaluate(domToSvg, { selector, name, pad }));
    console.log(`  ✓ ${name}`);
  }
  const waitCards = (p, n) => p.waitForFunction((k) => document.querySelectorAll('.pcard canvas').length >= k, n);

  console.log('Снимаю макеты…');
  const player = await page({ cookieOf: users.Hawk_1 });
  await player.goto(BASE + '/players.html');
  await waitCards(player, PEOPLE.length);
  await shoot(player, '.pcard[data-nick="Hawk_1"]', 'Карточка — в сети, со званиями');
  await shoot(player, '.pcard[data-nick="Snow_Fox"]', 'Карточка — не в сети');
  await shoot(player, '.pcard[data-nick="Owner_1"]', 'Карточка — администратор');
  await shoot(player, '.pcard[data-nick="Steve_2"]', 'Карточка — без «о себе» и своего скина');
  await shoot(player, 'main', 'Страница «Игроки» — видит игрок', 0);
  await player.click('.pcard[data-nick="Hawk_1"] .pcard__open');
  await player.waitForSelector('.modal__dialog .skin3d canvas');
  const pause = player.locator('.modal__dialog button:has-text("Пауза")');
  if (await pause.count()) await pause.click();
  await shoot(player, '.modal__dialog', 'Окно игрока');
  await player.keyboard.press('Escape');

  const guest = await page({});
  await guest.goto(BASE + '/players.html');
  await waitCards(guest, PEOPLE.length);
  await shoot(guest, '.pcard[data-nick="Hawk_1"]', 'Карточка — видит гость');
  await shoot(guest, 'main', 'Страница «Игроки» — видит гость', 0);

  const phone = await page({ cookieOf: users.Hawk_1, width: 320, height: 700 });
  await phone.goto(BASE + '/players.html');
  await waitCards(phone, PEOPLE.length);
  await shoot(phone, '.pcard[data-nick="Hawk_1"]', 'Телефон 320 — карточка', 16);

  await player.goto(BASE + '/lk.html#/profile');
  await player.waitForSelector('.my-card .chip');
  await player.waitForTimeout(600);
  await shoot(player, '.my-card', 'Кабинет — «Моя карточка»');

  /* запись */
  fs.mkdirSync(OUT, { recursive: true });
  for (const f of fs.readdirSync(OUT)) if (f.endsWith('.svg')) fs.rmSync(path.join(OUT, f));
  const slug = (s) => s.toLowerCase().replace(/[«»]/g, '').replace(/[^a-zа-яё0-9]+/gi, '-').replace(/^-|-$/g, '');
  const head = (w, h) => `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" fill="none">`;
  frames.forEach((f, i) => {
    const file = `${String(i + 1).padStart(2, '0')}-${slug(f.name)}.svg`;
    fs.writeFileSync(path.join(OUT, file), `${head(f.w, f.h)}<defs>${f.defs}</defs><g id="${f.name}">${f.body}</g></svg>\n`);
  });
  // Общий холст: ряды по ~3600px, над каждым макетом — подпись.
  const GAP = 120;
  let x = 0;
  let y = 60;
  let rowH = 0;
  let W = 0;
  const placed = [];
  for (const f of frames) {
    if (x && x + f.w > 3600) {
      x = 0;
      y += rowH + GAP + 60;
      rowH = 0;
    }
    placed.push({ f, x, y });
    x += f.w + GAP;
    rowH = Math.max(rowH, f.h);
    W = Math.max(W, x - GAP);
  }
  const H = y + rowH;
  // id в defs у каждого макета свои (lg-1 и т. п.) — в общем файле добавляем префикс, чтобы не пересеклись.
  const all = placed
    .map(({ f, x: fx, y: fy }, i) => {
      const pre = `f${i + 1}-`;
      const fix = (s) => s.replace(/id="((?:lg|rg|bgclip|clip|shadow)-\d+)"/g, `id="${pre}$1"`).replace(/url\(#((?:lg|rg|bgclip|clip|shadow)-\d+)\)/g, `url(#${pre}$1)`);
      return {
        defs: fix(f.defs),
        body: `<text id="Подпись: ${f.name}" x="${fx}" y="${fy - 20}" font-family="Inter" font-size="24" font-weight="600" fill="#9aa4ad">${f.name}</text><g id="${f.name}" transform="translate(${fx} ${fy})">${fix(f.body)}</g>`,
      };
    });
  fs.writeFileSync(path.join(OUT, 'lwl-cards.svg'), `${head(W, H)}<defs>${all.map((a) => a.defs).join('')}</defs><rect id="Холст" width="${W}" height="${H}" fill="#1b1b1b"/>${all.map((a) => a.body).join('')}</svg>\n`);
  console.log(`Готово: ${path.relative(ROOT, OUT)} (${frames.length} макетов + lwl-cards.svg)`);
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}
