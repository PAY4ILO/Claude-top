/**
 * Сквозной тест кабинета в демо-режиме (два аккаунта в двух вкладках).
 *   npm install && npx playwright install chromium
 *   npm test
 */
import { chromium } from 'playwright';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '../tools/static-server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const server = await serve(0);
const BASE = `http://127.0.0.1:${server.address().port}`;
const results = [];
const ok = (name, cond, extra = '') => { results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); };

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1920, height: 993 } });
const errors = [];
function watch(p, tag) {
  p.on('pageerror', (e) => errors.push(`${tag} pageerror: ${e.message}`));
  p.on('console', (m) => m.type() === 'error' && errors.push(`${tag} console: ${m.text()}`));
}

async function settle(p, ms = 700) { await p.waitForTimeout(ms); await p.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove())); }

async function register(p, nick, email, pw) {
  await p.goto(BASE + '/lk.html');
  await p.waitForSelector('.auth-dialog');
  await p.click('#auth-tab-register');
  await p.click('.auth__form button[type=submit]');
  ok(`${nick}: пустая форма регистрации показывает ошибки`, (await p.locator('.field.has-error').count()) >= 3);
  await p.fill('input[name=nickname]', nick);
  await p.fill('input[name=email]', email);
  await p.fill('input[name=password]', pw);
  await p.fill('input[name=password2]', pw + 'x');
  await p.click('.auth__form button[type=submit]');
  ok(`${nick}: несовпадение паролей`, (await p.locator('.field.has-error input[name=password2]').count()) === 1);
  await p.fill('input[name=password2]', pw);
  await p.uncheck('input[name=remember]');
  await p.click('.auth__form button[type=submit]');
  await p.waitForSelector('.app-nav:not([hidden]) .nav-link', { timeout: 10000 });
  ok(`${nick}: регистрация → кабинет`, true);
}

async function uploadAvatar(p) {
  await p.goto(BASE + '/lk.html#/profile');
  await p.waitForSelector('.avatar-edit input[type=file]', { state: 'attached' });
  await p.setInputFiles('.avatar-edit input[type=file]', path.join(HERE, 'fixtures/avatar.jpg'));
  await p.waitForSelector('.avatar-edit .avatar img', { timeout: 10000 });
  ok('аватар загружен', true);
}

async function setRole(p, label) {
  await p.goto(BASE + '/lk.html#/profile');
  await p.waitForSelector('.segmented');
  await p.click(`.segmented button:has-text("${label}")`);
  await p.waitForSelector(`.segmented button[aria-pressed=true]:has-text("${label}")`, { timeout: 10000 });
}

// ---------- A: PAY4IL0
const A = await ctx.newPage(); watch(A, 'A');
await register(A, 'PAY4IL0', 'pay@example.com', 'Passw0rd1');
await uploadAvatar(A);
await A.goto(BASE + '/lk.html#/'); await A.waitForSelector('.hero-card:not(.hero-card--loading)'); await settle(A);
ok('главная игрока: приветствие', (await A.locator('.page-title').innerText()) === 'Привет, PAY4IL0!');
ok('главная игрока: призыв подать заявку', (await A.locator('.hero-card__title').innerText()) === 'Подайте заявку на сервер');
ok('главная игрока: плитки поддержки и профиля', (await A.locator('.tile').count()) === 2);
ok('меню игрока: 4 раздела', (await A.locator('.app-nav .nav-list .nav-link').count()) === 4);

// «Заявка» без заявки сразу открывает анкету
await A.goto(BASE + '/lk.html#/application'); await A.waitForSelector('form.form');
ok('раздел «Заявка» без заявки → анкета', (await A.locator('.page-title').innerText()) === 'Подать заявку');

await setRole(A, 'Админ');
await A.goto(BASE + '/lk.html#/'); await A.waitForSelector('.stat__num'); await settle(A);
ok('главная админа: панель', (await A.locator('.page-title').innerText()) === 'Панель администратора');
ok('меню админа: заявки и обращения', (await A.locator('.app-nav .nav-link[data-key=applications]').count()) === 1 && (await A.locator('.app-nav .nav-link[data-key=tickets]').count()) === 1);
await A.goto(BASE + '/lk.html#/admin/applications'); await A.waitForSelector('.split__list .state');
ok('админ: пустой список заявок', (await A.locator('.split__list .state__title').innerText()).includes('Новых заявок нет'));
ok('админ: подсказка «Выберите заявку»', (await A.locator('.split__detail .state__title').innerText()) === 'Выберите заявку');

