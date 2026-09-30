#!/usr/bin/env node
/**
 * Сравнение сайта с макетом Figma.
 *
 *   npm install && npx playwright install chromium
 *   npm run compare
 *
 * Снимает 5 экранов в разрешении макета (1920px) с такими же данными, как в Figma
 * (ник PAY4IL0, аватар из макета), и сравнивает их попиксельно с design/figma/frames/*.png.
 * Результат: design/compare/out/<экран>-site.png и <экран>-diff.png + процент отличий в консоли.
 * Лента сообщений в чатах перед снимком очищается — в макете она пустая.
 */
import { chromium } from 'playwright';
import { PNG } from 'pngjs';
import pixelmatch from 'pixelmatch';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from './static-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'design/compare/out');
const FRAMES = path.join(ROOT, 'design/figma/frames');

const server = await serve(0);
const BASE = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch();
await mkdir(OUT, { recursive: true });

async function shot(page, name, fullPage = false) {
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(500);
  await page.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
  const file = path.join(OUT, `${name}-site.png`);
  await page.screenshot({ path: file, fullPage });
  return file;
}

// Аватар из макета: слой «STREAM 1» (200×200, кадрирование как в Figma) на сером фоне #d9d9d9.
async function setDesignAvatar(page) {
  await page.evaluate(async () => {
    const img = new Image();
    img.src = 'design/figma/originals/avatar-stream.png';
    await img.decode();
    const c = document.createElement('canvas');
    c.width = c.height = 400;
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#d9d9d9';
    ctx.fillRect(0, 0, 400, 400);
    const w = 400 * 2.6785;
    const h = 400 * 1.13;
    ctx.drawImage(img, -400 * 0.6818, -400 * 0.13, w, h);
    await Api.profile.update({ avatar: c.toDataURL('image/webp', 0.92) });
  });
}

async function account(page, nickname, email) {
  await page.goto(`${BASE}/lk.html`);
  await page.waitForSelector('.auth-dialog');
  await page.evaluate(({ nickname, email }) => Api.auth.register({ nickname, email, password: 'Compare123', remember: false }), { nickname, email });
  await setDesignAvatar(page);
}

async function open(page, hash, selector) {
  await page.goto(`${BASE}/lk.html${hash}`);
  await page.reload();
  await page.waitForSelector(selector);
}

const shots = {};

// Лендинг
{
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto(`${BASE}/index.html`, { waitUntil: 'networkidle' });
  shots.landing = await shot(page, 'landing', true);
  await page.close();
}

// Кабинет и чаты
{
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 993 } });
  const pay = await ctx.newPage();
  const hawk = await ctx.newPage();
  await account(pay, 'PAY4IL0', 'pay@example.com');
  await account(hawk, '__Hawker__', 'hawk@example.com');

  await open(pay, '#/', '.dash');
  shots['lk-player'] = await shot(pay, 'lk-player');

  await pay.evaluate(() => Api.profile.setDemoRole('admin'));
  await open(pay, '#/', '.dash');
  shots['lk-admin'] = await shot(pay, 'lk-admin');

  // Frame 5: я — __Hawker__ (игрок), собеседник — PAY4IL0 (админ, в сети)
  const conv = await hawk.evaluate(async () => {
    const c = await Api.chats.support();
    await Api.chats.send(c.id, { text: 'Привет!' });
    return c.id;
  });
  await pay.evaluate((id) => Api.chats.send(id, { text: 'Привет, чем помочь?' }), conv);
  await open(hawk, '#/support', '.msg');
  await hawk.evaluate(() => document.querySelector('.chat__list').replaceChildren());
  shots['chat-player'] = await shot(hawk, 'chat-player');

  // Frame 6: я — __Hawker__ (админ), собеседник — PAY4IL0 (игрок)
  await pay.evaluate(async () => {
    await Api.profile.setDemoRole('player');
    const c = await Api.chats.support();
    await Api.chats.send(c.id, { text: 'Вопрос по серверу' });
  });
  await hawk.evaluate(() => Api.profile.setDemoRole('admin'));
  const ticket = await hawk.evaluate(async () => (await Api.chats.list({ status: 'all' })).find((c) => c.player && c.player.nickname === 'PAY4IL0').id);
  await open(hawk, `#/admin/tickets/${ticket}`, '.msg');
  await hawk.evaluate(() => {
    document.querySelector('.chat__list').replaceChildren();
    document.querySelector('.panel__head-actions').replaceChildren();
  });
  shots['chat-admin'] = await shot(hawk, 'chat-admin');
  await ctx.close();
}

await browser.close();
server.close();

console.log('Экран          отличающихся пикселей');
for (const [name, file] of Object.entries(shots)) {
  const design = PNG.sync.read(await readFile(path.join(FRAMES, `${name}.png`)));
  const site = PNG.sync.read(await readFile(file));
  const width = Math.min(design.width, site.width);
  const height = Math.min(design.height, site.height);
  const crop = (png) => {
    const out = new PNG({ width, height });
    PNG.bitblt(png, out, 0, 0, width, height, 0, 0);
    return out;
  };
  const a = crop(design);
  const b = crop(site);
  const diff = new PNG({ width, height });
  const n = pixelmatch(a.data, b.data, diff.data, width, height, { threshold: 0.1 });
  await writeFile(path.join(OUT, `${name}-diff.png`), PNG.sync.write(diff));
  console.log(`${name.padEnd(14)} ${((n / (width * height)) * 100).toFixed(2)}%`);
}
console.log(`\nСнимки и карты отличий: ${path.relative(ROOT, OUT)}/`);
