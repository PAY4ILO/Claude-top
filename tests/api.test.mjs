/**
 * Тесты API сервера сайта (без браузера): npm run test:api
 * Каждый запуск — чистая временная база.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { crc32, deflateSync } from 'node:zlib';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

let app;
let base;
let dataDir;
const GAME_TOKEN = 'game-token-for-tests-0123456789';

// Поддельный textures.minecraft.net: сайт качает скины только отсюда (в тестах — без интернета).
const SKIN_PNG = fs.readFileSync(new URL('../assets/img/skin-default.png', import.meta.url));
const textureHits = [];
const textures = http.createServer((req, res) => {
  textureHits.push(req.url);
  if (req.url === '/texture/badbadbadbadbad0') return res.writeHead(200, { 'Content-Type': 'image/png' }).end('<html>не картинка</html>');
  if (req.url === '/texture/b16b16b16b16b16b') return res.writeHead(200, { 'Content-Type': 'image/png' }).end(Buffer.concat([SKIN_PNG, Buffer.alloc(70 * 1024)]));
  if (/^\/texture\/[0-9a-f]+$/.test(req.url)) return res.writeHead(200, { 'Content-Type': 'image/png' }).end(SKIN_PNG);
  res.writeHead(404).end();
});
let texturesOrigin;

// Поддельный Mojang: ник → UUID (api.mojang.com / api.minecraftservices.com) → профиль с текстурами (sessionserver).
const NOTCH_ID = '069a79f444e94726a5befca90e38aaf5';
const PLAIN_ID = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const FLAKY_ID = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const mojangHits = [];
const mojang = http.createServer((req, res) => {
  mojangHits.push(req.url);
  const json = (code, body) => res.writeHead(code, { 'Content-Type': 'application/json' }).end(JSON.stringify(body));
  const names = { notch: { id: NOTCH_ID, name: 'Notch' }, plainguy: { id: PLAIN_ID, name: 'PlainGuy' } };
  let m = /^\/users\/profiles\/minecraft\/(\w+)$/.exec(req.url);
  if (m) {
    if (m[1] === 'flaky') return res.writeHead(503).end();
    if (m[1] === 'busy') return res.writeHead(429).end();
    return names[m[1]] ? json(200, names[m[1]]) : json(404, { errorMessage: 'not found' });
  }
  m = /^\/minecraft\/profile\/lookup\/name\/(\w+)$/.exec(req.url);
  if (m) return m[1] === 'flaky' ? json(200, { id: FLAKY_ID, name: 'Flaky' }) : json(404, {});
  m = /^\/session\/minecraft\/profile\/([0-9a-f]{32})$/.exec(req.url);
  if (m) {
    const skin = { [NOTCH_ID]: { url: `${texturesOrigin}/texture/a0a0a0a0a0a0a0a0`, metadata: { model: 'slim' } }, [FLAKY_ID]: { url: `${texturesOrigin}/texture/f1f1f1f1f1f1f1f1` } }[m[1]];
    const textures = Buffer.from(JSON.stringify({ textures: skin ? { SKIN: skin } : {} })).toString('base64');
    return json(200, { id: m[1], name: 'x', properties: [{ name: 'textures', value: textures }] });
  }
  res.writeHead(404).end();
});
let mojangConfig;

before(async () => {
  await new Promise((r) => textures.listen(0, '127.0.0.1', r));
  texturesOrigin = `http://127.0.0.1:${textures.address().port}`;
  await new Promise((r) => mojang.listen(0, '127.0.0.1', r));
  const mojangOrigin = `http://127.0.0.1:${mojang.address().port}`;
  mojangConfig = { api: mojangOrigin, servicesApi: mojangOrigin, session: mojangOrigin };
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwl-api-'));
  // LWL_TRUST_PROXY — чтобы тесты кодов входа подставляли разные IP (X-Real-IP) и не упирались в лимит по IP.
  const config = loadConfig({ LWL_DATA_DIR: dataDir, LWL_ADMINS: 'owner@example.com', LWL_FAST_HASH: '1', LWL_MAX_UPLOAD_MB: '1', LWL_CHAT_MAX_FILE_MB: '1', LWL_GAME_TOKEN: GAME_TOKEN, LWL_TRUST_PROXY: '1' });
  config.skinOrigin = texturesOrigin;
  config.mojang = mojangConfig;
  app = createApp(config);
  // Стандартный скин (Стив) сайт качает сам при первой карточке без скина; здесь — сразу, чтобы счётчики запросов не плавали.
  assert.ok(await app.skins.loadDefault());
  assert.ok(textureHits.includes('/texture/31f477eb1a7beee631c2ca64d06f8f68fa93a3386d04452ab27f43acdf1b60cb'));
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
  textures.close();
  mojang.close();
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

/** Клиент с отдельными куками — как отдельный браузер. */
function client() {
  let jar = '';
  async function call(method, url, body, headers = {}) {
    const h = Object.assign({ 'X-Requested-With': 'lwl' }, headers);
    if (jar) h.Cookie = jar;
    let payload;
    if (body instanceof Uint8Array) payload = body;
    else if (body !== undefined) {
      h['Content-Type'] = 'application/json';
      payload = JSON.stringify(body);
    }
    const res = await fetch(base + url, { method, headers: h, body: payload, redirect: 'manual' });
    const set = res.headers.getSetCookie();
    for (const c of set) {
      const [pair] = c.split(';');
      const [k, v] = pair.split('=');
      jar = v ? `${k}=${v}` : '';
    }
    const type = res.headers.get('content-type') || '';
    const data = type.includes('json') ? await res.json() : Buffer.from(await res.arrayBuffer());
    return { status: res.status, data, headers: res.headers };
  }
  return {
    get: (u, h) => call('GET', u, undefined, h),
    post: (u, b, h) => call('POST', u, b, h),
    patch: (u, b) => call('PATCH', u, b),
    put: (u, b, h) => call('PUT', u, b, h),
    del: (u, b) => call('DELETE', u, b),
    raw: call,
    cookie: () => jar,
  };
}

const owner = client();
const alice = client();
const bob = client();
const application = { age: 17, license: 'cracked', source: 'Друзья', about: 'Люблю строить большие города и играть с друзьями по вечерам.', contact: '@alice', agree: true };
// минимальный zip: заголовок локального файла + пустой архив
const ZIP = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(60, 1)]);
const PNG = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');

let aliceApp;
let conversation;
let packId;

test('регистрация: роль «Пользователь», владелец — сразу админ', async () => {
  const r1 = await owner.post('/api/auth/register', { nickname: 'Owner_1', email: 'OWNER@example.com', password: 'Passw0rd1', remember: true });
  assert.equal(r1.status, 200);
  assert.equal(r1.data.user.role, 'admin');
  assert.equal(r1.data.user.creator, true);
  assert.deepEqual(r1.data.user.permissions, ['applications', 'tickets', 'users', 'server', 'delete', 'admins']);
  const r2 = await alice.post('/api/auth/register', { nickname: 'Alice_07', email: 'alice@example.com', password: 'Passw0rd1' });
  assert.equal(r2.data.user.role, 'user');
  assert.equal(r2.data.user.email, 'alice@example.com');
  const r3 = await bob.post('/api/auth/register', { nickname: 'bob_builder', email: 'bob@example.com', password: 'Passw0rd1' });
  assert.equal(r3.status, 200);
});

test('регистрация: занятые ник и почта, валидация', async () => {
  const c = client();
  assert.equal((await c.post('/api/auth/register', { nickname: 'alice_07', email: 'x@example.com', password: 'Passw0rd1' })).data.code, 'NICK_TAKEN');
  assert.equal((await c.post('/api/auth/register', { nickname: 'Other', email: 'ALICE@example.com', password: 'Passw0rd1' })).data.code, 'EMAIL_TAKEN');
  const bad = await c.post('/api/auth/register', { nickname: 'a b', email: 'nope', password: 'short' });
  assert.equal(bad.status, 422);
  assert.deepEqual(Object.keys(bad.data.fields).sort(), ['email', 'nickname', 'password']);
});

test('защита от CSRF: без заголовка и с чужого сайта — отказ', async () => {
  const r1 = await fetch(base + '/api/auth/logout', { method: 'POST' });
  assert.equal(r1.status, 403);
  const r2 = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { 'X-Requested-With': 'lwl', Origin: 'https://evil.example' } });
  assert.equal(r2.status, 403);
});

test('вход: неверный пароль, блокировка после 5 попыток, вход по почте', async () => {
  const c = client();
  for (let i = 0; i < 5; i++) assert.equal((await c.post('/api/auth/login', { login: 'bob_builder', password: 'wrong' })).data.code, 'INVALID_CREDENTIALS');
  const locked = await c.post('/api/auth/login', { login: 'bob_builder', password: 'Passw0rd1' });
  assert.equal(locked.status, 429);
  assert.match(locked.data.message, /Слишком много/);
  const byEmail = await c.post('/api/auth/login', { login: 'ALICE@example.com', password: 'Passw0rd1' });
  assert.equal(byEmail.data.user.nickname, 'Alice_07');
  assert.equal((await c.get('/api/auth/me')).data.user.nickname, 'Alice_07');
  await c.post('/api/auth/logout');
  assert.equal((await c.get('/api/auth/me')).status, 401);
});

test('до одобрения вкладка «Сервер» закрыта', async () => {
  const r = await alice.get('/api/me/server');
  assert.equal(r.status, 403);
});

test('заявка: лицензия обязательна; подача; повторная — конфликт', async () => {
  const bad = await alice.post('/api/applications', Object.assign({}, application, { license: '' }));
  assert.equal(bad.status, 422);
  assert.ok(bad.data.fields.license);
  const ok = await alice.post('/api/applications', application);
  assert.equal(ok.status, 200);
  aliceApp = ok.data.application;
  assert.equal(aliceApp.license, 'cracked');
  assert.equal(aliceApp.status, 'pending');
  assert.equal((await alice.post('/api/applications', application)).status, 409);
  assert.equal((await alice.get('/api/applications/mine')).data.application.id, aliceApp.id);
});

test('заявки видит только админ; одобрение делает игроком', async () => {
  assert.equal((await alice.get('/api/applications')).status, 403);
  const list = await owner.get('/api/applications?status=pending');
  assert.equal(list.data.items.length, 1);
  assert.equal(list.data.counts.pending, 1);
  const noReason = await owner.post(`/api/applications/${aliceApp.id}/review`, { status: 'rejected', comment: '' });
  assert.equal(noReason.status, 422);
  const ok = await owner.post(`/api/applications/${aliceApp.id}/review`, { status: 'approved', comment: 'Добро пожаловать!' });
  assert.equal(ok.data.application.status, 'approved');
  assert.equal(ok.data.application.history.length, 2);
  assert.equal((await alice.get('/api/auth/me')).data.user.role, 'player');
});

test('игрок не может сам сменить ник (он в вайтлисте), пользователь — может', async () => {
  const r = await alice.patch('/api/me', { nickname: 'Alice_08' });
  assert.equal(r.status, 422);
  assert.match(r.data.fields.nickname, /привязан к серверу/);
  const b = await bob.patch('/api/me', { nickname: 'Bob_Builder2' });
  assert.equal(b.data.user.nickname, 'Bob_Builder2');
});

test('аватар: только настоящие картинки, отдаётся по ссылке', async () => {
  const fake = await alice.patch('/api/me', { avatar: 'data:image/png;base64,' + Buffer.from('not an image at all').toString('base64') });
  assert.equal(fake.status, 422);
  const ok = await alice.patch('/api/me', { avatar: 'data:image/png;base64,' + PNG.toString('base64') });
  const url = ok.data.user.avatar;
  assert.match(url, /^\/api\/avatars\//);
  const img = await alice.get(url);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal((await alice.patch('/api/me', { avatar: null })).data.user.avatar, null);
});

test('поддержка: переписка, автоответ, непрочитанное, закрытие', async () => {
  conversation = (await alice.post('/api/support/conversation')).data.conversation;
  assert.equal((await owner.get('/api/conversations')).data.items.length, 0, 'пустое обращение админу не показывается');
  const sent = await alice.post(`/api/conversations/${conversation.id}/messages`, { text: 'Привет! <b>Не могу</b> зайти', clientId: 'c1' });
  assert.equal(sent.status, 200);
  const again = await alice.post(`/api/conversations/${conversation.id}/messages`, { text: 'Привет! <b>Не могу</b> зайти', clientId: 'c1' });
  assert.equal(again.data.message.id, sent.data.message.id, 'повтор с тем же clientId не создаёт дубль');
  const msgs = (await alice.get(`/api/conversations/${conversation.id}/messages`)).data.items;
  assert.equal(msgs.length, 2);
  assert.equal(msgs[1].system, true);
  assert.equal((await owner.get('/api/me/summary')).data.unreadConversations, 1);
  assert.equal((await bob.get(`/api/conversations/${conversation.id}`)).status, 404, 'чужое обращение не видно');
  await owner.post(`/api/conversations/${conversation.id}/messages`, { text: 'Сейчас посмотрю', clientId: 'a1' });
  assert.equal((await alice.get('/api/me/summary')).data.unreadMessages, 1);
  await alice.post(`/api/conversations/${conversation.id}/read`);
  assert.equal((await alice.get('/api/me/summary')).data.unreadMessages, 0);
  const view = (await alice.get(`/api/conversations/${conversation.id}`)).data.conversation;
  assert.equal(view.partner.nickname, 'Owner_1');
  await owner.post(`/api/conversations/${conversation.id}/close`);
  assert.equal((await owner.get('/api/conversations?status=closed')).data.items.length, 1);
});

/* ------------------------------------------------------------ фото и файлы в чате */

const attach = (who, convId, data, name, headers = {}) =>
  who.put(`/api/conversations/${convId}/attachments`, data, Object.assign({ 'X-File-Name': encodeURIComponent(name), 'Content-Type': 'application/octet-stream' }, headers));
const attachmentFile = (id) => path.join(dataDir, 'attachments', id);
const aliceFiles = [];
let photoAtt;
let logAtt;

/** Минимальный JPEG: SOI, (EXIF с поворотом), SOF0 с размером, EOI. */
function tinyJpeg(width, height, orientation) {
  const parts = [Buffer.from([0xff, 0xd8])];
  if (orientation) {
    const tiff = Buffer.alloc(26);
    tiff.write('II', 0, 'latin1');
    tiff.writeUInt16LE(42, 2);
    tiff.writeUInt32LE(8, 4);
    tiff.writeUInt16LE(1, 8);
    tiff.writeUInt16LE(0x0112, 10);
    tiff.writeUInt16LE(3, 12);
    tiff.writeUInt32LE(1, 14);
    tiff.writeUInt16LE(orientation, 18);
    const body = Buffer.concat([Buffer.from('Exif\0\0', 'latin1'), tiff]);
    const seg = Buffer.from([0xff, 0xe1, 0, 0]);
    seg.writeUInt16BE(body.length + 2, 2);
    parts.push(seg, body);
  }
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, 0, 0, 0, 0, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  sof.writeUInt16BE(height, 5);
  sof.writeUInt16BE(width, 7);
  parts.push(sof, Buffer.from([0xff, 0xd9]));
  return Buffer.concat(parts);
}

test('поддержка: поток событий чата (SSE) — новое сообщение и «прочитано»; чужому и без входа — нет', async () => {
  const url = `/api/conversations/${conversation.id}/events`;
  assert.equal((await bob.get(url)).status, 404);
  assert.equal((await client().get(url)).status, 401);
  const ac = new AbortController();
  const res = await fetch(base + url, { headers: { Cookie: alice.cookie() }, signal: ac.signal });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /text\/event-stream/);
  assert.equal(res.headers.get('x-accel-buffering'), 'no');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  async function waitFor(re) {
    const deadline = Date.now() + 3000;
    while (!re.test(buf)) {
      const left = deadline - Date.now();
      if (left <= 0) throw new Error('нет события, пришло: ' + JSON.stringify(buf));
      const chunk = await Promise.race([reader.read(), new Promise((r) => setTimeout(() => r(null), left))]);
      if (chunk && chunk.done) throw new Error('поток закрылся');
      if (chunk) buf += decoder.decode(chunk.value);
    }
    buf = '';
  }
  try {
    await waitFor(/retry: \d+/);
    await owner.post(`/api/conversations/${conversation.id}/messages`, { text: 'Проверка потока', clientId: 'sse1' });
    await waitFor(/event: change/);
    await alice.post(`/api/conversations/${conversation.id}/read`);
    await owner.post(`/api/conversations/${conversation.id}/read`);
    await waitFor(/event: change/);
  } finally {
    ac.abort();
  }
});