// ---------- B: __Hawker__
const B = await ctx.newPage(); watch(B, 'B');
await register(B, '__Hawker__', 'hawk@example.com', 'Hawker123');
await uploadAvatar(B);

// ник занят
const C = await ctx.newPage(); watch(C, 'C');
await C.goto(BASE + '/lk.html'); await C.waitForSelector('.auth-dialog');
await C.click('#auth-tab-register');
await C.fill('input[name=nickname]', 'pay4il0'); await C.fill('input[name=email]', 'x@example.com');
await C.fill('input[name=password]', 'Abcdefg1'); await C.fill('input[name=password2]', 'Abcdefg1');
await C.click('.auth__form button[type=submit]'); await C.waitForSelector('.field.has-error input[name=nickname]');
ok('регистрация с занятым ником (без учёта регистра) → ошибка поля', true);
// неверный пароль и блокировка
await C.click('#auth-tab-login');
for (let i = 0; i < 5; i++) {
  await C.fill('input[name=login]', 'PAY4IL0'); await C.fill('input[name=password]', 'wrong' + i);
  await C.click('.auth__form button[type=submit]');
  await C.waitForFunction(() => !document.querySelector('.auth__form [type=submit]').classList.contains('is-loading'));
}
ok('неверный пароль → сообщение', (await C.locator('.form-alert').innerText()).includes('Неверный'));
await C.fill('input[name=password]', 'Passw0rd1'); await C.click('.auth__form button[type=submit]');
await C.waitForTimeout(800);
ok('после 5 ошибок вход блокируется', (await C.locator('.form-alert').innerText()).includes('Слишком много'));
await C.close();

// заявка
await B.goto(BASE + '/lk.html#/apply'); await B.waitForSelector('form.form');
await B.click('form.form button[type=submit]');
ok('заявка: ошибки валидации', (await B.locator('.field.has-error').count()) >= 3);
await B.fill('input[name=age]', '17');
await B.selectOption('select[name=source]', 'Друзья');
await B.fill('textarea[name=about]', 'Люблю строить большие города и играть с друзьями по вечерам.');
await B.check('input[name=agree]');
await B.click('form.form button[type=submit]');
await B.waitForSelector('.steps');
ok('заявка отправлена → прогресс', (await B.locator('.callout__title').innerText()).includes('на рассмотрении'));
await B.goto(BASE + '/lk.html#/'); await B.waitForSelector('.hero-card .pill');
ok('статус заявки на главной', (await B.locator('.hero-card .pill').innerText()) === 'На рассмотрении');

// поддержка: пустой чат, отправка
await B.goto(BASE + '/lk.html#/support'); await B.waitForSelector('.composer');
await B.waitForSelector('.chat__list .state');
ok('поддержка: пустое состояние', (await B.locator('.chat__list .state__title').innerText()).includes('пусто'));
await B.focus('.composer__input'); await B.keyboard.press('Enter'); await B.waitForTimeout(600);
ok('поддержка: Enter на пустом поле ничего не отправляет', (await B.locator('.msg').count()) === 0);
await B.fill('.composer__input', 'Привет! Не могу зайти на сервер <b>жирно</b> https://example.com');
await B.keyboard.press('Enter');
await B.waitForSelector('.msg--mine:not(.msg--pending)');
await B.waitForSelector('.msg--system');
ok('сообщение отправлено + системный ответ', true);
ok('HTML в сообщении не исполняется', (await B.locator('.msg--mine .msg__bubble b').count()) === 0);
ok('ссылка в сообщении кликабельна', (await B.locator('.msg--mine .msg__bubble a[href="https://example.com/"]').count()) === 1);

