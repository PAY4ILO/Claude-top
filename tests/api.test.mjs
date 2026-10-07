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
  const config = loadConfig({ LWL_DATA_DIR: dataDir, LWL_ADMINS: 'owner@example.com', LWL_FAST_HASH: '1', LWL_MAX_UPLOAD_MB: '1', LWL_GAME_TOKEN: GAME_TOKEN, LWL_TRUST_PROXY: '1' });
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

test('удаление аккаунта удаляет заявки и переписку', async () => {
  assert.equal((await alice.del('/api/me', { password: 'wrong' })).status, 401);
  assert.equal((await alice.del('/api/me', { password: 'Passw0rd1' })).status, 204);
  assert.equal((await owner.get('/api/applications?status=all')).data.items.length, 0);
  assert.equal((await owner.get('/api/conversations?status=all')).data.items.length, 0);
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