test('вложения: картинка узнаётся по первым байтам, размер — с учётом поворота фото', async () => {
  const { sniffImage, cleanFileName } = await import('../server/lib/files.js');
  assert.deepEqual(sniffImage(PNG), { mime: 'image/png', width: 1, height: 1 });
  assert.deepEqual(sniffImage(tinyJpeg(200, 100)), { mime: 'image/jpeg', width: 200, height: 100 });
  assert.deepEqual(sniffImage(tinyJpeg(200, 100, 6)), { mime: 'image/jpeg', width: 100, height: 200 }, 'фото с телефона, повёрнутое в EXIF');
  const gif = Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.from([0x40, 0x01, 0xf0, 0x00]), Buffer.alloc(8)]);
  assert.deepEqual(sniffImage(gif), { mime: 'image/gif', width: 320, height: 240 });
  const webp = Buffer.alloc(30);
  webp.write('RIFF', 0, 'latin1');
  webp.write('WEBPVP8X', 8, 'latin1');
  webp.writeUIntLE(639, 24, 3);
  webp.writeUIntLE(479, 27, 3);
  assert.deepEqual(sniffImage(webp), { mime: 'image/webp', width: 640, height: 480 });
  assert.equal(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')), null, 'SVG — не картинка');
  assert.equal(cleanFileName('../../etc/passwd'), 'passwd');
  assert.equal(cleanFileName('C:\\Users\\x\\фото.jpg'), 'фото.jpg');
  assert.equal(cleanFileName('photo\u202egpj.exe'), 'photogpj.exe', 'без символов смены направления текста');
  assert.equal(cleanFileName('...'), 'файл');
  const long = cleanFileName('я'.repeat(300) + '.png');
  assert.ok(long.length === 120 && long.endsWith('.png'));
});

test('вложения: фото с подписью и файл, повтор без дубля, закрытое обращение снова открыто', async () => {
  assert.equal((await owner.get(`/api/conversations/${conversation.id}`)).data.conversation.status, 'closed');
  const photo = await attach(alice, conversation.id, PNG, 'скрин.png', { 'X-Client-Id': 'f1', 'X-Caption': encodeURIComponent('  Вот ошибка — смотрите  ') });
  assert.equal(photo.status, 200);
  const m = photo.data.message;
  assert.equal(m.text, 'Вот ошибка — смотрите');
  assert.equal(m.attachments.length, 1);
  photoAtt = m.attachments[0];
  assert.deepEqual([photoAtt.kind, photoAtt.mime, photoAtt.width, photoAtt.height, photoAtt.size, photoAtt.name], ['image', 'image/png', 1, 1, PNG.length, 'скрин.png']);
  assert.ok(fs.existsSync(attachmentFile(photoAtt.id)), 'файл лежит на диске под своим id, а не под именем от пользователя');

  const again = await attach(alice, conversation.id, PNG, 'скрин.png', { 'X-Client-Id': 'f1', 'X-Caption': encodeURIComponent('Вот ошибка — смотрите') });
  assert.equal(again.status, 200);
  assert.equal(again.data.message.id, m.id, 'повтор с тем же X-Client-Id — то же сообщение');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM attachments').get().n, 1);
  assert.equal(fs.readdirSync(path.join(dataDir, 'attachments')).length, 1, 'лишнего файла на диске нет');

  const log = await attach(alice, conversation.id, Buffer.from('лог сервера\nошибка 42\n'), 'latest.log', { 'X-Client-Id': 'f2' });
  assert.equal(log.status, 200);
  assert.equal(log.data.message.text, '', 'без подписи — пустой текст');
  logAtt = log.data.message.attachments[0];
  assert.deepEqual([logAtt.kind, logAtt.mime, logAtt.width, logAtt.height], ['file', 'application/octet-stream', null, null]);
  aliceFiles.push(photoAtt.id, logAtt.id);

  const conv = (await owner.get(`/api/conversations/${conversation.id}`)).data.conversation;
  assert.equal(conv.status, 'open', 'игрок прислал файл — обращение снова открыто, как с текстом');
  assert.equal(conv.maxFileBytes, 1024 * 1024, 'кабинет знает лимит размера (LWL_CHAT_MAX_FILE_MB)');
  const item = (await owner.get('/api/conversations')).data.items.find((c) => c.id === conversation.id);
  assert.deepEqual(item.lastMessage.attachment, { kind: 'file', name: 'latest.log' }, 'в списке — имя файла');
  assert.equal(item.lastMessage.text, '');
  assert.equal(item.unread, 2, 'фото и файл — два непрочитанных');
  const items = (await owner.get(`/api/conversations/${conversation.id}/messages`)).data.items;
  assert.deepEqual(items.slice(-2).map((x) => x.attachments[0].kind), ['image', 'file']);
  assert.equal(items[0].attachments.length, 0, 'у текстовых сообщений вложений нет');
  await owner.post(`/api/conversations/${conversation.id}/read`);
  assert.equal((await owner.get('/api/conversations')).data.items.find((c) => c.id === conversation.id).unread, 0);

  // и в обратную сторону: админ отвечает фото — у игрока непрочитанное
  const reply = await attach(owner, conversation.id, tinyJpeg(200, 100, 6), 'ответ.jpg', { 'X-Client-Id': 'o-f1' });
  assert.deepEqual([reply.data.message.attachments[0].width, reply.data.message.attachments[0].height], [100, 200]);
  aliceFiles.push(reply.data.message.attachments[0].id);
  assert.equal((await alice.get('/api/me/summary')).data.unreadMessages, 1);
  const aliceView = (await alice.get(`/api/conversations/${conversation.id}`)).data.conversation;
  assert.deepEqual(aliceView.lastMessage.attachment, { kind: 'image', name: 'ответ.jpg' }, 'в списке — «Фото»');
  await alice.post(`/api/conversations/${conversation.id}/read`);
});

test('вложения: SVG, HTML и «фото.png» с HTML внутри отдаются как файл octet-stream, картинка — inline', async () => {
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  const html = Buffer.from('<!doctype html><script>alert(document.cookie)</script>');
  for (const [data, name, type] of [
    [svg, 'pic.svg', 'image/svg+xml'],
    [html, 'page.html', 'text/html'],
    [html, 'фото.png', 'image/png'],
  ]) {
    const r = await attach(alice, conversation.id, data, name, { 'Content-Type': type });
    assert.equal(r.status, 200, name);
    const a = r.data.message.attachments[0];
    aliceFiles.push(a.id);
    assert.equal(a.kind, 'file', `${name}: не картинка`);
    const got = await owner.get(a.url);
    assert.equal(got.status, 200);
    assert.equal(got.headers.get('content-type'), 'application/octet-stream', name);
    assert.match(got.headers.get('content-disposition'), /^attachment; filename="[^"]+"; filename\*=UTF-8''/, name);
    assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
    assert.ok(Buffer.compare(got.data, data) === 0, 'файл отдаётся без изменений');
  }
  // А PNG под именем .html — всё равно картинка: смотрим на содержимое, а не на имя.
  const png = await attach(alice, conversation.id, PNG, 'not-a-page.html');
  const a = png.data.message.attachments[0];
  aliceFiles.push(a.id);
  assert.equal(a.kind, 'image');
  const got = await owner.get(a.url);
  assert.equal(got.headers.get('content-type'), 'image/png');
  assert.match(got.headers.get('content-disposition'), /^inline; /);
  assert.equal(got.headers.get('x-content-type-options'), 'nosniff');
  assert.match(got.headers.get('cache-control'), /private/);
  assert.match(got.headers.get('content-security-policy'), /sandbox/, 'файл, открытый отдельно, не выполнит скрипт');
  const photo = await alice.get(photoAtt.url);
  assert.equal(photo.headers.get('content-disposition'), `inline; filename="_____.png"; filename*=UTF-8''%D1%81%D0%BA%D1%80%D0%B8%D0%BD.png`, 'имя по-русски — через filename*');
});

test('вложения: чужое обращение — 404, без входа — 401; Range и 304; лимиты размера и подписи', async () => {
  assert.equal((await bob.get(photoAtt.url)).status, 404, 'чужой файл не скачать');
  assert.equal((await client().get(photoAtt.url)).status, 401);
  assert.equal((await attach(bob, conversation.id, PNG, 'x.png')).status, 404, 'в чужое обращение не загрузить');
  assert.equal((await alice.get('/api/attachments/f_nope')).status, 404);

  const part = await alice.get(logAtt.url, { Range: 'bytes=2-5' });
  assert.equal(part.status, 206);
  assert.equal(part.data.length, 4);
  assert.equal(part.headers.get('content-range'), `bytes 2-5/${logAtt.size}`);
  assert.equal((await alice.get(logAtt.url, { Range: 'bytes=9999-' })).status, 416);
  const full = await alice.get(photoAtt.url);
  const cached = await alice.get(photoAtt.url, { 'If-None-Match': full.headers.get('etag') });
  assert.equal(cached.status, 304, 'картинка не скачивается заново');

  const tooBig = await attach(alice, conversation.id, Buffer.alloc(1024 * 1024 + 1, 1), 'big.bin');
  assert.equal(tooBig.status, 413);
  assert.match(tooBig.data.message, /1 МБ/);
  assert.equal((await attach(alice, conversation.id, Buffer.alloc(0), 'empty.txt')).status, 422);
  assert.equal((await attach(alice, conversation.id, PNG, 'x.png', { 'X-Caption': encodeURIComponent('а'.repeat(2001)) })).status, 422);
  assert.equal((await attach(alice, conversation.id, PNG, 'x.png', { 'X-Caption': '%E0%A4%A' })).status, 400, 'битая кодировка подписи');
  assert.equal(fs.readdirSync(path.join(dataDir, 'attachments')).filter((n) => !aliceFiles.includes(n)).length, 0, 'отклонённые файлы не остались на диске');
});

test('вложения: лимит частоты на человека; удаление обращения удаляет файлы с диска', async () => {
  const dan = client();
  await dan.post('/api/auth/register', { nickname: 'Dan_9', email: 'dan@example.com', password: 'Passw0rd1' });
  const conv = (await dan.post('/api/support/conversation')).data.conversation;
  const ids = [];
  for (let i = 0; i < 30; i++) {
    const r = await attach(dan, conv.id, PNG, `${i}.png`, { 'X-Client-Id': 'd' + i });
    assert.equal(r.status, 200);
    ids.push(r.data.message.attachments[0].id);
  }
  const limited = await attach(dan, conv.id, PNG, 'more.png', { 'X-Client-Id': 'd30' });
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  assert.equal((await attach(dan, conv.id, PNG, '0.png', { 'X-Client-Id': 'd0' })).status, 200, 'повтор уже дошедшего файла лимитом не режется');
  assert.ok(ids.every((id) => fs.existsSync(attachmentFile(id))));
  assert.equal((await owner.del(`/api/conversations/${conv.id}`)).status, 204);
  assert.ok(ids.every((id) => !fs.existsSync(attachmentFile(id))), 'файлы удалены вместе с обращением');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM attachments WHERE id IN (' + ids.map(() => '?').join(',') + ')').get(...ids).n, 0);
  await dan.del('/api/me', { password: 'Passw0rd1' });
});

test('вложения: при запуске сайт убирает файлы без строки в базе и брошенные загрузки', async () => {
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'lwl-sweep-'));
  try {
    const files = path.join(dir2, 'attachments');
    fs.mkdirSync(files);
    fs.writeFileSync(path.join(files, 'f_orphan'), 'x');
    fs.writeFileSync(path.join(files, '.upload-stale'), 'x');
    const old = new Date(Date.now() - 2 * 24 * 3600 * 1000);
    fs.utimesSync(path.join(files, '.upload-stale'), old, old);
    fs.writeFileSync(path.join(files, '.upload-fresh'), 'x');
    const app2 = createApp(loadConfig({ LWL_DATA_DIR: dir2, LWL_FAST_HASH: '1' }));
    await app2.close();
    assert.deepEqual(fs.readdirSync(files), ['.upload-fresh'], 'идущую загрузку не трогает');
  } finally {
    fs.rmSync(dir2, { recursive: true, force: true });
  }
});

test('сброс пароля: запрос → ссылка от админа → новый пароль', async () => {
  const nobody = await client().post('/api/auth/password-reset', { email: 'nobody@example.com' });
  assert.equal(nobody.status, 200);
  assert.deepEqual(nobody.data, { mail: false }, 'без LWL_SMTP_URL писем нет');
  assert.deepEqual((await client().post('/api/auth/password-reset', { email: 'bob@example.com' })).data, { mail: false });
  assert.equal((await owner.get('/api/me/summary')).data.resetRequests, 1);
  const users = await owner.get('/api/admin/users?role=reset');
  assert.equal(users.data.items.length, 1);
  const link = await owner.post(`/api/admin/users/${users.data.items[0].id}/reset-link`);
  const token = link.data.url.split('#/reset/')[1];
  const c = client();
  assert.equal((await c.get(`/api/auth/password-reset/${token}`)).data.nickname, 'Bob_Builder2');
  const done = await c.post(`/api/auth/password-reset/${token}`, { password: 'NewPassw0rd' });
  assert.equal(done.data.user.nickname, 'Bob_Builder2');
  assert.equal((await bob.get('/api/auth/me')).status, 401, 'старые сессии завершены');
  assert.equal((await c.post(`/api/auth/password-reset/${token}`, { password: 'NewPassw0rd2' })).status, 404, 'ссылка одноразовая');
  assert.equal((await bob.post('/api/auth/login', { login: 'bob@example.com', password: 'NewPassw0rd' })).status, 200);
});

