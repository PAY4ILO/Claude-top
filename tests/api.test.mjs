/**
 * Тесты API сервера сайта (без браузера): npm run test:api
 * Каждый запуск — чистая временная база.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

let app;
let base;
let dataDir;

before(async () => {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwl-api-'));
  const config = loadConfig({ LWL_DATA_DIR: dataDir, LWL_ADMINS: 'owner@example.com', LWL_FAST_HASH: '1', LWL_MAX_UPLOAD_MB: '1' });
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
  assert.equal(r1.data.user.owner, true);
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

test('настройки сервера: админ задаёт, игрок видит, пользователь — нет', async () => {
  const bad = await owner.put('/api/admin/settings', { telegramUrl: 'javascript:alert(1)' });
  assert.equal(bad.status, 422);
  await owner.put('/api/admin/settings', { serverAddress: 'play.lwl.example', serverVersion: '26.3', telegramUrl: 'https://t.me/lwl' });
  assert.equal((await client().get('/api/settings')).data.telegramUrl, 'https://t.me/lwl');
  const info = await alice.get('/api/me/server');
  assert.equal(info.data.server.address, 'play.lwl.example');
  assert.equal(info.data.me.license, 'cracked');
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

test('удаление аккаунта удаляет заявки и переписку', async () => {
  assert.equal((await alice.del('/api/me', { password: 'wrong' })).status, 401);
  assert.equal((await alice.del('/api/me', { password: 'Passw0rd1' })).status, 204);
  assert.equal((await owner.get('/api/applications?status=all')).data.items.length, 0);
  assert.equal((await owner.get('/api/conversations?status=all')).data.items.length, 0);
});