// A (админ) видит обращение и заявку
await A.goto(BASE + '/lk.html#/'); await A.waitForSelector('.app-nav .nav-link[data-key=tickets] .nav-badge:not([hidden])');
await A.waitForFunction(() => [...document.querySelectorAll('.stat__num')].every((n) => n.textContent !== '—'));
const stats = await A.locator('.stat__num').allInnerTexts();
ok('админ: счётчики на главной', stats.join(',') === '1,1', stats.join(','));
ok('админ: бейджи в меню', (await A.locator('.app-nav .nav-badge:not([hidden])').count()) === 2);
await A.goto(BASE + '/lk.html#/admin/tickets'); await A.waitForSelector('.row');
ok('админ: обращение в списке с непрочитанным', (await A.locator('.row .nav-badge').count()) === 1);
await A.click('.row'); await A.waitForSelector('.composer');
await A.waitForSelector('.msg');
ok('админ видит сообщение игрока', (await A.locator('.msg__bubble').first().innerText()).includes('Не могу зайти'));
await A.fill('.composer__input', 'Привет! Проверь, что заявка одобрена — сейчас посмотрю.');
await A.click('.composer__send');
await A.waitForSelector('.msg--mine:not(.msg--pending)');

// B получает ответ в реальном времени
await B.waitForSelector('.msg:not(.msg--mine):not(.msg--system)', { timeout: 8000 });
ok('игрок получил ответ без перезагрузки', true);
await settle(B, 500);
ok('шапка чата игрока: ник админа и «в сети»', (await B.locator('.chat__title').innerText()) === 'PAY4IL0' && (await B.locator('.chat__subtitle').innerText()) === 'в сети');

// решение по заявке
await A.goto(BASE + '/lk.html#/admin/applications'); await A.waitForSelector('.row'); await A.click('.row');
await A.waitForSelector('.review');
await A.click('.review button[value=rejected]');
ok('отказ без причины → ошибка', (await A.locator('.review .field.has-error').count()) === 1);
await A.click('.review button[value=approved]');
await A.waitForSelector('.split__detail .callout--success');
ok('заявка одобрена админом', true);
ok('админ: одобренная заявка ушла из «Новых»', (await A.locator('.split__list .row').count()) === 0);
await B.goto(BASE + '/lk.html#/application'); await B.waitForSelector('.callout--success');
ok('игрок видит «одобрена»', true);

// роли меняются местами: __Hawker__ — админ, PAY4IL0 — игрок
await setRole(A, 'Игрок');
await A.goto(BASE + '/lk.html#/support'); await A.waitForSelector('.composer');
await A.fill('.composer__input', 'Тестовое обращение от PAY4IL0');
await A.keyboard.press('Enter'); await A.waitForSelector('.msg--system');
await setRole(B, 'Админ');
await B.goto(BASE + '/lk.html#/admin/tickets'); await B.waitForSelector('.row');
const rows = await B.locator('.row').count();
ok('админ Hawker видит обращения', rows >= 1, 'строк: ' + rows);
await B.locator('.row', { hasText: 'PAY4IL0' }).click(); await B.waitForSelector('.msg'); await settle(B);
ok('админ: список и чат открыты рядом', (await B.locator('.split__list .row[aria-current=true]').count()) === 1);
ok('админ: кнопка «Закрыть обращение»', (await B.locator('.chat__actions .btn').innerText()) === 'Закрыть обращение');
await B.click('.chat__actions .btn'); await B.waitForSelector('.chat__banner:not([hidden])');
ok('обращение закрыто → баннер', true);

// ошибка сети
const D = await ctx.newPage(); watch(D, 'D');
await D.goto(BASE + '/lk.html?demoFail=1#/profile');
await D.waitForSelector('.state--error, .auth-dialog', { timeout: 10000 });
ok('сбой сети при загрузке → экран ошибки с «Повторить»', (await D.locator('.state--error button').count()) === 1);
await D.close();

// выход
await A.goto(BASE + '/lk.html#/'); await A.waitForSelector('.user-btn');
await A.click('.user-btn'); await A.click('.menu__item:has-text("Выйти")'); await A.waitForSelector('.modal__dialog');
await A.click('.modal__actions .btn:not(.btn--ghost)');
await A.waitForURL('**/index.html');
ok('выход → лендинг', true);

// данные в localStorage: пароль только хешем
const dump = await B.evaluate(() => localStorage.getItem('lwl.v1.users'));
ok('пароль не хранится в открытом виде', !dump.includes('Hawker123') && !dump.includes('Passw0rd1') && dump.includes('"iterations":600000'));

console.log(results.join('\n'));
console.log('Ошибки в консоли:', errors.length ? '\n' + errors.join('\n') : 'нет');
await browser.close();
server.close();
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed} из ${results.length} проверок прошли.`);
process.exit(failed || errors.length ? 1 : 0);