test('роли: админ меняет роль, владельца понизить нельзя', async () => {
  const list = await owner.get('/api/admin/users');
  const ownerRow = list.data.items.find((u) => u.nickname === 'Owner_1');
  const bobRow = list.data.items.find((u) => u.nickname === 'Bob_Builder2');
  assert.equal((await owner.patch(`/api/admin/users/${ownerRow.id}`, { role: 'user' })).status, 403);
  assert.equal((await owner.patch(`/api/admin/users/${bobRow.id}`, { role: 'admin' })).data.user.role, 'admin');
  assert.equal((await bob.get('/api/applications')).status, 200);
  await owner.patch(`/api/admin/users/${bobRow.id}`, { role: 'user' });
  assert.equal((await bob.get('/api/applications')).status, 403);
});

test('права админов: по умолчанию без удаления и назначения админов, создателя не тронуть', async () => {
  const users = (await owner.get('/api/admin/users')).data.items;
  const ownerRow = users.find((u) => u.nickname === 'Owner_1');
  const bobRow = users.find((u) => u.nickname === 'Bob_Builder2');
  assert.equal(ownerRow.creator, true);
  const made = await owner.patch(`/api/admin/users/${bobRow.id}`, { role: 'admin' });
  assert.deepEqual(made.data.user.permissions, ['applications', 'tickets', 'users', 'server']);
  const me = (await bob.get('/api/auth/me')).data.user;
  assert.equal(me.creator, false);
  assert.deepEqual((await bob.get('/api/me/summary')).data.permissions, ['applications', 'tickets', 'users', 'server']);

  // создателя обычный админ не трогает: ни роль, ни ссылку на сброс пароля, ни удаление
  assert.equal((await bob.patch(`/api/admin/users/${ownerRow.id}`, { role: 'user' })).status, 403);
  assert.equal((await bob.post(`/api/admin/users/${ownerRow.id}/reset-link`)).status, 403, 'иначе админ смог бы войти в аккаунт создателя');
  assert.equal((await bob.del(`/api/admin/users/${ownerRow.id}`)).status, 403);
  // без права «Админы» — не назначает админов; без права «Удаление» — не удаляет
  const carolRow = users.find((u) => u.nickname !== 'Owner_1' && u.nickname !== 'Bob_Builder2');
  assert.equal((await bob.patch(`/api/admin/users/${carolRow.id}`, { role: 'admin' })).status, 403);
  assert.equal((await bob.del(`/api/admin/users/${carolRow.id}`)).status, 403);
  // права раздаёт только создатель
  assert.equal((await bob.put(`/api/admin/users/${bobRow.id}/permissions`, { permissions: ['applications', 'tickets', 'users', 'server', 'delete', 'admins'] })).status, 403);
  assert.equal((await owner.put(`/api/admin/users/${ownerRow.id}/permissions`, { permissions: [] })).status, 409, 'у создателя всегда все права');
  assert.equal((await owner.put(`/api/admin/users/${bobRow.id}/permissions`, { permissions: ['hack'] })).status, 422);

  const narrowed = await owner.put(`/api/admin/users/${bobRow.id}/permissions`, { permissions: ['tickets'] });
  assert.deepEqual(narrowed.data.user.permissions, ['tickets']);
  assert.equal((await bob.get('/api/applications')).status, 403);
  assert.equal((await bob.get('/api/admin/settings')).status, 403);
  assert.equal((await bob.get('/api/conversations')).status, 200);
  const sum = (await bob.get('/api/me/summary')).data;
  assert.deepEqual(sum.permissions, ['tickets']);
  assert.equal(sum.pendingApplications, 0);

  // сняли админа и выдали снова — права по умолчанию
  await owner.patch(`/api/admin/users/${bobRow.id}`, { role: 'user' });
  assert.equal((await bob.get('/api/conversations')).status, 403);
  await owner.patch(`/api/admin/users/${bobRow.id}`, { role: 'admin' });
  assert.deepEqual((await bob.get('/api/auth/me')).data.user.permissions, ['applications', 'tickets', 'users', 'server']);
  await owner.patch(`/api/admin/users/${bobRow.id}`, { role: 'user' });
});

test('удаление заявок и обращений; «прочитано» в чате', async () => {
  const carol = client();
  await carol.post('/api/auth/register', { nickname: 'Carol_3', email: 'carol@example.com', password: 'Passw0rd1' });
  const app = (await carol.post('/api/applications', Object.assign({}, application, { license: 'premium' }))).data.application;
  const conv = (await carol.post('/api/support/conversation')).data.conversation;
  const sent = (await carol.post(`/api/conversations/${conv.id}/messages`, { text: 'Помогите с заявкой', clientId: 'c1' })).data.message;
  assert.equal((await carol.get(`/api/conversations/${conv.id}`)).data.conversation.peerReadAt, 0, 'админ ещё не читал');
  await owner.post(`/api/conversations/${conv.id}/read`);
  assert.ok((await carol.get(`/api/conversations/${conv.id}`)).data.conversation.peerReadAt >= sent.createdAt, 'админ прочитал — две галочки');
  const reply = (await owner.post(`/api/conversations/${conv.id}/messages`, { text: 'Сейчас посмотрю', clientId: 'o1' })).data.message;
  assert.ok((await owner.get(`/api/conversations/${conv.id}`)).data.conversation.peerReadAt < reply.createdAt, 'игрок ещё не читал ответ');
  await carol.post(`/api/conversations/${conv.id}/read`);
  assert.ok((await owner.get(`/api/conversations/${conv.id}`)).data.conversation.peerReadAt >= reply.createdAt);

  // обычный админ (права по умолчанию) удалять не может
  const users = (await owner.get('/api/admin/users')).data.items;
  const bobRow = users.find((u) => u.nickname === 'Bob_Builder2');
  await owner.patch(`/api/admin/users/${bobRow.id}`, { role: 'admin' });
  assert.equal((await bob.del(`/api/applications/${app.id}`)).status, 403);
  assert.equal((await bob.del(`/api/conversations/${conv.id}`)).status, 403);
  await owner.put(`/api/admin/users/${bobRow.id}/permissions`, { permissions: ['applications', 'tickets', 'delete'] });
  assert.equal((await bob.del(`/api/applications/${app.id}`)).status, 204);
  assert.equal((await carol.get('/api/applications/mine')).data.application, null, 'можно подать заново');
  assert.equal((await bob.del(`/api/conversations/${conv.id}`)).status, 204);
  assert.equal((await carol.get(`/api/conversations/${conv.id}`)).status, 404);
  assert.notEqual((await carol.post('/api/support/conversation')).data.conversation.id, conv.id, 'новое обращение');
  await owner.patch(`/api/admin/users/${bobRow.id}`, { role: 'user' });
  await carol.del('/api/me', { password: 'Passw0rd1' });
});

test('настройки сервера: админ задаёт, игрок видит всё, кроме адреса', async () => {
  const bad = await owner.put('/api/admin/settings', { telegramUrl: 'javascript:alert(1)' });
  assert.equal(bad.status, 422);
  await owner.put('/api/admin/settings', { serverAddress: 'play.lwl.example', serverVersion: '26.3', telegramUrl: 'https://t.me/lwl' });
  assert.equal((await client().get('/api/settings')).data.telegramUrl, 'https://t.me/lwl');
  assert.equal((await owner.get('/api/admin/settings')).data.settings.serverAddress, 'play.lwl.example', 'админ адрес видит');
  const info = await alice.get('/api/me/server');
  assert.equal(info.data.server.version, '26.3');
  assert.equal(info.data.server.ready, true);
  assert.equal(info.data.me.license, 'cracked');
  assert.equal(info.data.server.address, undefined);
  assert.ok(!JSON.stringify(info.data).includes('play.lwl.example'), 'адреса сервера в ответе игроку нет');
  assert.ok(!JSON.stringify((await client().get('/api/settings')).data).includes('play.lwl.example'));
});

/* ------------------------------------------------------------ коды входа (мод LWL) */

const CODE_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
let ipSeq = 0;
/** Запрос как от мода: заголовки контракта и свой IP (X-Real-IP), чтобы не упереться в лимит по IP. */
async function mod(method, url, body, { token, ip, omit = [], headers = {} } = {}) {
  ipSeq++;
  const h = Object.assign({ 'X-Requested-With': 'lwl', 'Content-Type': 'application/json', 'X-Real-IP': ip || `10.0.${ipSeq >> 8}.${ipSeq & 255}` }, headers);
  if (token) h.Authorization = 'Bearer ' + token;
  for (const k of omit) delete h[k];
  const res = await fetch(base + url, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null, text, headers: res.headers };
}
const connect = (code, nickname, opts) => mod('POST', '/api/connect', { code, nickname }, opts);
const game = (method, url, body, token = GAME_TOKEN) => mod(method, url, body, { token });
const WRONG = { code: 'wrong_code', message: 'Неверный код' };
let aliceCode;

test('коды: вкладка «Сервер» — код создаёт только игрок, целиком он приходит один раз', async () => {
  const before = (await alice.get('/api/me/server')).data;
  assert.deepEqual(before.code, { exists: false, last4: null, createdAt: null });
  assert.equal((await bob.post('/api/me/connect-code')).status, 403, 'пользователю без роли «Игрок» — нельзя');
  assert.equal((await client().post('/api/me/connect-code')).status, 401);

  const created = await alice.post('/api/me/connect-code');
  assert.equal(created.status, 200);
  aliceCode = created.data.code;
  assert.match(aliceCode, CODE_RE);
  assert.equal(created.data.info.exists, true);
  assert.equal(created.data.info.last4, aliceCode.slice(-4));

  const after = (await alice.get('/api/me/server')).data;
  assert.equal(after.code.exists, true);
  assert.equal(after.code.last4, aliceCode.slice(-4));
  assert.ok(after.code.createdAt > 0);
  const plain = aliceCode.replace(/-/g, '');
  assert.ok(!JSON.stringify(after).includes(plain) && !JSON.stringify(after).includes(aliceCode), 'потом код целиком больше не отдаётся');
  const rows = app.db.prepare('SELECT * FROM connect_codes').all();
  assert.equal(rows.length, 1);
  assert.ok(!JSON.stringify(rows).includes(plain), 'в базе кода в открытом виде нет');
  assert.match(rows[0].code_hash, /^[0-9a-f]{64}$/);

  const aliceId = (await alice.get('/api/auth/me')).data.user.id;
  const card = (await owner.get(`/api/admin/users/${aliceId}`)).data;
  assert.equal(card.connectCode.exists, true, 'админ видит, что код есть');
  assert.equal(card.connectCode.last4, aliceCode.slice(-4));
});

test('коды: POST /api/connect — адрес по коду в любом виде, 404 одинаковый для ника и кода', async () => {
  const plain = aliceCode.replace(/-/g, '');
  for (const [code, nick] of [
    [aliceCode, 'Alice_07'],
    [plain.toLowerCase(), 'alice_07'],
    [` ${plain.slice(0, 4)} ${plain.slice(4, 8)} ${plain.slice(8)} `, 'ALICE_07'],
    [`${plain.slice(0, 4)} ${plain.slice(4, 8)}–${plain.slice(8).toLowerCase()}`, ' Alice_07 '], // неразрывный пробел и тире из буфера
  ]) {
    const r = await connect(code, nick);
    assert.equal(r.status, 200, `${JSON.stringify(code)} / ${nick}: ${r.text}`);
    assert.deepEqual(r.data, { address: 'play.lwl.example' });
  }

  const other = plain.slice(0, 11) + (plain[11] === 'A' ? 'B' : 'A');
  const wrong = await connect(other, 'Alice_07');
  assert.equal(wrong.status, 404);
  assert.deepEqual(wrong.data, WRONG, 'ошибка — ровно { code, message }');
  for (const [code, nick] of [
    [aliceCode, 'no_such_player'], // нет такого ника
    [aliceCode, 'Bob_Builder2'], // есть, но не игрок и кода нет
    ['ABC', 'Alice_07'], // не код
    ['', ''],
  ]) {
    const r = await connect(code, nick);
    assert.equal(r.status, 404, `${code} / ${nick}`);
    assert.deepEqual(r.data, WRONG, 'неизвестный ник и неверный код неотличимы');
  }
  assert.deepEqual((await mod('POST', '/api/connect', {})).data, WRONG, 'без полей — то же');

  // Заголовки контракта обязательны.
  assert.equal((await mod('POST', '/api/connect', { code: aliceCode, nickname: 'Alice_07' }, { omit: ['X-Requested-With'] })).status, 403);
  assert.equal((await mod('POST', '/api/connect', { code: aliceCode, nickname: 'Alice_07' }, { headers: { 'Content-Type': 'text/plain' } })).status, 400);
  assert.equal((await mod('GET', '/api/connect')).status, 405);

  // Админ тоже может войти по коду.
  const ownerCode = (await owner.post('/api/me/connect-code')).data.code;
  assert.equal((await connect(ownerCode, 'owner_1')).status, 200);

  // Адрес не задан — 503 no_address (только для верного кода).
  await owner.put('/api/admin/settings', { serverAddress: '' });
  assert.equal((await alice.get('/api/me/server')).data.server.ready, false);
  const none = await connect(aliceCode, 'Alice_07');
  assert.equal(none.status, 503);
  assert.deepEqual(none.data, { code: 'no_address', message: 'Адрес сервера ещё не указан' });
  assert.equal((await connect(other, 'Alice_07')).status, 404);
  await owner.put('/api/admin/settings', { serverAddress: 'play.lwl.example' });
});

test('коды: 429 + Retry-After — по IP (10 в минуту) и по нику (10 неверных за 10 минут)', async () => {
  for (let i = 0; i < 10; i++) assert.equal((await connect('AAAA-AAAA-AAAA', 'someone', { ip: '10.200.0.1' })).status, 404);
  const ip = await connect(aliceCode, 'Alice_07', { ip: '10.200.0.1' });
  assert.equal(ip.status, 429);
  assert.equal(ip.data.code, 'rate_limited');
  assert.ok(ip.data.message);
  const ipWait = Number(ip.headers.get('retry-after'));
  assert.ok(ipWait > 0 && ipWait <= 60, 'Retry-After в секундах: ' + ip.headers.get('retry-after'));
  assert.equal((await connect(aliceCode, 'Alice_07', { ip: '10.200.0.2' })).status, 200, 'другой IP не задет');

  // Удачные входы ник не блокируют.
  for (let i = 0; i < 12; i++) assert.equal((await connect(aliceCode, 'Alice_07')).status, 200);

  // 10 неверных кодов для ника — дальше ник закрыт даже с верным кодом и с других IP.
  const ownerCode = (await owner.post('/api/me/connect-code')).data.code;
  for (let i = 0; i < 10; i++) assert.equal((await connect('AAAA-AAAA-AAAA', 'Owner_1')).status, 404);
  const nick = await connect(ownerCode, 'OWNER_1');
  assert.equal(nick.status, 429);
  const nickWait = Number(nick.headers.get('retry-after'));
  assert.ok(nickWait > 60 && nickWait <= 600, 'Retry-After: ' + nickWait);
  assert.equal((await connect(aliceCode, 'Alice_07')).status, 200, 'другие ники не задеты');
});

