/**
 * Тесты API сервера сайта (без браузера): npm run test:api
 * Каждый запуск — чистая временная база.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

let app;
let base;
let dataDir;
const GAME_TOKEN = 'game-token-for-tests-0123456789';

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwl-api-'));
  // LWL_TRUST_PROXY — чтобы тесты кодов входа подставляли разные IP (X-Real-IP) и не упирались в лимит по IP.
  const config = loadConfig({ LWL_DATA_DIR: dataDir, LWL_ADMINS: 'owner@example.com', LWL_FAST_HASH: '1', LWL_MAX_UPLOAD_MB: '1', LWL_CHAT_MAX_FILE_MB: '1', LWL_GAME_TOKEN: GAME_TOKEN, LWL_TRUST_PROXY: '1' });
  app = createApp(config);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${app.server.address().port}`;
});

after(async () => {
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
  assert.equal((await client().post('/api/auth/password-reset', { email: 'nobody@example.com' })).status, 204);
  assert.equal((await client().post('/api/auth/password-reset', { email: 'bob@example.com' })).status, 204);
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
          send(id, 0, m ? `${m[1]} добавлен в вайтлист.` : 'Вайтлист выключен, в нём пока никого нет.');
        }
      }
    });
  });
  return { server, commands };
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