test('коды: игровой сервер — токен, verify, новый код, отзыв', async () => {
  // Токен: нет, неверный — 401.
  for (const token of [undefined, 'wrong-token', GAME_TOKEN + 'x']) {
    const r = await mod('POST', '/api/game/codes/verify', { nickname: 'Alice_07', code: aliceCode }, { token });
    assert.equal(r.status, 401, String(token));
    assert.equal(r.data.code, 'unauthorized');
    assert.ok(r.data.message);
  }
  assert.equal((await mod('POST', '/api/game/codes', { nickname: 'Alice_07' }, { token: 'nope' })).status, 401);
  assert.equal((await mod('DELETE', '/api/game/codes/Alice_07', undefined, { token: 'nope' })).status, 401);
  assert.equal((await mod('POST', '/api/game/codes/verify', { nickname: 'Alice_07', code: aliceCode }, { token: GAME_TOKEN, omit: ['X-Requested-With'] })).status, 403);

  // verify
  assert.deepEqual((await game('POST', '/api/game/codes/verify', { nickname: 'alice_07', code: aliceCode.replace(/-/g, ' ').toLowerCase() })).data, { valid: true });
  for (const [nickname, code] of [
    ['Alice_07', 'AAAA-AAAA-AAAA'],
    ['no_such_player', aliceCode],
    ['Bob_Builder2', aliceCode],
    ['Alice_07', ''],
  ]) {
    const r = await game('POST', '/api/game/codes/verify', { nickname, code });
    assert.equal(r.status, 200);
    assert.equal(r.data.valid, false, `${nickname} / ${code}`);
    assert.ok(typeof r.data.message === 'string' && r.data.message.length > 5, 'сайт объясняет, почему нет');
  }

  // Новый код с сервера: старый перестаёт работать.
  const given = await game('POST', '/api/game/codes', { nickname: 'ALICE_07' });
  assert.equal(given.status, 200);
  assert.match(given.data.code, CODE_RE);
  assert.notEqual(given.data.code, aliceCode);
  assert.equal((await game('POST', '/api/game/codes/verify', { nickname: 'Alice_07', code: aliceCode })).data.valid, false, 'старый код');
  assert.equal((await connect(aliceCode, 'Alice_07')).status, 404);
  assert.equal((await connect(given.data.code, 'Alice_07')).status, 200);
  assert.equal((await alice.get('/api/me/server')).data.code.last4, given.data.code.slice(-4));
  // …и из кабинета тоже: новый код — старый недействителен.
  const mine = (await alice.post('/api/me/connect-code')).data.code;
  assert.equal((await game('POST', '/api/game/codes/verify', { nickname: 'Alice_07', code: given.data.code })).data.valid, false);
  assert.deepEqual((await game('POST', '/api/game/codes/verify', { nickname: 'Alice_07', code: mine })).data, { valid: true });

  for (const nickname of ['no_such_player', 'Bob_Builder2', '']) {
    const r = await game('POST', '/api/game/codes', { nickname });
    assert.equal(r.status, 404, nickname);
    assert.equal(r.data.code, 'player_not_found');
    assert.ok(r.data.message);
  }

  // Отзыв: 204 без тела, код больше не проходит; повторный отзыв — тоже 204.
  const del = await game('DELETE', '/api/game/codes/alice_07');
  assert.equal(del.status, 204);
  assert.equal(del.text, '');
  assert.equal((await game('POST', '/api/game/codes/verify', { nickname: 'Alice_07', code: mine })).data.valid, false);
  assert.equal((await connect(mine, 'Alice_07')).status, 404);
  assert.equal((await alice.get('/api/me/server')).data.code.exists, false);
  assert.equal((await game('DELETE', '/api/game/codes/Alice_07')).status, 204);
  assert.equal((await game('DELETE', `/api/game/codes/${encodeURIComponent('нет такого')}`)).status, 204);

  // Админ отзывает код в «Людях» (право «Люди»).
  aliceCode = (await alice.post('/api/me/connect-code')).data.code;
  const aliceId = (await alice.get('/api/auth/me')).data.user.id;
  assert.equal((await bob.del(`/api/admin/users/${aliceId}/connect-code`)).status, 403);
  assert.equal((await owner.del(`/api/admin/users/${aliceId}/connect-code`)).status, 204);
  assert.equal((await owner.get(`/api/admin/users/${aliceId}`)).data.connectCode.exists, false);
  assert.equal((await connect(aliceCode, 'Alice_07')).status, 404);
  aliceCode = (await alice.post('/api/me/connect-code')).data.code;
});

test('коды: без LWL_GAME_TOKEN маршруты сервера отвечают 503', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwl-notoken-'));
  const app2 = createApp(loadConfig({ LWL_DATA_DIR: dir, LWL_FAST_HASH: '1' }));
  await new Promise((r) => app2.server.listen(0, '127.0.0.1', r));
  const saved = base;
  base = `http://127.0.0.1:${app2.server.address().port}`;
  try {
    for (const [method, url, body] of [
      ['POST', '/api/game/codes/verify', { nickname: 'Alice_07', code: 'AAAA-AAAA-AAAA' }],
      ['POST', '/api/game/codes', { nickname: 'Alice_07' }],
      ['DELETE', '/api/game/codes/Alice_07'],
      ['POST', '/api/game/presence', { players: [] }],
      ['POST', '/api/game/stats', { players: [] }],
    ]) {
      const r = await mod(method, url, body, { token: GAME_TOKEN });
      assert.equal(r.status, 503, url);
      assert.ok(r.data.code && r.data.message);
    }
    assert.equal((await connect('AAAA-AAAA-AAAA', 'Alice_07')).status, 404, 'клиентский маршрут работает');
  } finally {
    base = saved;
    await app2.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------ карточки игроков (мод lwl-stats) */

const statsOf = (nickname, extra = {}) => ({
  nickname,
  uuid: '0f6d3a2e-1111-3222-8333-444455556666',
  playTimeSec: 7200,
  deaths: 3,
  mobKills: 120,
  playerKills: 0,
  blocksMined: 15000,
  distanceM: 3400,
  advancements: 12,
  ...extra,
});
const statsRow = (nick) => app.db.prepare('SELECT * FROM player_stats WHERE nick_key = ?').get(nick.toLowerCase());

test('карточки: presence и stats — только с токеном сервера, ошибки { code, message }', async () => {
  for (const url of ['/api/game/presence', '/api/game/stats']) {
    for (const token of [undefined, 'wrong-token']) {
      const r = await mod('POST', url, { players: [] }, { token });
      assert.equal(r.status, 401, `${url} ${token}`);
      assert.deepEqual(Object.keys(r.data).sort(), ['code', 'message']);
      assert.equal(r.data.code, 'unauthorized');
    }
    assert.equal((await mod('POST', url, { players: [] }, { token: GAME_TOKEN, omit: ['X-Requested-With'] })).status, 403);
  }
  // Неверные данные — 400, весь запрос отклоняется.
  for (const body of [
    {},
    { players: 'Alice_07' },
    { players: [statsOf('Alice 07')] },
    { players: [statsOf('Alice_07', { deaths: -1 })] },
    { players: [statsOf('Alice_07', { deaths: '3' })] },
    { players: [statsOf('Alice_07', { playTimeSec: null })] },
    { players: [statsOf('Alice_07', { uuid: 'не uuid' })] },
    { players: [statsOf('Alice_07', { skin: 'https://textures.minecraft.net/texture/abc' })] },
    { players: Array.from({ length: 51 }, (_, i) => statsOf(`p${i}`)) },
  ]) {
    const r = await game('POST', '/api/game/stats', body);
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 80));
    assert.deepEqual(Object.keys(r.data).sort(), ['code', 'message']);
    assert.equal(r.data.code, 'bad_request');
  }
  assert.equal(statsRow('Alice_07'), undefined, 'ничего не записано');
  // Больше 256 КБ — 413.
  const big = await game('POST', '/api/game/stats', { players: [], pad: 'x'.repeat(300 * 1024) });
  assert.equal(big.status, 413);
  assert.equal(big.data.code, 'too_large');
  assert.equal((await game('POST', '/api/game/presence', { players: [{ nickname: 'bad nick' }] })).status, 400);
});

test('карточки: presence — в сети, вышел, и тайм-аут 150 секунд', async () => {
  const first = await game('POST', '/api/game/presence', { players: [{ nickname: 'Alice_07', uuid: '0f6d3a2e-1111-3222-8333-444455556666' }, 'Steve_Bot'] });
  assert.equal(first.status, 204);
  assert.equal(first.text, '');
  const fromGame = async () => (await alice.get('/api/players')).data.players.filter((p) => p.stats);
  let list = await fromGame();
  assert.deepEqual(
    list.map((p) => [p.nickname, p.online]),
    [
      ['Alice_07', true],
      ['Steve_Bot', true],
    ]
  );
  const firstSeen = statsRow('Alice_07').first_seen;

  // Steve_Bot вышел: его нет в полном списке.
  await game('POST', '/api/game/presence', { players: [{ nickname: 'alice_07' }] });
  list = await fromGame();
  assert.equal(list.find((p) => p.nickname === 'Steve_Bot').online, false);
  assert.ok(list.some((p) => p.nickname === 'alice_07' && p.online), 'ник — как прислал сервер');
  assert.equal(statsRow('Alice_07').uuid, '0f6d3a2e-1111-3222-8333-444455556666', 'uuid не стёрся');
  assert.equal(statsRow('Alice_07').first_seen, firstSeen, 'первый вход не меняется');

  // Сервер пропал (не шлёт presence) — через 150 с игрок уже не «в сети».
  app.db.prepare('UPDATE player_stats SET presence_at = presence_at - 145000').run();
  assert.equal((await alice.get('/api/players/Alice_07')).data.player.online, true);
  app.db.prepare('UPDATE player_stats SET presence_at = presence_at - 6000').run();
  assert.equal((await alice.get('/api/players/Alice_07')).data.player.online, false);

  // Остановка сервера — пустой список: все вышли.
  await game('POST', '/api/game/presence', { players: [{ nickname: 'Alice_07' }] });
  await game('POST', '/api/game/presence', { players: [] });
  assert.equal(statsRow('Alice_07').online, 0);
});

test('карточки: статистика сохраняется и отдаётся, без координат и способа входа', async () => {
  const r = await game('POST', '/api/game/stats', {
    players: [
      statsOf('Alice_07', { firstPlayed: Date.UTC(2026, 0, 2), x: 10, ip: '1.2.3.4', license: 'cracked', inventory: ['diamond'] }),
      statsOf('Steve_Bot', { playTimeSec: 60, deaths: 0, uuid: undefined }),
      statsOf('New_Guy', { playTimeSec: 99999 }),
    ],
  });
  assert.equal(r.status, 204, r.text);
  const p = (await alice.get('/api/players/alice_07')).data.player;
  assert.deepEqual(p.stats, { playtimeSec: 7200, deaths: 3, mobKills: 120, playerKills: 0, blocksMined: 15000, distanceM: 3400, advancements: 12 });
  assert.equal(p.nickname, 'Alice_07');
  assert.equal(p.role, 'player', 'есть аккаунт на сайте');
  assert.equal(p.firstSeen, Date.UTC(2026, 0, 2), 'первый вход — из игры, если раньше');
  assert.equal(p.skinUrl, `/api/skins/${createHash('sha256').update(SKIN_PNG).digest('hex')}.png`, 'своего скина нет — Стив, скачанный с textures.minecraft.net');
  assert.equal(p.skinDefault, true);
  assert.equal(p.skinSlim, false);
  const json = JSON.stringify(p);
  for (const word of ['1.2.3.4', 'cracked', 'license', 'diamond', 'uuid', 'email', 'example.com']) assert.ok(!json.includes(word), word);
  assert.equal(statsRow('Alice_07').extra, null, 'лишние поля не сохраняются');
  const bot = (await alice.get('/api/players/Steve_Bot')).data.player;
  assert.equal(bot.role, null, 'без аккаунта на сайте');
  assert.equal(bot.stats.deaths, 0);
  assert.equal(bot.avatar, null);

  // Сортировки и поиск.
  const nicks = async (sort, query = '') => (await alice.get(`/api/players?sort=${sort}&q=${encodeURIComponent(query)}`)).data.players.map((x) => x.nickname);
  // Owner_1 (админ сайта) в игру не заходил: карточка есть, без статистики — в конце.
  assert.deepEqual(await nicks('playtime'), ['New_Guy', 'Alice_07', 'Steve_Bot', 'Owner_1']);
  assert.equal((await alice.get('/api/players/Owner_1')).data.player.stats, null);
  await game('POST', '/api/game/presence', { players: ['Steve_Bot'] });
  assert.deepEqual(await nicks('online'), ['Steve_Bot', 'New_Guy', 'Alice_07', 'Owner_1']);
  const listed = (await alice.get('/api/players')).data;
  assert.equal(listed.full, true);
  assert.equal(listed.online, 1);
  assert.equal((await nicks('recent'))[0], 'Steve_Bot');
  assert.deepEqual(await nicks('online', 'ALI'), ['Alice_07']);
  assert.deepEqual(await nicks('online', 'нет такого'), []);
  assert.equal((await alice.get('/api/players/nobody_here')).status, 404);
});

test('карточки: видны всем; гостю и «Пользователю» — без статистики и «в сети», порядок по нику', async () => {
  for (const who of [bob, client()]) {
    const list = await who.get('/api/players?sort=playtime');
    assert.equal(list.status, 200);
    assert.equal(list.data.full, false);
    assert.ok(!('online' in list.data), 'сколько в сети — только игрокам');
    assert.deepEqual(
      list.data.players.map((p) => p.nickname),
      ['Alice_07', 'New_Guy', 'Owner_1', 'Steve_Bot'],
      'по нику, сортировка из запроса не действует'
    );
    const p = (await who.get('/api/players/Alice_07')).data.player;
    assert.deepEqual(Object.keys(p).sort(), ['avatar', 'background', 'backgroundUrl', 'bio', 'creator', 'looks', 'nickname', 'pose', 'role', 'skinDefault', 'skinSlim', 'skinUrl', 'socials']);
  }
  assert.equal((await client().get('/api/players/nobody_here')).status, 404);
  // Своя карточка — только «Игрокам» и админам.
  assert.equal((await bob.get('/api/me/card')).status, 403);
  assert.equal((await client().get('/api/me/card')).status, 401);
  assert.equal((await bob.patch('/api/me/card', { bio: 'привет' })).status, 403);
  assert.equal((await bob.put('/api/me/skin', SKIN_PNG, { 'Content-Type': 'application/octet-stream' })).status, 403);
  assert.equal((await owner.get('/api/players')).data.full, true);
  // Сколько в сети — без входа, только число.
  const online = await client().get('/api/online');
  assert.equal(online.status, 200);
  assert.deepEqual(online.data, { count: 1 });
});

test('карточки: «о себе», скрыть поля и всю карточку; проверка PATCH /api/me/card', async () => {
  const empty = (await alice.get('/api/me/card')).data;
  assert.deepEqual(
    { ...empty, card: empty.card.nickname },
    {
      bio: '',
      hidden: false,
      hideFields: [],
      pose: 'stand',
      looks: { card: { pose: 'stand', scale: 1, turn: 0 }, detail: { pose: 'stand', scale: 1, turn: 0 } },
      background: 'meadow',
      backgroundUrl: null,
      customBackground: null,
      socials: {},
      skin: null,
      card: 'Alice_07',
    }
  );

  for (const [body, field] of [
    [{ bio: 'x'.repeat(141) }, 'bio'],
    [{ bio: 42 }, 'bio'],
    [{ hidden: 'yes' }, 'hidden'],
    [{ hideFields: ['coords'] }, 'hideFields'],
    [{ hideFields: 'deaths' }, 'hideFields'],
    [{ pose: 'dab' }, 'pose'],
    [{ background: 'https://evil.example/bg.png' }, 'background'],
    [{ socials: 'telegram' }, 'socials'],
    [{ socials: { myspace: 'alice' } }, 'socials'],
    [{ socials: { telegram: 'https://evil.example' } }, 'socials'],
    [{ socials: { youtube: 'a"><script>' } }, 'socials'],
    [{ socials: { vk: 42 } }, 'socials'],
  ]) {
    const r = await alice.patch('/api/me/card', body);
    assert.equal(r.status, 422, JSON.stringify(body));
    assert.ok(r.data.fields[field], field);
  }

  const saved = await alice.patch('/api/me/card', { bio: '  Строю\nзамки  ', hideFields: ['deaths', 'lastSeen', 'deaths'] });
  assert.equal(saved.status, 200);
  assert.equal(saved.data.bio, 'Строю замки');
  assert.deepEqual(saved.data.hideFields, ['deaths', 'lastSeen']);
  assert.equal((await alice.patch('/api/me/card', { bio: 'й'.repeat(140) })).status, 200, 'ровно 140 — можно');
  await alice.patch('/api/me/card', { bio: 'Строю замки' });

  // Поза, фон и соцсети видны всем; пустая строка убирает соцсеть, остальные не трогаются.
  const look = await alice.patch('/api/me/card', { pose: 'wave', background: 'nether', socials: { telegram: 'alice_tg', discord: 'alice.07', twitch: 'alice_live' } });
  assert.equal(look.status, 200);
  assert.deepEqual(look.data.socials, { telegram: 'alice_tg', discord: 'alice.07', twitch: 'alice_live' });
  assert.deepEqual((await alice.patch('/api/me/card', { socials: { twitch: '' } })).data.socials, { telegram: 'alice_tg', discord: 'alice.07' });
  const guestView = (await client().get('/api/players/Alice_07')).data.player;
  assert.equal(guestView.pose, 'wave');
  assert.equal(guestView.background, 'nether');
  assert.deepEqual(guestView.socials, { telegram: 'alice_tg', discord: 'alice.07' });
  assert.equal(guestView.bio, 'Строю замки');

  // Скрытые поля вырезает сервер: их нет ни в списке, ни в карточке.
  const seen = (await owner.get('/api/players/Alice_07')).data.player;
  assert.equal(seen.bio, 'Строю замки');
  assert.ok(!('deaths' in seen.stats));
  assert.ok(!('lastSeen' in seen) && !('online' in seen), '«в сети» скрыт вместе с «когда был»');
  assert.equal(seen.stats.mobKills, 120);
  const inList = (await owner.get('/api/players')).data.players.find((x) => x.nickname === 'Alice_07');
  assert.ok(!('deaths' in inList.stats) && !('lastSeen' in inList));

  // Скрытая карточка не отдаётся никому — 404 как у несуществующей.
  assert.equal((await alice.patch('/api/me/card', { hidden: true })).data.hidden, true);
  assert.ok(!(await owner.get('/api/players')).data.players.some((x) => x.nickname === 'Alice_07'));
  assert.equal((await alice.get('/api/players?q=alice')).data.players.length, 0);
  assert.ok(!(await client().get('/api/players')).data.players.some((x) => x.nickname === 'Alice_07'), 'гостю тоже не видна');
  const hidden = await owner.get('/api/players/Alice_07');
  assert.equal(hidden.status, 404);
  assert.equal(hidden.data.message, (await owner.get('/api/players/nobody_here')).data.message);
  const mine = (await alice.get('/api/me/card')).data;
  assert.equal(mine.hidden, true);
  assert.equal(mine.bio, 'Строю замки', 'остальное сохранилось');
  assert.equal(mine.card.nickname, 'Alice_07', 'себе — предпросмотр, даже скрытой');

  await alice.patch('/api/me/card', { hidden: false, hideFields: [] });
  assert.equal((await owner.get('/api/players/Alice_07')).data.player.stats.deaths, 3);
});

test('карточки: скин качается только с textures.minecraft.net, отдаётся всем по адресу .png', async () => {
  const hitsBefore = textureHits.length;
  const hex = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
  const evil = [
    'https://evil.example/texture/abcdef0123456789',
    `${texturesOrigin}.evil.example/texture/abcdef0123456789`,
    `${texturesOrigin}/texture/abcdef0123456789?x=1`,
    `${texturesOrigin}/other/abcdef0123456789`,
    `${texturesOrigin.replace(/:\d+$/, ':1')}/texture/abcdef0123456789`,
    'file:///etc/passwd',
  ];
  const players = evil.map((url, i) => statsOf(`Evil_${i}`, { skin: { url, slim: true } }));
  players.push(statsOf('Steve_Bot', { skin: { url: `${texturesOrigin}/texture/badbadbadbadbad0`, slim: false } }));
  players.push(statsOf('New_Guy', { skin: { url: `${texturesOrigin}/texture/b16b16b16b16b16b`, slim: false } }));
  players.push(statsOf('Alice_07', { skin: { url: `${texturesOrigin}/texture/${hex}`, slim: true } }));
  assert.equal((await game('POST', '/api/game/stats', { players })).status, 204, 'плохой скин не мешает статистике');
  await app.skins.idle();
  assert.deepEqual(textureHits.slice(hitsBefore).sort(), ['/texture/b16b16b16b16b16b', '/texture/badbadbadbadbad0', `/texture/${hex}`].sort(), 'чужие адреса не запрашивались');
  for (let i = 0; i < evil.length; i++) assert.equal(statsRow(`Evil_${i}`).skin_url, null);
  assert.equal(statsRow('Steve_Bot').skin_hash, null, 'не PNG');
  assert.equal(statsRow('New_Guy').skin_hash, null, 'больше 64 КБ');

  const p = (await alice.get('/api/players/Alice_07')).data.player;
  assert.match(p.skinUrl, /^\/api\/skins\/[0-9a-f]{64}\.png$/);
  assert.equal(p.skinSlim, true);
  assert.ok(fs.existsSync(path.join(dataDir, 'skins', p.skinUrl.split('/').pop())));

  const img = await alice.get(p.skinUrl);
  assert.equal(img.status, 200);
  assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(img.headers.get('cache-control'), 'public, max-age=31536000, immutable', 'имя — хеш картинки, она не меняется');
  assert.equal(img.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(img.data.equals(SKIN_PNG));
  assert.equal((await alice.get(p.skinUrl, { 'If-None-Match': img.headers.get('etag') })).status, 304);
  assert.equal((await bob.get(p.skinUrl)).status, 200);
  assert.equal((await client().get(p.skinUrl)).status, 200, 'карточки публичные — скины тоже');
  assert.equal((await client().get(p.skinUrl.replace(/\.png$/, ''))).status, 200);
  assert.equal((await alice.get('/api/skins/..%2F..%2Flwl.db')).status, 404);
  assert.equal((await alice.get('/api/skins/' + 'f'.repeat(64) + '.png')).status, 404);

  // Тот же скин ещё раз — заново не качается; без скина в запросе — старый остаётся.
  const hits = textureHits.length;
  await game('POST', '/api/game/stats', { players: [statsOf('Alice_07', { skin: { url: `${texturesOrigin}/texture/${hex}`, slim: true } })] });
  await app.skins.idle();
  assert.equal(textureHits.length, hits);
  await game('POST', '/api/game/stats', { players: [statsOf('Alice_07')] });
  assert.equal((await alice.get('/api/players/Alice_07')).data.player.skinUrl, p.skinUrl);
});

/** Тот же PNG 64×64 с лишними байтами после IEND: картинка та же, хеш другой. */
const skinVariant = (n) => Buffer.concat([SKIN_PNG, Buffer.from(`lwl${n}`)]);

test('свой скин: загрузка в кабинете, проверка файла, без RCON — только на сайте', async () => {
  const raw = (who, body, model) => who.put('/api/me/skin', body, { 'Content-Type': 'application/octet-stream', ...(model ? { 'X-Skin-Model': model } : {}) });
  assert.equal((await raw(alice, Buffer.from('<html>не картинка</html>'))).status, 422);
  assert.equal((await raw(alice, PNG)).status, 422, 'PNG, но не 64×64');
  assert.equal((await raw(alice, Buffer.concat([SKIN_PNG, Buffer.alloc(70 * 1024)]))).status, 413);
  assert.equal((await client().put('/api/me/skin', SKIN_PNG, { 'Content-Type': 'application/octet-stream' })).status, 401);

  const up = await raw(alice, skinVariant(1), 'slim');
  assert.equal(up.status, 200);
  assert.equal(up.data.skin.slim, true);
  assert.equal(up.data.skin.sync.status, 'off', 'RCON не настроен');
  assert.match(up.data.skin.sync.message, /RCON/);
  assert.equal(up.data.card.skinUrl, up.data.skin.url, 'на карточке — свой скин (он новее скина из игры)');
  assert.equal(up.data.card.skinSlim, true);
  const img = await client().get(up.data.skin.url);
  assert.ok(img.data.equals(skinVariant(1)));

  // Сменил скин в игре — на карточке он (свежее), свой из кабинета остаётся в запасе.
  await new Promise((r) => setTimeout(r, 5));
  await game('POST', '/api/game/stats', { players: [statsOf('Alice_07', { skin: { url: `${texturesOrigin}/texture/ffff0000ffff0000`, slim: false } })] });
  await app.skins.idle();
  const after = (await client().get('/api/players/Alice_07')).data.player;
  assert.notEqual(after.skinUrl, up.data.skin.url);
  assert.equal(after.skinSlim, false);

  // Тонкие/обычные руки — без новой загрузки, и свой скин снова главный.
  const model = await alice.patch('/api/me/skin', { slim: false });
  assert.equal(model.status, 200);
  assert.equal(model.data.card.skinUrl, up.data.skin.url);
  assert.equal((await alice.patch('/api/me/skin', { slim: 'yes' })).status, 422);
  assert.equal((await bob.patch('/api/me/skin', { slim: true })).status, 403);
  assert.equal((await alice.post('/api/me/skin/sync')).data.skin.sync.status, 'off');

  // «Как в игре»: свой скин убран — на карточке снова скин из игры. Без RCON на сервер ничего не ставилось,
  // значит скин из игры — настоящий, его не трогаем.
  const removed = await alice.del('/api/me/skin');
  assert.equal(removed.status, 200);
  assert.equal(removed.data.skin, null);
  assert.equal(removed.data.card.skinUrl, after.skinUrl);
  assert.equal((await alice.post('/api/me/skin/sync')).status, 404);
  // Файл никто не использует — sweep уберёт его через сутки, а пока он на диске.
  assert.ok(fs.existsSync(path.join(dataDir, 'skins', up.data.skin.url.split('/').pop())));
});

test('карточки: своя поза для маленькой карточки и для окна игрока', async () => {
  const ip = { 'X-Real-IP': '10.88.0.1' };
  const patch = (body) => alice.raw('PATCH', '/api/me/card', body, ip);
  const custom = { head: [10, -20, 0], body: [0, 5, 0], rightArm: [-90, 0, 0], leftArm: [0, 0, 40], rightLeg: [20, 0, 0], leftLeg: [-20, 0, 0], lift: -2 };
  for (const looks of [
    'stand',
    { side: { pose: 'stand' } },
    { card: { pose: 'dab' } },
    { card: { pose: 'custom' } },
    { card: { pose: 'stand', scale: 21 } },
    { card: { pose: 'stand', scale: 0.01 } },
    { detail: { pose: 'stand', turn: 999 } },
    { detail: { pose: 'stand', turn: '45' } },
    { card: { pose: 'stand', camera: { yaw: 200, pitch: 0 } } },
    { card: { pose: 'stand', camera: { yaw: 0, pitch: 95 } } },
    { card: { pose: 'stand', camera: [0, 0] } },
    { card: { pose: 'stand', pos: [0, 0, 2000] } },
    { card: { pose: 'stand', pos: [0, 0] } },
    { card: { pose: 'stand', size: 25 } },
    { card: { pose: 'stand', size: 0 } },
    { card: { pose: 'custom', angles: { ...custom, head: [999, 0, 0] } } },
    { card: { pose: 'custom', angles: { ...custom, body: [0, 0] } } },
    { card: { pose: 'custom', angles: { ...custom, lift: 65 } } },
    { card: { pose: 'custom', angles: { ...custom, move: { head: [0, 257, 0] } } } },
    { card: { pose: 'custom', angles: { ...custom, move: { body: [-257, 0, 0] } } } },
    { card: { pose: 'custom', angles: { ...custom, move: { tail: [1, 0, 0] } } } },
    { card: { pose: 'custom', angles: { ...custom, move: { head: [1, 0] } } } },
    { card: { pose: 'custom', angles: { ...custom, move: [1, 2, 3] } } },
    { card: { pose: 'custom', angles: { ...custom, stretch: { head: [0.01, 1, 1] } } } },
    { card: { pose: 'custom', angles: { ...custom, stretch: { body: [1, 21, 1] } } } },
    { card: { pose: 'custom', angles: { ...custom, stretch: { tail: [1, 1, 1] } } } },
    { card: { pose: 'custom', angles: { ...custom, stretch: [1, 1, 1] } } },
  ]) {
    const r = await patch({ looks });
    assert.equal(r.status, 422, JSON.stringify(looks));
    assert.ok(r.data.fields.looks);
  }

  const r = await patch({ looks: { card: { pose: 'cheer', scale: 1.2, turn: -30.4 }, detail: { pose: 'custom', angles: { ...custom, extra: [1, 2, 3] }, scale: 0.9, turn: 45 } } });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.looks.card, { pose: 'cheer', scale: 1.2, turn: -30 });
  assert.deepEqual(r.data.looks.detail, { pose: 'custom', scale: 0.9, turn: 45, angles: custom }, 'лишнее выброшено');
  assert.equal(r.data.pose, 'cheer', 'старое поле — поза маленькой карточки');
  assert.deepEqual((await client().get('/api/players/Alice_07')).data.player.looks, r.data.looks, 'видно всем');

  // Меняем одну — вторая остаётся.
  const one = await patch({ looks: { card: { pose: 'sit' } } });
  assert.deepEqual(one.data.looks.card, { pose: 'sit', scale: 1, turn: 0 });
  assert.equal(one.data.looks.detail.pose, 'custom');
  // Своя поза на карточке — старое поле pose остаётся прежним.
  assert.equal((await patch({ looks: { card: { pose: 'custom', angles: custom } } })).data.pose, 'sit');
  // Старые клиенты шлют pose — это поза маленькой карточки.
  const old = await patch({ pose: 'walk' });
  assert.deepEqual(old.data.looks.card, { pose: 'walk', scale: 1, turn: 0 });
  assert.equal(old.data.looks.detail.pose, 'custom');
  // Сдвиг частей тела: до ±256, нулевые сдвиги не хранятся.
  const moved = await patch({ looks: { detail: { pose: 'custom', angles: { ...custom, move: { head: [0, 256, -1.24], leftArm: [-32, 0, 0], body: [0, 0, 0] } } } } });
  assert.equal(moved.status, 200);
  assert.deepEqual(moved.data.looks.detail.angles.move, { head: [0, 256, -1.2], leftArm: [-32, 0, 0] });
  const still = await patch({ looks: { detail: { pose: 'custom', angles: { ...custom, move: { body: [0, 0, 0] } } } } });
  assert.equal(still.data.looks.detail.angles.move, undefined, 'одни нули — сдвига нет');
  // Растяжение частей тела: от 0,05 до 20 по каждой оси, «как есть» (1, 1, 1) не хранится.
  const stretched = await patch({ looks: { detail: { pose: 'custom', angles: { ...custom, stretch: { body: [1.5, 0.05, 20], leftLeg: [1.004, 2, 1], head: [1, 1, 1] } } } } });
  assert.equal(stretched.status, 200);
  assert.deepEqual(stretched.data.looks.detail.angles.stretch, { body: [1.5, 0.05, 20], leftLeg: [1, 2, 1] });
  const plain = await patch({ looks: { detail: { pose: 'custom', angles: { ...custom, stretch: { head: [1, 1, 1] } } } } });
  assert.equal(plain.data.looks.detail.angles.stretch, undefined, 'одни единицы — растяжения нет');
  // Камера вида, место и размер фигуры: камера хранится как есть (округлённой), место без нулей, размер 1 не хранится.
  const framed = await patch({ looks: { card: { pose: 'stand', scale: 0.05, camera: { yaw: -179.6, pitch: 89.4 }, pos: [0, 0, 0], size: 1 }, detail: { pose: 'stand', scale: 20, camera: { yaw: 25, pitch: -10 }, pos: [1024, -1024, 3.25], size: 0.05 } } });
  assert.equal(framed.status, 200);
  assert.deepEqual(framed.data.looks.card, { pose: 'stand', scale: 0.05, turn: 0, camera: { yaw: -180, pitch: 89 } });
  assert.deepEqual(framed.data.looks.detail, { pose: 'stand', scale: 20, turn: 0, camera: { yaw: 25, pitch: -10 }, pos: [1024, -1024, 3.3], size: 0.05 });
  await patch({ looks: { card: { pose: 'wave' }, detail: { pose: 'wave' } } });
});

// Настоящая PNG w×h одного цвета (RGBA): подпись, IHDR, IDAT (строки с фильтром 0, сжатые deflate), IEND; у кусков — CRC32.
function solidPng(w, h, rgba = [0x5d, 0xa1, 0x3c, 0xff]) {
  const chunk = (type, data) => {
    const head = Buffer.alloc(8);
    head.writeUInt32BE(data.length, 0);
    head.write(type, 4, 'latin1');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0);
    return Buffer.concat([head, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // бит на канал
  ihdr[9] = 6; // RGBA; сжатие, фильтр, чересстрочность — 0
  const row = Buffer.from([0, ...Array.from({ length: w }, () => rgba).flat()]);
  const pixels = deflateSync(Buffer.concat(Array(h).fill(row)));
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]);
}

test('карточки: предметы в руках, блоки вокруг и свои картинки 16×16', async () => {
  const ip = { 'X-Real-IP': '10.88.0.3' };
  const patch = (body) => alice.raw('PATCH', '/api/me/card', body, ip);
  const png = (w, h) => 'data:image/png;base64,' + solidPng(w, h).toString('base64');
  const tex = png(16, 16);
  const stone = { id: 'stone', at: [0, 0, 0] };
  for (const [look, message] of [
    [{ held: { rightHand: { id: 'diamond_swordd' } } }, 'Такого предмета нет.'],
    [{ held: { head: { id: 'tex1' } } }, 'Такого предмета нет.'], // своих картинок нет вовсе
    [{ blocks: [{ id: 'diamond_sword', at: [0, 0, 0] }] }, 'Такого блока нет.'], // предмет, а не блок
    [{ textures: [tex], blocks: [{ id: 'tex2', at: [0, 0, 0] }] }, 'Такого блока нет.'],
    [{ blocks: Array(65).fill(stone) }, 'Блоков — не больше 64.'],
    [{ blocks: [{ id: 'stone', at: [0, 2000, 0] }] }, 'Блок слишком далеко.'],
    [{ blocks: [{ id: 'stone' }] }, 'Блок слишком далеко.'], // без места
    [{ held: { head: { id: 'carved_pumpkin', size: 9 } } }, 'Размер предмета — от 0.1 до 8.'],
    [{ held: { foot: { id: 'diamond_sword' } } }, 'Предмет можно держать только в руках или на голове.'],
    [{ offset: [2500, 0] }, 'Сдвиг — от −2000 до 2000.'],
    // Головы: только известные, скин — только у головы игрока и только такой, какой бывает.
    [{ held: { head: { id: 'herobrine_head' } } }, 'Такого предмета нет.'],
    [{ held: { head: { id: 'zombie_head', skin: 'wide/steve' } } }, 'Неверный скин головы.'],
    [{ held: { head: { id: 'player_head', skin: 'https://example.com/skin.png' } } }, 'Неверный скин головы.'],
    [{ blocks: [{ id: 'player_head', at: [0, 0, 0], skin: 'wide/herobrine' }] }, 'Неверный скин головы.'],
    // Мобы.
    [{ mobs: [{ type: 'herobrine', at: [0, 0, 0] }] }, 'Такого моба нет.'],
    [{ mobs: [{ type: 'zombie' }] }, 'Моб слишком далеко.'],
    [{ mobs: [{ type: 'zombie', at: [0, 0, 5000] }] }, 'Моб слишком далеко.'],
    [{ mobs: [{ type: 'zombie', at: [0, 0, 0], size: 10 }] }, 'Размер моба — от 0.1 до 8.'],
    [{ mobs: [{ type: 'zombie', at: [0, 0, 0], pose: 'dab' }] }, 'Такой позы у моба нет.'],
    [{ mobs: [{ type: 'zombie', at: [0, 0, 0], skin: 'wide/steve' }] }, 'Неверный скин игрока.'],
    [{ mobs: [{ type: 'zombie', at: [0, 0, 0], pose: 'custom', angles: {} }] }, 'Свою позу можно задать только игроку.'],
    [{ mobs: [{ type: 'player', at: [0, 0, 0], pose: 'custom' }] }, 'Для своей позы нужны углы.'],
    [{ mobs: Array(17).fill({ type: 'pig', at: [0, 0, 0] }) }, 'Мобов — не больше 16.'],
    [{ textures: ['data:image/png;base64,' + Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>').toString('base64')] }, 'Своя картинка — PNG 16×16.'],
    [{ textures: [png(17, 17)] }, 'Своя картинка — PNG 16×16.'],
    [{ textures: [tex, tex, tex, tex] }, 'Своих картинок — не больше 3.'],
  ]) {
    const r = await patch({ looks: { card: { pose: 'stand', ...look } } });
    assert.equal(r.status, 422, JSON.stringify(look).slice(0, 200));
    assert.equal(r.data.fields.looks, message, JSON.stringify(look).slice(0, 200));
  }

  const r = await patch({
    looks: {
      // Пустое (нулевой сдвиг, пустые слоты и списки) не хранится.
      card: { pose: 'wave', offset: [0, 0], held: { leftHand: null }, blocks: [], textures: [] },
      detail: {
        pose: 'stand',
        offset: [12.34, -5],
        textures: [tex],
        held: { rightHand: { id: 'diamond_sword', rot: [10.4, -20, 0], size: 1.234, at: [1.25, 0, -2] }, leftHand: null, head: { id: 'carved_pumpkin' } },
        blocks: [stone, { id: 'grass_block', at: [-16.04, -16, 32], rot: 89.6, size: 0.5, extra: 1 }, { id: 'tex1', at: [16, 0, 0] }],
        extra: true,
      },
    },
  });
  assert.equal(r.status, 200);
  assert.deepEqual(r.data.looks.card, { pose: 'wave', scale: 1, turn: 0 });
  assert.deepEqual(
    r.data.looks.detail,
    {
      pose: 'stand',
      scale: 1,
      turn: 0,
      offset: [12.3, -5],
      textures: [tex],
      held: {
        rightHand: { id: 'diamond_sword', rot: [10, -20, 0], size: 1.23, at: [1.3, 0, -2] },
        head: { id: 'carved_pumpkin', rot: [0, 0, 0], size: 1, at: [0, 0, 0] },
      },
      blocks: [
        { id: 'stone', at: [0, 0, 0], rot: 0, size: 1 },
        { id: 'grass_block', at: [-16, -16, 32], rot: 90, size: 0.5 },
        { id: 'tex1', at: [16, 0, 0], rot: 0, size: 1 },
      ],
    },
    'округлено, лишнее и пустые слоты выброшены'
  );
  assert.deepEqual((await client().get('/api/players/Alice_07')).data.player.looks, r.data.looks, 'видно всем');

  // Головы и мобы: стандартный скин игры, скин с сайта (sha256 файла в skins/) — только если он у нас есть.
  const known = (await client().get('/api/players/Alice_07')).data.player.skinUrl.split('/').pop().replace(/\.png$/, '');
  const missing = 'f'.repeat(64);
  const withMobs = await patch({
    looks: {
      card: {
        pose: 'stand',
        held: { head: { id: 'player_head', skin: 'slim/alex' }, rightHand: { id: 'creeper_head' } },
        blocks: [{ id: 'dragon_head', at: [0, 0, -32] }, { id: 'player_head', at: [16, 0, 0], skin: known }],
        mobs: [
          { type: 'zombie', at: [-24.04, 0, 0], rot: 30.4, pose: 'zombie' },
          { type: 'player', at: [24, 0, 0], skin: known, slim: true, size: 0.5 },
          { type: 'pig', at: [0, 16, 32], slim: false },
        ],
      },
    },
  });
  assert.equal(withMobs.status, 200, JSON.stringify(withMobs.data));
  assert.deepEqual(withMobs.data.looks.card.held.head, { id: 'player_head', rot: [0, 0, 0], size: 1, at: [0, 0, 0], skin: 'slim/alex' });
  assert.deepEqual(withMobs.data.looks.card.blocks[1].skin, known);
  assert.deepEqual(withMobs.data.looks.card.mobs, [
    { type: 'zombie', at: [-24, 0, 0], rot: 30, size: 1, pose: 'zombie' },
    { type: 'player', at: [24, 0, 0], rot: 0, size: 0.5, pose: 'stand', skin: known, slim: true },
    { type: 'pig', at: [0, 16, 32], rot: 0, size: 1, pose: 'stand' },
  ]);
  // Игрок на сцене — своя поза, как у персонажа: углы, сдвиг и растяжение частей.
  const limbs = { lift: -2.4, head: [10, 0, 0], body: [0, 5, 0], rightArm: [-90.4, 0, 0], leftArm: [0, 0, 40], rightLeg: [20, 0, 0], leftLeg: [-20, 0, 0], move: { head: [0, 4.04, 0], body: [0, 0, 0] }, stretch: { leftArm: [1, 2, 1], head: [1, 1, 1] } };
  const posed = await patch({ looks: { card: { pose: 'stand', mobs: [{ type: 'player', at: [0, 0, 0], skin: 'wide/kai', pose: 'custom', angles: limbs }] } } });
  assert.equal(posed.status, 200, JSON.stringify(posed.data));
  assert.deepEqual(posed.data.looks.card.mobs[0], {
    type: 'player',
    at: [0, 0, 0],
    rot: 0,
    size: 1,
    pose: 'custom',
    skin: 'wide/kai',
    angles: { lift: -2, head: [10, 0, 0], body: [0, 5, 0], rightArm: [-90, 0, 0], leftArm: [0, 0, 40], rightLeg: [20, 0, 0], leftLeg: [-20, 0, 0], move: { head: [0, 4, 0] }, stretch: { leftArm: [1, 2, 1] } },
  });
  const ghost = await patch({ looks: { card: { pose: 'stand', mobs: [{ type: 'player', at: [0, 0, 0], skin: missing }] } } });
  assert.equal(ghost.status, 422);
  assert.match(ghost.data.fields.looks, /Скин для головы или игрока/);
  await patch({ looks: { card: { pose: 'wave' }, detail: { pose: 'wave' } } });
});

test('карточки: скин лицензии по нику для головы и игрока на сцене (свой скин не меняется)', async () => {
  const ip = { 'X-Real-IP': '10.88.0.4' };
  const before = (await alice.get('/api/me/card')).data;
  const bad = await alice.raw('POST', '/api/skins/nick', { nickname: 'a b' }, ip);
  assert.equal(bad.status, 422);
  assert.equal((await client().raw('POST', '/api/skins/nick', { nickname: 'Notch' }, ip)).status, 401, 'только вошедшим игрокам');
  const none = await alice.raw('POST', '/api/skins/nick', { nickname: 'NoSuchPlayer_1' }, ip);
  assert.equal(none.status, 422);
  assert.match(none.data.fields.nickname, /Лицензии с ником NoSuchPlayer_1 нет/);
  const plain = await alice.raw('POST', '/api/skins/nick', { nickname: 'PlainGuy' }, ip);
  assert.equal(plain.status, 200);
  assert.deepEqual(plain.data, { nickname: 'PlainGuy', skin: 'wide/steve', slim: false }, 'у лицензии стандартный скин — Стив');
  const notch = await alice.raw('POST', '/api/skins/nick', { nickname: 'notch' }, ip);
  assert.equal(notch.status, 200);
  assert.equal(notch.data.nickname, 'Notch');
  assert.equal(notch.data.slim, true);
  assert.match(notch.data.skin, /^[0-9a-f]{64}$/);
  assert.ok((await client().get(`/api/skins/${notch.data.skin}.png`)).data.equals(SKIN_PNG), 'скин лежит на сайте');
  // Им можно сразу поставить голову.
  const head = await alice.raw('PATCH', '/api/me/card', { looks: { card: { pose: 'stand', held: { head: { id: 'player_head', skin: notch.data.skin } } } } }, ip);
  assert.equal(head.status, 200);
  const after = (await alice.get('/api/me/card')).data;
  assert.equal(after.card.skinUrl, before.card.skinUrl, 'свой скин тот же');

  // Чистка: скин, на который ссылается только игрок на сцене, не удаляется; перестали ссылаться — удаляется.
  const data = skinVariant(9);
  const hash = createHash('sha256').update(data).digest('hex');
  await app.skins.store(hash, data);
  const file = path.join(dataDir, 'skins', hash + '.png');
  const old = new Date(Date.now() - 3 * 24 * 3600 * 1000);
  fs.utimesSync(file, old, old);
  assert.equal((await alice.raw('PATCH', '/api/me/card', { looks: { detail: { pose: 'stand', mobs: [{ type: 'player', at: [0, 0, 0], skin: hash }] } } }, ip)).status, 200);
  app.skins.sweep();
  assert.ok(fs.existsSync(file), 'нужен карточке — остаётся');
  await alice.raw('PATCH', '/api/me/card', { looks: { card: { pose: 'wave' }, detail: { pose: 'wave' } } }, ip);
  app.skins.sweep();
  assert.ok(!fs.existsSync(file), 'никому не нужен — удалён');
});

test('карточки: свой фон — проверка, хранение, замена, модерация', async () => {
  const ip = { 'X-Real-IP': '10.88.0.2' };
  const octet = { 'Content-Type': 'application/octet-stream', ...ip };
  const put = (who, body) => who.put('/api/me/background', body, octet);
  const patch = (body) => alice.raw('PATCH', '/api/me/card', body, ip);
  // Заголовок WebP (VP8X): сайт смотрит только на него, картинку сжимает браузер.
  const webp = (w, h, flags = 0) => {
    const b = Buffer.alloc(30);
    b.write('RIFF', 0, 'latin1');
    b.writeUInt32LE(22, 4);
    b.write('WEBPVP8X', 8, 'latin1');
    b.writeUInt32LE(10, 16);
    b[20] = flags;
    b.writeUIntLE(w - 1, 24, 3);
    b.writeUIntLE(h - 1, 27, 3);
    return b;
  };
  const fileOf = (url) => path.join(dataDir, 'backgrounds', url.split('/').pop());

  assert.equal((await patch({ background: 'custom' })).status, 422, 'своей картинки ещё нет');
  assert.equal((await put(bob, webp(800, 450))).status, 403, 'только игроки');
  assert.equal((await put(client(), webp(800, 450))).status, 401);
  for (const [body, why] of [
    [Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'), 'svg'],
    [Buffer.from('GIF89a\x10\x00\x10\x00', 'latin1'), 'gif'],
    [webp(2000, 100), 'больше 1600 точек'],
    [webp(800, 450, 0x02), 'анимация'],
  ]) {
    const r = await put(alice, body);
    assert.equal(r.status, 422, why);
    assert.ok(r.data.fields.background, why);
  }
  assert.equal((await put(alice, Buffer.alloc(400 * 1024 + 1))).status, 413);

  const up = await put(alice, webp(800, 450));
  assert.equal(up.status, 200);
  assert.equal(up.data.background, 'custom');
  assert.match(up.data.backgroundUrl, /^\/api\/backgrounds\/[0-9a-f]{64}\.webp$/);
  assert.equal(up.data.customBackground, up.data.backgroundUrl);
  const file = await client().get(up.data.backgroundUrl);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/webp');
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(file.data.equals(webp(800, 450)));
  const guest = (await client().get('/api/players/Alice_07')).data.player;
  assert.equal(guest.backgroundUrl, up.data.backgroundUrl);
  for (const bad of ['..%2Flwl.db', 'abc.webp', `${'a'.repeat(64)}.svg`]) assert.equal((await client().get(`/api/backgrounds/${bad}`)).status, 404, bad);

  // Поставили другую — старая картинка сразу удаляется с диска.
  const up2 = await put(alice, SKIN_PNG);
  assert.match(up2.data.backgroundUrl, /\.png$/);
  assert.ok(fs.existsSync(fileOf(up2.data.backgroundUrl)));
  assert.ok(!fs.existsSync(fileOf(up.data.backgroundUrl)), 'старая удалена');

  // Заготовка — картинка остаётся, её можно вернуть.
  const preset = await patch({ background: 'snow' });
  assert.equal(preset.data.background, 'snow');
  assert.equal(preset.data.backgroundUrl, null);
  assert.equal(preset.data.customBackground, up2.data.backgroundUrl);
  assert.equal((await client().get('/api/players/Alice_07')).data.player.backgroundUrl, null);
  assert.equal((await patch({ background: 'custom' })).data.backgroundUrl, up2.data.backgroundUrl);

  // Модерация: картинку видят все — админ с правом «Люди» её убирает.
  assert.equal((await alice.del('/api/players/Alice_07/background')).status, 403);
  const mod = await owner.del('/api/players/Alice_07/background');
  assert.equal(mod.status, 200);
  assert.equal(mod.data.player.background, 'meadow');
  assert.equal(mod.data.player.backgroundUrl, null);
  assert.ok(!fs.existsSync(fileOf(up2.data.backgroundUrl)));
  assert.equal((await owner.del('/api/players/nobody_here/background')).status, 404);

  // Убрать свою.
  const again = await put(alice, webp(640, 360));
  const removed = await alice.del('/api/me/background');
  assert.equal(removed.data.background, 'meadow');
  assert.equal(removed.data.customBackground, null);
  assert.ok(!fs.existsSync(fileOf(again.data.backgroundUrl)));
});

test('карточки: модерация своих картинок 16×16 — убираются картинки и всё, что на них ссылается', async () => {
  const ip = { 'X-Real-IP': '10.88.0.4' };
  const tex = 'data:image/png;base64,' + solidPng(16, 16).toString('base64');
  const tex2 = 'data:image/png;base64,' + solidPng(16, 16, [0xff, 0, 0, 0xff]).toString('base64');
  const set = await alice.raw(
    'PATCH',
    '/api/me/card',
    {
      looks: {
        card: { pose: 'wave', textures: [tex], held: { head: { id: 'tex1' } }, blocks: [{ id: 'tex1', at: [0, 0, 0] }] },
        detail: {
          pose: 'stand',
          offset: [5, 0],
          textures: [tex, tex2],
          held: { rightHand: { id: 'tex2' }, leftHand: { id: 'diamond_sword' }, head: { id: 'carved_pumpkin' } },
          blocks: [{ id: 'stone', at: [0, 0, 0] }, { id: 'tex1', at: [16, 0, 0] }, { id: 'tex2', at: [-16, 0, 0] }],
        },
      },
    },
    ip
  );
  assert.equal(set.status, 200);
  assert.equal(set.data.looks.detail.textures.length, 2);

  assert.equal((await client().del('/api/players/Alice_07/textures')).status, 401);
  assert.equal((await alice.del('/api/players/Alice_07/textures')).status, 403, 'игрок не может');
  assert.equal((await owner.del('/api/players/nobody_here/textures')).status, 404);

  const mod = await owner.del('/api/players/Alice_07/textures');
  assert.equal(mod.status, 200);
  const expected = {
    card: { pose: 'wave', scale: 1, turn: 0 },
    detail: {
      pose: 'stand',
      scale: 1,
      turn: 0,
      offset: [5, 0],
      held: {
        leftHand: { id: 'diamond_sword', rot: [0, 0, 0], size: 1, at: [0, 0, 0] },
        head: { id: 'carved_pumpkin', rot: [0, 0, 0], size: 1, at: [0, 0, 0] },
      },
      blocks: [{ id: 'stone', at: [0, 0, 0], rot: 0, size: 1 }],
    },
  };
  assert.deepEqual(mod.data.player.looks, expected, 'картинки и ссылки на них убраны, остальное осталось');
  assert.deepEqual((await client().get('/api/players/Alice_07')).data.player.looks, expected, 'гости тоже видят без картинок');
  assert.deepEqual((await alice.get('/api/me/card')).data.looks, expected);
  // Повтор — ничего не ломает.
  assert.deepEqual((await owner.del('/api/players/Alice_07/textures')).data.player.looks, expected);

  await alice.raw('PATCH', '/api/me/card', { looks: { card: { pose: 'wave' }, detail: { pose: 'wave' } } }, ip);
});

test('скин по нику лицензии: сайт спрашивает Mojang, картинку берёт с textures.minecraft.net', async () => {
  // Лимит смен скина — по IP: у этого теста свой адрес, чтобы не делить его с тестом загрузки.
  const ip = { 'X-Real-IP': '10.77.0.1' };
  const byNick = (who, nickname) => who.post('/api/me/skin/nick', { nickname }, ip);
  assert.equal((await client().post('/api/me/skin/nick', { nickname: 'Notch' })).status, 401);
  assert.equal((await bob.post('/api/me/skin/nick', { nickname: 'Notch' }, ip)).status, 403, 'нужна одобренная заявка');

  // Неверный ник — до Mojang дело не доходит.
  const hitsBefore = mojangHits.length;
  for (const bad of ['ab', 'a'.repeat(17), 'Not ch', '../../x', 'Нотч']) {
    const r = await byNick(owner, bad);
    assert.equal(r.status, 422, bad);
    assert.ok(r.data.fields.nickname);
  }
  assert.equal(mojangHits.length, hitsBefore);

  const none = await byNick(owner, 'NoSuchGuy');
  assert.equal(none.status, 422);
  assert.match(none.data.fields.nickname, /Лицензии с ником NoSuchGuy нет/);
  assert.match((await byNick(owner, 'PlainGuy')).data.fields.nickname, /стандартный скин/);
  assert.match((await byNick(owner, 'busy')).data.fields.nickname, /подождать/);

  const got = await byNick(owner, 'notch');
  assert.equal(got.status, 200);
  assert.equal(got.data.skin.nick, 'Notch', 'ник — как у Mojang');
  assert.equal(got.data.skin.slim, true);
  assert.equal(got.data.skin.sync.status, 'off');
  assert.equal(got.data.card.skinUrl, got.data.skin.url);
  assert.ok((await client().get(got.data.skin.url)).data.equals(SKIN_PNG));
  assert.ok(textureHits.includes('/texture/a0a0a0a0a0a0a0a0'));

  // Ответ Mojang кешируется: второй раз — без запросов.
  const hits = mojangHits.length;
  assert.equal((await byNick(owner, 'Notch')).status, 200);
  assert.equal(mojangHits.length, hits);

  // Старый адрес Mojang сломался — спрашиваем новый.
  const flaky = await byNick(owner, 'flaky');
  assert.equal(flaky.status, 200);
  assert.equal(flaky.data.skin.nick, 'Flaky');
  assert.equal(flaky.data.skin.slim, false);
  assert.ok(mojangHits.includes('/minecraft/profile/lookup/name/flaky'));

  // Руки поменяли вручную — это уже свой скин, а не «как у лицензии».
  const hands = await owner.raw('PATCH', '/api/me/skin', { slim: true }, ip);
  assert.equal(hands.status, 200);
  assert.equal(hands.data.skin.nick, null);

  const removed = await owner.raw('DELETE', '/api/me/skin', undefined, ip);
  assert.equal(removed.data.skin, null);
});

test('сборки: загрузка, проверка файла, публикация, скачивание с докачкой', async () => {
  const created = await owner.post('/api/admin/packs', { title: 'LWL для Prism', launcher: 'prism', version: '1.0', description: 'Импорт: Добавить экземпляр → Импорт' });
  packId = created.data.pack.id;
  assert.equal((await owner.patch(`/api/admin/packs/${packId}`, { published: true })).status, 422, 'без файла не публикуется');
  const notZip = await owner.put(`/api/admin/packs/${packId}/file`, Buffer.from('hello world, not a zip'), { 'X-File-Name': 'pack.zip', 'Content-Type': 'application/octet-stream' });
  assert.equal(notZip.status, 422);
  const wrongExt = await owner.put(`/api/admin/packs/${packId}/file`, ZIP, { 'X-File-Name': 'virus.exe', 'Content-Type': 'application/octet-stream' });
  assert.equal(wrongExt.status, 422);
  const tooBig = await owner.put(`/api/admin/packs/${packId}/file`, Buffer.concat([ZIP, Buffer.alloc(1024 * 1024)]), { 'X-File-Name': 'big.zip', 'Content-Type': 'application/octet-stream' });
  assert.equal(tooBig.status, 413);
  const up = await owner.put(`/api/admin/packs/${packId}/file`, ZIP, { 'X-File-Name': encodeURIComponent('Сборка LWL.zip'), 'Content-Type': 'application/octet-stream' });
  assert.equal(up.status, 200);
  assert.equal(up.data.pack.fileSize, ZIP.length);
  assert.equal((await alice.get('/api/me/server')).data.packs.length, 0, 'неопубликованную не видно');
  await owner.patch(`/api/admin/packs/${packId}`, { published: true });
  const packs = (await alice.get('/api/me/server')).data.packs;
  assert.equal(packs.length, 1);
  const file = await alice.get(packs[0].downloadUrl);
  assert.equal(file.status, 200);
  assert.ok(Buffer.compare(file.data, ZIP) === 0);
  assert.match(file.headers.get('content-disposition'), /filename\*=UTF-8''%D0%A1/);
  const part = await alice.get(packs[0].downloadUrl, { Range: 'bytes=4-9' });
  assert.equal(part.status, 206);
  assert.equal(part.data.length, 6);
  assert.equal((await bob.get(packs[0].downloadUrl)).status, 403, 'пользователю без роли «Игрок» нельзя');
  assert.equal((await owner.get('/api/admin/packs')).data.items[0].downloads, 1);
});

test('статика: страницы есть, служебные файлы не отдаются', async () => {
  const index = await fetch(base + '/');
  assert.equal(index.status, 200);
  assert.match(index.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal((await fetch(base + '/players.html')).status, 200, 'страница игроков');
  for (const p of ['/server/app.js', '/data/lwl.db', '/package.json', '/.git/config', '/assets/../server/app.js', '/tests/api.test.mjs']) {
    assert.equal((await fetch(base + p)).status, 404, p);
  }
});

test('удаление аккаунта удаляет заявки, переписку и файлы из чата', async () => {
  assert.equal((await alice.del('/api/me', { password: 'wrong' })).status, 401);
  assert.equal((await alice.del('/api/me', { password: 'Passw0rd1' })).status, 204);
  assert.equal((await owner.get('/api/applications?status=all')).data.items.length, 0);
  assert.equal((await owner.get('/api/conversations?status=all')).data.items.length, 0);
  assert.ok(aliceFiles.length > 0 && aliceFiles.every((id) => !fs.existsSync(attachmentFile(id))), 'фото и файлы из чата удалены с диска');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM connect_codes c LEFT JOIN users u ON u.id = c.user_id WHERE u.id IS NULL').get().n, 0, 'код входа удалён вместе с аккаунтом');
  assert.equal(app.db.prepare('SELECT COUNT(*) AS n FROM player_cards c LEFT JOIN users u ON u.id = c.user_id WHERE u.id IS NULL').get().n, 0, '«о себе» удалено вместе с аккаунтом');
  assert.equal((await connect(aliceCode, 'Alice_07')).status, 404);
});

/* ------------------------------------------------------------ автовайтлист (RCON) */

/** Поддельный Minecraft-сервер с RCON: тот же протокол, отвечает как мод LWL Auth. */
function fakeRcon(password) {
  const commands = [];
  const server = net.createServer((sock) => {
    let buf = Buffer.alloc(0);
    let authed = false;
    const send = (id, type, text) => {
      const body = Buffer.from(text, 'utf8');
      const out = Buffer.alloc(14 + body.length);
      out.writeInt32LE(10 + body.length, 0);
      out.writeInt32LE(id, 4);
      out.writeInt32LE(type, 8);
      body.copy(out, 12);
      sock.write(out);
    };
    sock.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4 && buf.length >= 4 + buf.readInt32LE(0)) {
        const len = buf.readInt32LE(0);
        const id = buf.readInt32LE(4);
        const type = buf.readInt32LE(8);
        const text = buf.toString('utf8', 12, 4 + len - 2);
        buf = buf.subarray(4 + len);
        if (type === 3) {
          authed = text === password;
          send(authed ? id : -1, 2, '');
        } else if (type === 2 && authed) {
          commands.push(text);
          const m = /^wl add (\w+)/.exec(text);
          const rm = /^wl remove (\w+)$/.exec(text);
          if (rm) send(id, 0, `${rm[1]} убран из вайтлиста.`);
          else if (/^skin of \w+ url /.test(text)) send(id, 0, 'Загружаю скин по ссылке, это займёт несколько секунд…');
          else if (/^skin of \w+ set (\w+)$/.test(text)) send(id, 0, `Ищу скин лицензии ${text.split(' ').pop()}…`);
          else if (/^skin of \w+ clear$/.test(text)) send(id, 0, '');
          else if (/^skin of \w+ status$/.test(text)) send(id, 0, self.status);
          else send(id, 0, m ? `${m[1]} добавлен в вайтлист.` : 'Вайтлист выключен, в нём пока никого нет.');
        }
      }
    });
  });
  const self = { server, commands, status: 'Скин: готов.' };
  return self;
}

test('автовайтлист: одобрение сразу добавляет ник через RCON, ошибки видны и повторяемы', async () => {
  const rcon = fakeRcon('rcon-secret');
  await new Promise((r) => rcon.server.listen(0, '127.0.0.1', r));
  const rconPort = rcon.server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwl-rcon-'));
  const app2 = createApp(loadConfig({ LWL_DATA_DIR: dir, LWL_ADMINS: 'boss@example.com', LWL_FAST_HASH: '1', LWL_RCON_PASSWORD: 'rcon-secret', LWL_RCON_PORT: String(rconPort), LWL_RCON_TIMEOUT_MS: '2000' }));
  await new Promise((r) => app2.server.listen(0, '127.0.0.1', r));
  const saved = base;
  base = `http://127.0.0.1:${app2.server.address().port}`;
  try {
    const boss = client();
    const dave = client();
    const erin = client();
    await boss.post('/api/auth/register', { nickname: 'Boss_1', email: 'boss@example.com', password: 'Passw0rd1' });
    await dave.post('/api/auth/register', { nickname: 'Dave_1', email: 'dave@example.com', password: 'Passw0rd1' });
    await erin.post('/api/auth/register', { nickname: 'Erin_1', email: 'erin@example.com', password: 'Passw0rd1' });

    const st = (await boss.get('/api/admin/settings')).data;
    assert.deepEqual(st.rcon, { enabled: true, address: `127.0.0.1:${rconPort}` }, 'пароль RCON в браузер не уходит');
    const ping = (await boss.post('/api/admin/rcon/test')).data;
    assert.equal(ping.ok, true);

    const dApp = (await dave.post('/api/applications', application)).data.application;
    const approved = (await boss.post(`/api/applications/${dApp.id}/review`, { status: 'approved', comment: '' })).data.application;
    assert.equal(approved.whitelist.status, 'ok');
    assert.match(approved.whitelist.note, /Dave_1 добавлен в вайтлист/);
    assert.ok(rcon.commands.includes('wl add Dave_1 cracked'), 'пиратка — вход по паролю');

    // сервер выключен: заявка всё равно одобрена, ошибка сохранена, потом — «Повторить»
    await new Promise((r) => rcon.server.close(r));
    const eApp = (await erin.post('/api/applications', Object.assign({}, application, { license: 'premium' }))).data.application;
    const failed = (await boss.post(`/api/applications/${eApp.id}/review`, { status: 'approved', comment: '' })).data.application;
    assert.equal(failed.status, 'approved');
    assert.equal(failed.whitelist.status, 'error');
    assert.match(failed.whitelist.note, /выключен/);
    assert.equal((await erin.get('/api/auth/me')).data.user.role, 'player');
    await new Promise((r) => rcon.server.listen(rconPort, '127.0.0.1', r));
    const retried = (await boss.post(`/api/applications/${eApp.id}/whitelist`)).data.application;
    assert.equal(retried.whitelist.status, 'ok');
    assert.ok(rcon.commands.includes('wl add Erin_1'), 'лицензия — без cracked');
    assert.equal((await boss.post(`/api/applications/${dApp.id}/whitelist`)).status, 200);
    assert.equal((await dave.post(`/api/applications/${dApp.id}/whitelist`)).status, 403);

    // Роль «Игрок» сняли — ник убран из вайтлиста; удалили аккаунт — тоже. Обычного пользователя не трогаем.
    const daveId = (await dave.get('/api/auth/me')).data.user.id;
    assert.equal((await boss.patch(`/api/admin/users/${daveId}`, { role: 'user' })).status, 200);
    assert.equal(rcon.commands.at(-1), 'wl remove Dave_1');
    const erinId = (await erin.get('/api/auth/me')).data.user.id;
    assert.equal((await boss.del(`/api/admin/users/${erinId}`)).status, 204);
    assert.equal(rcon.commands.at(-1), 'wl remove Erin_1');
    const n = rcon.commands.length;
    assert.equal((await boss.del(`/api/admin/users/${daveId}`)).status, 204);
    assert.equal(rcon.commands.length, n, 'у «Пользователя» на сервере нечего убирать');
  } finally {
    base = saved;
    await app2.close();
    await new Promise((r) => rcon.server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('свой скин: сайт сам ставит его на сервер через RCON (/skin of <ник> url …)', async () => {
  const rcon = fakeRcon('rcon-secret');
  await new Promise((r) => rcon.server.listen(0, '127.0.0.1', r));
  const rconPort = rcon.server.address().port;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwl-skin-'));
  const config2 = loadConfig({ LWL_DATA_DIR: dir, LWL_ADMINS: 'boss@example.com', LWL_FAST_HASH: '1', LWL_RCON_PASSWORD: 'rcon-secret', LWL_RCON_PORT: String(rconPort), LWL_RCON_TIMEOUT_MS: '2000', LWL_PUBLIC_URL: 'https://lwl.example' });
  config2.skinOrigin = texturesOrigin;
  config2.mojang = mojangConfig;
  const app2 = createApp(config2);
  await new Promise((r) => app2.server.listen(0, '127.0.0.1', r));
  const saved = base;
  base = `http://127.0.0.1:${app2.server.address().port}`;
  try {
    const boss = client();
    await boss.post('/api/auth/register', { nickname: 'Boss_1', email: 'boss@example.com', password: 'Passw0rd1' });
    const up = await boss.put('/api/me/skin', SKIN_PNG, { 'Content-Type': 'application/octet-stream', 'X-Skin-Model': 'slim' });
    assert.equal(up.status, 200);
    assert.deepEqual(up.data.skin.sync, { status: 'ok', message: '' });
    const hash = up.data.skin.url.match(/[0-9a-f]{64}/)[0];
    assert.deepEqual(rcon.commands, [`skin of Boss_1 url https://lwl.example/api/skins/${hash}.png slim`], 'ссылка — на публичный адрес сайта');

    await boss.patch('/api/me/skin', { slim: false });
    assert.equal(rcon.commands.at(-1), `skin of Boss_1 url https://lwl.example/api/skins/${hash}.png`);

    // Сервер выключен — ошибка видна, «Повторить» отправляет ещё раз.
    await new Promise((r) => rcon.server.close(r));
    const failed = await boss.post('/api/me/skin/sync');
    assert.equal(failed.data.skin.sync.status, 'error');
    assert.match(failed.data.skin.sync.message, /выключен/);
    await new Promise((r) => rcon.server.listen(rconPort, '127.0.0.1', r));
    assert.equal((await boss.post('/api/me/skin/sync')).data.skin.sync.status, 'ok');

    await boss.del('/api/me/skin');
    assert.equal(rcon.commands.at(-1), 'skin of Boss_1 clear');
    assert.equal(rcon.commands.length, 4);

    // По нику — мод сам спросит Mojang: ссылка на сайт не нужна.
    const nick = await boss.post('/api/me/skin/nick', { nickname: 'notch' });
    assert.equal(nick.status, 200);
    assert.deepEqual(nick.data.skin.sync, { status: 'ok', message: '' });
    assert.equal(rcon.commands.at(-1), 'skin of Boss_1 set Notch');
    assert.equal((await boss.post('/api/me/skin/sync')).data.skin.sync.status, 'ok');
    assert.equal(rcon.commands.at(-1), 'skin of Boss_1 set Notch', '«Повторить» — та же команда');

    // Через несколько секунд сайт спрашивает у мода, чем кончилось: ошибка MineSkin/Mojang видна в кабинете.
    config2.skinCheckMs = 30;
    rcon.status = 'Скин Boss_1: загружается…';
    assert.equal((await boss.post('/api/me/skin/sync')).data.skin.sync.status, 'ok');
    await new Promise((r) => setTimeout(r, 60));
    assert.equal(rcon.commands.at(-1), 'skin of Boss_1 status');
    rcon.status = 'Скин Boss_1: ошибка — MineSkin не принял картинку.';
    await new Promise((r) => setTimeout(r, 120));
    const card = await boss.get('/api/me/card');
    assert.deepEqual(card.data.skin.sync, { status: 'error', message: 'MineSkin не принял картинку.' });
  } finally {
    base = saved;
    await app2.close();
    await new Promise((r) => rcon.server.close(() => r()));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('RCON: неверный пароль — понятная ошибка', async () => {
  const { rconCommand } = await import('../server/lib/rcon.js');
  const rcon = fakeRcon('right');
  await new Promise((r) => rcon.server.listen(0, '127.0.0.1', r));
  try {
    await assert.rejects(rconCommand({ host: '127.0.0.1', port: rcon.server.address().port, password: 'wrong', timeoutMs: 2000 }, 'wl list'), /не принял пароль/);
  } finally {
    await new Promise((r) => rcon.server.close(r));
  }
});

/** Поддельный SMTP: принимает письма и складывает их в mails (тело уже раскодировано из base64). */
function fakeSmtp() {
  const mails = [];
  const auths = [];
  const server = net.createServer((sock) => {
    let buf = '';
    let data = null;
    let mail = null;
    sock.write('220 fake ESMTP\r\n');
    sock.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      for (;;) {
        if (data !== null) {
          const end = buf.indexOf('\r\n.\r\n');
          if (end < 0) return;
          const raw = buf.slice(0, end).replace(/(^|\r\n)\.\./g, '$1.');
          buf = buf.slice(end + 5);
          data = null;
          const [head, body] = raw.split('\r\n\r\n');
          mails.push(Object.assign(mail, { head, text: Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8') }));
          sock.write('250 OK\r\n');
          continue;
        }
        const i = buf.indexOf('\r\n');
        if (i < 0) return;
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (/^EHLO/.test(line)) sock.write('250-fake\r\n250 AUTH PLAIN\r\n');
        else if (/^AUTH PLAIN /.test(line)) {
          auths.push(Buffer.from(line.slice(11), 'base64').toString('utf8'));
          sock.write('235 OK\r\n');
        } else if (/^MAIL FROM:/.test(line)) {
          mail = { from: line.slice(10) };
          sock.write('250 OK\r\n');
        } else if (/^RCPT TO:/.test(line)) {
          mail.to = line.slice(8);
          sock.write('250 OK\r\n');
        } else if (line === 'DATA') {
          data = '';
          sock.write('354 go\r\n');
        } else if (line === 'QUIT') sock.end('221 bye\r\n');
        else sock.write('500 ?\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return { server, mails, auths };
}

test('письма: ссылка сброса пароля приходит на почту и работает, решение по заявке — тоже письмом', async () => {
  const smtp = fakeSmtp();
  await new Promise((r) => smtp.server.listen(0, '127.0.0.1', r));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwl-mail-'));
  const mailApp = createApp(
    loadConfig({ LWL_DATA_DIR: dir, LWL_ADMINS: 'boss@example.com', LWL_FAST_HASH: '1', LWL_PUBLIC_URL: 'https://lwl.test', LWL_MAIL_FROM: 'site@lwl.test', LWL_SMTP_URL: `smtp://mailer:p%40ss@127.0.0.1:${smtp.server.address().port}` })
  );
  await new Promise((r) => mailApp.server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${mailApp.server.address().port}`;
  const call = (method, u, body, cookie) =>
    fetch(url + u, { method, headers: Object.assign({ 'X-Requested-With': 'lwl', 'Content-Type': 'application/json' }, cookie ? { Cookie: cookie } : {}), body: body && JSON.stringify(body) });
  const waitMails = async (n) => {
    for (let i = 0; i < 100 && smtp.mails.length < n; i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(smtp.mails.length, n);
  };
  const login = (res) => res.headers.getSetCookie()[0].split(';')[0];
  try {
    const boss = login(await call('POST', '/api/auth/register', { nickname: 'Boss_1', email: 'boss@example.com', password: 'password123' }));
    const carl = login(await call('POST', '/api/auth/register', { nickname: 'Carl_1', email: 'carl@example.com', password: 'password123' }));

    const res = await call('POST', '/api/auth/password-reset', { email: 'carl@example.com' });
    assert.deepEqual(await res.json(), { mail: true });
    assert.deepEqual(await (await call('POST', '/api/auth/password-reset', { email: 'nobody@example.com' })).json(), { mail: true }, 'ответ тот же для чужой почты');
    await waitMails(1);
    const m = smtp.mails[0];
    assert.equal(m.to, '<carl@example.com>');
    assert.equal(m.from, '<site@lwl.test>');
    assert.equal(smtp.auths[0], '\0mailer\0p@ss', 'логин и пароль из адреса раскодированы');
    assert.match(m.head, /Subject: =\?UTF-8\?B\?/);
    const token = m.text.match(/https:\/\/lwl\.test\/lk\.html#\/reset\/([\w-]+)/)[1];
    assert.equal((await call('GET', `/api/auth/password-reset/${token}`)).status, 200);
    await call('POST', '/api/auth/password-reset', { email: 'carl@example.com' });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(smtp.mails.length, 1, 'второе письмо на тот же аккаунт — не раньше чем через 10 минут');
    assert.equal((await call('POST', `/api/auth/password-reset/${token}`, { password: 'newpassword1' })).status, 200);
    const relogin = await call('POST', '/api/auth/login', { login: 'Carl_1', password: 'newpassword1' });
    assert.equal(relogin.status, 200);
    assert.equal((await call('GET', '/api/auth/me', undefined, carl)).status, 401, 'смена пароля завершает старые сессии');

    const app1 = await (await call('POST', '/api/applications', application, login(relogin))).json();
    assert.ok(app1.application, JSON.stringify(app1));
    assert.equal((await call('POST', `/api/applications/${app1.application.id}/review`, { status: 'approved' }, boss)).status, 200);
    await waitMails(2);
    assert.equal(smtp.mails[1].to, '<carl@example.com>');
    assert.match(smtp.mails[1].text, /одобрили[\s\S]*https:\/\/lwl\.test\/lk\.html#\/server/);
  } finally {
    await mailApp.close();
    await new Promise((r) => smtp.server.close(r));
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
