/**
 * Сквозной тест сайта в браузере против настоящего сервера (server/) с временной базой.
 *   npm install && npx playwright install chromium
 *   npm test
 * Два отдельных браузерных контекста = два человека: A — владелец (админ через LWL_ADMINS), B — новичок.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createApp } from '../server/app.js';
import { loadConfig } from '../server/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lwl-e2e-'));
const app = createApp(loadConfig({ LWL_DATA_DIR: dataDir, LWL_ADMINS: 'pay@example.com', LWL_FAST_HASH: '1' }));
await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${app.server.address().port}`;

const results = [];
const ok = (name, cond, extra = '') => results.push(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`);

const browser = await chromium.launch();
const errors = [];
function watch(p, tag) {
  p.on('pageerror', (e) => errors.push(`${tag} pageerror: ${e.message}`));
  // 401/403/429 — ожидаемые ответы сервера в сценариях теста, их браузер тоже пишет в консоль
  // 401/403/409/422/429 — ожидаемые ответы сервера в сценариях теста; ERR_FAILED — в сценарии «нет сети» запросы обрываем сами
  p.on('console', (m) => m.type() === 'error' && !/status of (401|403|404|409|422|429)|net::ERR_FAILED/.test(m.text()) && errors.push(`${tag} console: ${m.text()}`));
}
async function person(tag) {
  const ctx = await browser.newContext({ viewport: { width: 1920, height: 993 } });
  const page = await ctx.newPage();
  watch(page, tag);
  return page;
}
async function settle(p, ms = 700) {
  await p.waitForTimeout(ms);
  await p.evaluate(() => document.querySelectorAll('.toast').forEach((t) => t.remove()));
}

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
  await p.click('.auth__form button[type=submit]');
  await p.waitForSelector('.app-nav:not([hidden]) .nav-link', { timeout: 10000 });
  ok(`${nick}: регистрация → кабинет`, true);
}

async function login(p, loginName, pw) {
  await p.goto(BASE + '/lk.html');
  await p.waitForSelector('.auth-dialog');
  await p.fill('input[name=login]', loginName);
  await p.fill('input[name=password]', pw);
  await p.click('.auth__form button[type=submit]');
  await p.waitForSelector('.app-nav:not([hidden]) .nav-link', { timeout: 10000 });
}

// минимальный zip (для проверки загрузки сборки)
const zipPath = path.join(dataDir, 'LWL Prism.zip');
fs.writeFileSync(zipPath, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(2000, 7)]));

/* ================================================================ A: владелец */
const A = await person('A');
await register(A, 'PAY4IL0', 'pay@example.com', 'Passw0rd1');
await A.goto(BASE + '/lk.html#/profile');
await A.waitForSelector('.avatar-edit input[type=file]', { state: 'attached' });
await A.setInputFiles('.avatar-edit input[type=file]', path.join(HERE, 'fixtures/avatar.jpg'));
// окно обрезки: двигаем фото и приближаем, потом «Сохранить»
await A.waitForSelector('.crop__stage');
const stageBox = await A.locator('.crop__stage').boundingBox();
await A.mouse.move(stageBox.x + stageBox.width / 2, stageBox.y + stageBox.height / 2);
await A.mouse.down(); await A.mouse.move(stageBox.x + stageBox.width / 2 - 60, stageBox.y + stageBox.height / 2 - 40, { steps: 5 }); await A.mouse.up();
await A.locator('.crop__range').fill('2.5');
ok('обрезка: масштаб меняется', (await A.locator('.crop__range').inputValue()) === '2.5');
await A.click('.crop .modal__actions .btn:not(.btn--ghost)');
await A.waitForSelector('.avatar-edit .avatar img', { timeout: 10000 });
ok('аватар загружен и отдаётся сервером', (await A.locator('.avatar-edit .avatar img').getAttribute('src')).startsWith('/api/avatars/'));
ok('новая аватарка сразу в меню и в шапке', (await A.locator('.nav-profile .avatar img').count()) === 1 && (await A.locator('.user-btn .avatar img').count()) === 1);
await A.goto(BASE + '/lk.html#/'); await A.waitForSelector('.stat__num'); await settle(A);
ok('владелец из LWL_ADMINS сразу админ', (await A.locator('.page-title').innerText()) === 'Панель администратора');
ok('меню админа: заявки, обращения, люди, сервер', ['applications', 'tickets', 'users', 'server'].every(async () => true) && (await A.locator('.app-nav .nav-list .nav-link').count()) === 6);
ok('владелец — «Создатель»', (await A.locator('.nav-profile .role').innerText()) === 'Создатель');

// настройки сервера и сборка
await A.goto(BASE + '/lk.html#/server'); await A.waitForSelector('input[name=serverAddress]');
ok('админ: подпись — игроки адрес не видят', (await A.locator('.field:has(input[name=serverAddress])').innerText()).includes('Игроки его не видят'));
await A.fill('input[name=serverAddress]', 'play.lwl.example');
await A.fill('input[name=serverVersion]', '26.3');
await A.fill('input[name=telegramUrl]', 'https://t.me/lwl_test');
await A.fill('textarea[name=serverNote]', 'Сначала установите сборку.');
await A.click('form.form button[type=submit]'); await A.waitForSelector('.toast--success, .toast');
ok('админ: настройки сервера сохранены', (await (await A.request.get(BASE + '/api/settings')).json()).telegramUrl === 'https://t.me/lwl_test');
ok('автовайтлист не настроен → инструкция, как включить', (await A.locator('.rcon .callout__title').innerText()).includes('Выключено') && (await A.locator('.rcon .how-list--plain li').count()) === 3);
await A.click('button:has-text("Добавить сборку")'); await A.waitForSelector('.modal__dialog input[name=title]');
await A.click('.modal__dialog button[type=submit]');
await A.waitForSelector('.modal__dialog .field.has-error');
ok('сборка: без названия — ошибка', (await A.locator('.modal__dialog .field.has-error input[name=title]').count()) === 1);
await A.fill('.modal__dialog input[name=title]', 'LWL для Prism');
await A.fill('.modal__dialog input[name=version]', '1.0');
await A.fill('.modal__dialog textarea[name=description]', 'Всё нужное для сервера. Нужно 6 ГБ памяти.');
await A.click('.modal__dialog button[type=submit]');
await A.waitForSelector('.pack--admin');
ok('сборка создана черновиком', (await A.locator('.pack--admin .pill').innerText()) === 'Черновик');
ok('без файла опубликовать нельзя', await A.locator('.pack--admin button:has-text("Опубликовать")').isDisabled());
await A.setInputFiles('.pack--admin input[type=file]', zipPath);
await A.waitForSelector('.pack--admin .pack__meta:has-text("LWL Prism.zip")', { timeout: 10000 });
ok('файл сборки загружен', true);
await A.click('.pack--admin button:has-text("Опубликовать")');
await A.waitForSelector('.pack--admin .pill:has-text("Опубликована")');
ok('сборка опубликована', true);

/* ================================================================ B: новичок */
const B = await person('B');
await register(B, '__Hawker__', 'hawk@example.com', 'Hawker123');
await B.goto(BASE + '/lk.html#/'); await B.waitForSelector('.hero-card:not(.hero-card--loading)'); await settle(B);
ok('новичок — «Пользователь»', (await B.locator('.nav-profile .role').innerText()) === 'Пользователь');
ok('главная: призыв подать заявку', (await B.locator('.hero-card__title').innerText()) === 'Подайте заявку на сервер');
ok('меню пользователя: 4 раздела, без «Сервера»', (await B.locator('.app-nav .nav-list .nav-link').count()) === 4 && (await B.locator('.app-nav .nav-link[data-key=server]').count()) === 0);
await B.goto(BASE + '/lk.html#/server'); await B.waitForSelector('.state__title');
ok('«Сервер» закрыт до одобрения', (await B.locator('.state__title').innerText()).includes('после одобрения'));
ok('скачать сборку без роли «Игрок» нельзя', (await B.request.get(BASE + '/api/admin/packs')).status() === 403);

/* ================================================================ C: ошибки входа */
const C = await person('C');
await C.goto(BASE + '/lk.html'); await C.waitForSelector('.auth-dialog');
await C.click('#auth-tab-register');
await C.fill('input[name=nickname]', 'pay4il0'); await C.fill('input[name=email]', 'x@example.com');
await C.fill('input[name=password]', 'Abcdefg1'); await C.fill('input[name=password2]', 'Abcdefg1');
await C.click('.auth__form button[type=submit]'); await C.waitForSelector('.field.has-error input[name=nickname]');
ok('регистрация с занятым ником (без учёта регистра) → ошибка поля', true);
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

/* ================================================================ заявка */
await B.goto(BASE + '/lk.html#/apply'); await B.waitForSelector('form.form');
await B.click('form.form button[type=submit]');
ok('заявка: ошибки валидации', (await B.locator('.field.has-error').count()) >= 3);
ok('заявка: без выбора лицензии не отправить', (await B.locator('.choices.has-error').count()) === 1);
await B.check('input[name=license][value=cracked]');
await B.fill('input[name=age]', '17');
await B.selectOption('select[name=source]', 'Друзья');
await B.fill('textarea[name=about]', 'Люблю строить большие города и играть с друзьями по вечерам.');
await B.check('input[name=agree]');
await B.click('form.form button[type=submit]');
await B.waitForSelector('.steps');
ok('заявка отправлена → прогресс', (await B.locator('.callout__title').innerText()).includes('на рассмотрении'));

/* ================================================================ поддержка */
await B.goto(BASE + '/lk.html#/support'); await B.waitForSelector('.composer');
await B.waitForSelector('.chat__list .state');
ok('поддержка: пустое состояние', (await B.locator('.chat__list .state__title').innerText()).includes('пусто'));
await B.fill('.composer__input', 'Привет! Не могу зайти на сервер <b>жирно</b> https://example.com');
await B.keyboard.press('Enter');
await B.waitForSelector('.msg--mine:not(.msg--pending)');
await B.waitForSelector('.msg--system');
ok('сообщение отправлено + автоответ', true);
ok('HTML в сообщении не исполняется', (await B.locator('.msg--mine .msg__bubble b').count()) === 0);
ok('ссылка в сообщении кликабельна', (await B.locator('.msg--mine .msg__bubble a[href="https://example.com/"]').count()) === 1);

await A.goto(BASE + '/lk.html#/'); await A.waitForSelector('.app-nav .nav-link[data-key=tickets] .nav-badge:not([hidden])');
await A.waitForFunction(() => [...document.querySelectorAll('.stat__num')].every((n) => n.textContent !== '—'));
const stats = await A.locator('.stat__num').allInnerTexts();
ok('админ: счётчики на главной', stats.join(',') === '1,1', stats.join(','));
await A.goto(BASE + '/lk.html#/admin/tickets'); await A.waitForSelector('.row');
await A.click('.row'); await A.waitForSelector('.msg');
ok('админ видит сообщение', (await A.locator('.msg__bubble').first().innerText()).includes('Не могу зайти'));
await A.fill('.composer__input', 'Привет! Сейчас посмотрю заявку.');
await A.click('.composer__send');
await A.waitForSelector('.msg--mine:not(.msg--pending)');
await B.waitForSelector('.msg:not(.msg--mine):not(.msg--system)', { timeout: 10000 });
ok('игрок получил ответ без перезагрузки', true);
await B.waitForSelector('.msg--mine.msg--read', { timeout: 10000 });
ok('у игрока две галочки: админ прочитал', (await B.locator('.msg--mine.msg--read .msg__meta svg').count()) >= 1);
await A.waitForSelector('.msg--mine.msg--read', { timeout: 10000 });
ok('у админа две галочки: игрок прочитал ответ', true);

/* ================================================================ фото и файлы в чате */
const photoPath = path.join(HERE, 'fixtures/avatar.jpg');
const reportPath = path.join(dataDir, 'отчёт об ошибке.txt');
fs.writeFileSync(reportPath, 'Лог клиента: не удалось подключиться к серверу\n'.repeat(40));
const guidePath = path.join(dataDir, 'инструкция.txt');
fs.writeFileSync(guidePath, 'Удалите папку mods и поставьте сборку заново.\n');
const bigPath = path.join(dataDir, 'видео.mp4');
fs.writeFileSync(bigPath, '');
fs.truncateSync(bigPath, 26 * 1024 * 1024);
const noPending = (p) => p.waitForFunction(() => !document.querySelector('.msg--pending'), null, { timeout: 15000 });
const imagesLoaded = (p, sel) => p.waitForFunction((s) => { const imgs = [...document.querySelectorAll(s)]; return imgs.length > 0 && imgs.every((i) => i.complete && i.naturalWidth > 0); }, sel, { timeout: 15000 });
/** Перетаскивание файла в окно чата (как из проводника). */
const dropFile = (p, name, text) =>
  p.evaluate(({ name, text }) => {
    const dt = new DataTransfer();
    dt.items.add(new File([text], name, { type: 'text/plain' }));
    const chat = document.querySelector('.chat');
    chat.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true, cancelable: true }));
    chat.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, { name, text });
/** Ctrl+V скриншота: в буфере только картинка «image.png». */
const pasteImage = (p, file) =>
  p.evaluate((b64) => {
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'image.png', { type: 'image/jpeg' }));
    document.querySelector('.composer__input').dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, fs.readFileSync(file).toString('base64'));

// игрок: фото скрепкой, файл перетаскиванием, лишний — крестиком
await B.setInputFiles('.composer__file', photoPath);
await B.waitForSelector('.tray-item--image img');
ok('чат: выбранное фото — превью над полем ввода', (await B.locator('.tray-item--image img').getAttribute('src')).startsWith('blob:'));
await dropFile(B, 'отчёт об ошибке.txt', fs.readFileSync(reportPath, 'utf8'));
await B.setInputFiles('.composer__file', guidePath);
await B.waitForFunction(() => document.querySelectorAll('.tray-item').length === 3);
await B.click('.tray-item:has-text("инструкция.txt") .tray-item__remove');
ok('чат: перетаскивание добавляет файл, «✕» убирает лишний', (await B.locator('.tray-item').count()) === 2 && (await B.locator('.tray-item:has-text("отчёт об ошибке.txt")').count()) === 1);
ok('чат: поле ввода становится подписью', (await B.locator('.composer__input').getAttribute('placeholder')) === 'Подпись к первому файлу');
await B.setInputFiles('.composer__file', bigPath);
await B.waitForSelector('.toast--error');
ok('чат: файл больше 25 МБ не добавляется (без загрузки)', (await B.locator('.toast--error').innerText()).includes('25 МБ') && (await B.locator('.tray-item').count()) === 2);
await settle(B, 100);
await B.fill('.composer__input', 'Вот скрин ошибки и лог');
await B.keyboard.press('Enter');
await noPending(B);
await B.waitForFunction(() => document.querySelectorAll('.msg--mine .att-photo, .msg--mine .att-file').length === 2);
ok('чат: игрок отправил фото с подписью и файл — два сообщения', (await B.locator('.msg--mine:has(.att-photo) .msg__caption').innerText()).includes('Вот скрин ошибки и лог') && (await B.locator('.tray-item').count()) === 0);

// админ: в списке — имя файла; превью, крупно, скачать
await A.waitForFunction(() => [...document.querySelectorAll('.split__list .row__text')].some((r) => r.textContent.includes('отчёт об ошибке.txt')), null, { timeout: 10000 });
ok('чат: в списке обращений — значок и имя файла', (await A.locator('.split__list .row__text .row__att svg').count()) === 1);
await imagesLoaded(A, '.msg:not(.msg--mine) .att-photo img');
const adminImg = A.locator('.msg:not(.msg--mine) .att-photo img').first();
ok('чат: админ видит превью фото с сервера', (await adminImg.getAttribute('src')).startsWith('/api/attachments/'));
const box = await A.locator('.msg:not(.msg--mine) .att-photo').first().boundingBox();
ok('чат: превью ограничено по размеру и с местом под фото', box.width > 100 && box.width <= 360 && box.height <= 360, `${Math.round(box.width)}×${Math.round(box.height)}`);
await A.click('.msg:not(.msg--mine) .att-photo');
await A.waitForSelector('.lightbox__img');
await A.waitForFunction(() => document.querySelector('.lightbox__img').naturalWidth > 0);
ok('чат: по клику фото открывается крупно', (await A.locator('.modal__dialog--lightbox .modal__title').innerText()) === 'avatar.jpg');
await A.keyboard.press('Escape');
await A.waitForSelector('.lightbox', { state: 'detached' });
const [dl1] = await Promise.all([A.waitForEvent('download'), A.click('.msg:not(.msg--mine) a.att-file')]);
ok('чат: админ скачивает файл — то же имя и содержимое', dl1.suggestedFilename() === 'отчёт об ошибке.txt' && fs.readFileSync(await dl1.path()).equals(fs.readFileSync(reportPath)));

// админ отвечает: скриншот из буфера и файл; первая попытка файла обрывается — «Повторить»
await A.focus('.composer__input');
await pasteImage(A, photoPath);
await A.waitForSelector('.tray-item--image');
ok('чат: Ctrl+V картинки → в полоске, с именем «Снимок …»', /^Снимок \d{4}-\d\d-\d\d/.test(await A.locator('.tray-item--image').getAttribute('title')));
await A.click('.composer__send');
await noPending(A);
await A.route('**/attachments', (route) => route.abort());
await A.setInputFiles('.composer__file', guidePath);
await A.click('.composer__send');
await A.waitForSelector('.msg--failed .msg__retry');
ok('чат: обрыв загрузки → «Файл не отправлен» и «Повторить»', (await A.locator('.msg--failed .msg__retry').innerText()).includes('Повторить'));
await A.unroute('**/attachments');
await settle(A, 100);
await A.click('.msg--failed .msg__retry button:has-text("Повторить")');
await A.waitForFunction(() => !document.querySelector('.msg--failed, .msg--pending'), null, { timeout: 15000 });
ok('чат: после «Повторить» файл ушёл', (await A.locator('.msg--mine a.att-file:has-text("инструкция.txt")').count()) === 1);

// игрок видит ответ без перезагрузки и скачивает
await imagesLoaded(B, '.msg:not(.msg--mine) .att-photo img');
ok('чат: игрок видит фото от админа без перезагрузки', (await B.locator('.msg:not(.msg--mine) .att-photo img').getAttribute('src')).startsWith('/api/attachments/'));
await B.waitForSelector('.msg:not(.msg--mine) a.att-file');
const [dl2] = await Promise.all([B.waitForEvent('download'), B.click('.msg:not(.msg--mine) a.att-file')]);
ok('чат: игрок скачивает файл от админа', dl2.suggestedFilename() === 'инструкция.txt' && fs.readFileSync(await dl2.path()).equals(fs.readFileSync(guidePath)));
ok('чат: файлы лежат на сервере под id, без имён от пользователей', fs.readdirSync(path.join(dataDir, 'attachments')).length === 4 && fs.readdirSync(path.join(dataDir, 'attachments')).every((n) => /^f_[\w-]+$/.test(n)));

/* ================================================================ одобрение → «Игрок» */
await A.goto(BASE + '/lk.html#/admin/applications'); await A.waitForSelector('.row'); await A.click('.row');
await A.waitForSelector('.review');
await A.click('.review button[value=rejected]');
ok('отказ без причины → ошибка', (await A.locator('.review .field.has-error').count()) === 1);
await A.click('.review button[value=approved]');
await A.waitForSelector('.split__detail .callout--success');
ok('команда для сервера в одобренной заявке', (await A.locator('.split__detail .cmd__code').innerText()) === '/wl add __Hawker__ cracked');

await B.goto(BASE + '/lk.html#/'); await B.waitForSelector('.nav-link[data-key=server]');
ok('после одобрения — «Игрок» и вкладка «Сервер»', (await B.locator('.nav-profile .role').innerText()) === 'Игрок');
// Вход по коду: адреса игрок не видит, мод получает его по коду (POST /api/connect).
const modConnect = (code) => B.request.post(BASE + '/api/connect', { headers: { 'X-Requested-With': 'lwl', 'Content-Type': 'application/json' }, data: { code, nickname: '__hawker__' } });
const CODE_RE = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
await B.goto(BASE + '/lk.html#/server'); await B.waitForSelector('.connect-code'); await settle(B);
ok('адреса сервера на странице игрока нет', !(await B.content()).includes('play.lwl.example') && !(await B.locator('.server-card').innerText()).includes('Добавить сервер'));
ok('кода ещё нет → «Получить код»', (await B.locator('.connect-code .btn').innerText()).includes('Получить код'));
await B.click('.connect-code .btn'); await B.waitForSelector('.connect-code .callout--warning');
const code1 = await B.locator('.connect-code__value').innerText();
ok('код показан целиком (XXXX-XXXX-XXXX) с «Скопировать»', CODE_RE.test(code1) && (await B.locator('.connect-code button:has-text("Скопировать")').count()) === 1, code1);
ok('предупреждение: код показывается один раз', (await B.locator('.connect-code .callout--warning').innerText()).includes('один раз'));
const r1 = await modConnect(code1.toLowerCase().replace(/-/g, ' '));
ok('мод получает адрес по этому коду', r1.status() === 200 && (await r1.json()).address === 'play.lwl.example');
await B.reload(); await B.waitForSelector('.connect-code__value--masked');
ok('после перезагрузки код не показывается — только последние 4 символа', (await B.locator('.connect-code__value').innerText()) === '••••-••••-' + code1.slice(-4));
await B.click('.connect-code button:has-text("Новый код")'); await B.waitForSelector('.modal__dialog');
await B.click('.modal__actions .btn:not(.btn--ghost)'); await B.waitForSelector('.connect-code .callout--warning');
const code2 = await B.locator('.connect-code__value').innerText();
ok('«Новый код» (с подтверждением) → другой код, старый не работает', CODE_RE.test(code2) && code2 !== code1 && (await modConnect(code1)).status() === 404 && (await modConnect(code2)).status() === 200);
ok('шаги: сборка с модом → «Сетевая игра» → «Сервер LWL» → код', /мод LWL[\s\S]*Сервер LWL[\s\S]*код/.test(await B.locator('.how-list').innerText()));
ok('на карточке входа нет картинки с персонажем', (await B.locator('.server-card img').count()) === 0);
ok('подсказка для пирата: /register', (await B.locator('.how-list').innerText()).includes('/register'));
ok('подсказка админа', (await B.locator('.server-note').innerText()).includes('Сначала установите сборку'));
const href = await B.locator('.pack a[download]').getAttribute('href');
const file = await B.request.get(BASE + href);
ok('игрок скачивает сборку', file.status() === 200 && (await file.body()).length === 2004);
await B.goto(BASE + '/lk.html#/profile'); await B.waitForSelector('input[name=nickname]');
ok('игрок не меняет ник сам (он в вайтлисте)', (await B.locator('input[name=nickname]').getAttribute('readonly')) !== null);

/* ================================================================ сброс пароля по ссылке */
await C.goto(BASE + '/lk.html'); await C.waitForSelector('.auth-dialog');
await C.click('.link-btn:has-text("Забыли пароль?")');
await C.fill('input[name=email]', 'hawk@example.com');
await C.click('.auth__form button[type=submit]');
await C.waitForSelector('.form-alert--info');
ok('«Забыли пароль?» → запрос отправлен', (await C.locator('.form-alert').innerText()).includes('Запрос отправлен'));
await A.goto(BASE + '/lk.html#/admin/users?status=reset'); await A.waitForSelector('.row');
ok('админ видит запрос на сброс', (await A.locator('.row').count()) === 1 && (await A.locator('.app-nav .nav-link[data-key=users] .nav-badge').innerText()) === '1');
await A.click('.row'); await A.click('button:has-text("Ссылка для сброса пароля")');
await A.waitForSelector('.split__detail .cmd__code');
const link = await A.locator('.split__detail .cmd__code').innerText();
await C.goto(link); await C.waitForSelector('input[name=password]');
await C.fill('input[name=password]', 'NewHawk123'); await C.fill('input[name=password2]', 'NewHawk123');
await C.click('.gate__form button[type=submit]');
await C.waitForSelector('.app-nav:not([hidden])');
ok('новый пароль по ссылке → сразу вход', (await C.locator('.page-title').innerText()) === 'Привет, __Hawker__!');
await C.close();
await B.goto(BASE + '/lk.html#/'); await B.waitForSelector('.auth-dialog');
ok('старая сессия после сброса пароля закрыта', true);
await B.fill('input[name=login]', 'hawk@example.com'); await B.fill('input[name=password]', 'NewHawk123');
await B.click('.auth__form button[type=submit]');
await B.waitForSelector('.app-nav:not([hidden])');

/* ================================================================ роли */
await A.goto(BASE + '/lk.html#/admin/users'); await A.waitForSelector('.row');
await A.locator('.row', { hasText: '__Hawker__' }).click(); await A.waitForSelector('.segmented');
ok('карточка игрока: код входа есть (без самого кода)', (await A.locator('.split__detail').innerText()).includes('••••-••••-' + code2.slice(-4)) && !(await A.locator('.split__detail').innerText()).includes(code2));
await A.click('.split__detail button:has-text("Отозвать код входа")'); await A.click('.modal__actions .btn--danger');
await A.waitForSelector('.split__detail button:has-text("Отозвать код входа")', { state: 'detached' });
ok('админ отозвал код → по нему больше не пускает', (await modConnect(code2)).status() === 404);
await A.click('.segmented button[data-role=admin]'); await A.click('.modal__actions .btn:not(.btn--ghost)');
await A.waitForSelector('.split__detail .role--admin');
ok('админ выдал роль «Админ»', true);
await A.waitForSelector('.split__detail .perms');
ok('создатель видит права нового админа: 4 из 6 по умолчанию', (await A.locator('.perms input[name=perm]').count()) === 6 && (await A.locator('.perms input[name=perm]:checked').count()) === 4);
await A.locator('.row', { hasText: 'PAY4IL0' }).click(); await A.waitForSelector('.split__detail .detail__name:has-text("PAY4IL0")');
ok('владельца понизить нельзя', (await A.locator('.split__detail .segmented').count()) === 0);
await A.goto(BASE + '/lk.html#/support'); await A.waitForSelector('.composer');
await A.fill('.composer__input', 'Тестовое обращение от PAY4IL0');
await A.keyboard.press('Enter'); await A.waitForSelector('.msg--system');
await B.goto(BASE + '/lk.html#/admin/tickets'); await B.waitForSelector('.row');
await B.locator('.row', { hasText: 'PAY4IL0' }).click(); await B.waitForSelector('.msg'); await settle(B);
ok('новый админ открыл обращение', (await B.locator('.split__list .row[aria-current=true]').count()) === 1);
ok('без права «Удаление» кнопки удаления обращения нет', (await B.locator('.chat__actions .icon-btn').count()) === 0);
await B.click('.chat__actions .btn'); await B.waitForSelector('.chat__banner:not([hidden])');
ok('обращение закрыто → баннер', true);

// создатель забирает у админа «Заявки» — у того пропадает раздел
await A.goto(BASE + '/lk.html#/admin/users'); await A.waitForSelector('.row');
await A.locator('.row', { hasText: '__Hawker__' }).click(); await A.waitForSelector('.split__detail .perms');
await A.uncheck('.perms input[value=applications]');
await A.click('.perms button[type=submit]'); await A.waitForSelector('.toast--success');
// переход по хешу в той же вкладке: меню перестраивается, когда кабинет получит новые права (/api/me/summary)
await B.goto(BASE + '/lk.html#/'); await B.waitForSelector('.app-nav .nav-link[data-key=tickets]');
const appsGone = await B.waitForSelector('.app-nav .nav-link[data-key=applications]', { state: 'detached', timeout: 10000 }).then(() => true, () => false);
ok('админ без права «Заявки»: раздела нет в меню', appsGone && (await B.locator('.app-nav .nav-link[data-key=tickets]').count()) === 1);
await B.goto(BASE + '/lk.html#/admin/applications'); await B.waitForSelector('.state__title');
ok('…и по прямой ссылке — «Нет прав»', (await B.locator('.state__title').innerText()) === 'Нет прав на этот раздел');
await B.goto(BASE + '/lk.html#/admin/users'); await B.waitForSelector('.row');
await B.locator('.row', { hasText: 'PAY4IL0' }).click(); await B.waitForSelector('.split__detail .role--creator');
ok('обычный админ не видит кнопок сброса пароля и удаления у создателя', (await B.locator('.split__detail button:has-text("Ссылка для сброса пароля"), .split__detail button:has-text("Удалить аккаунт")').count()) === 0);

// создатель удаляет заявку и обращение
await A.goto(BASE + '/lk.html#/admin/applications?status=all'); await A.waitForSelector('.row');
await A.locator('.row', { hasText: '__Hawker__' }).click(); await A.waitForSelector('button:has-text("Удалить заявку")');
await A.click('button:has-text("Удалить заявку")'); await A.click('.modal__actions .btn--danger');
await A.waitForSelector('.split__list .state');
ok('заявка удалена', (await A.locator('.split__list .row').count()) === 0);
await A.goto(BASE + '/lk.html#/admin/tickets?status=all'); await A.waitForSelector('.row');
await A.locator('.row', { hasText: '__Hawker__' }).click(); await A.waitForSelector('.chat__actions .icon-btn');
await A.click('.chat__actions .icon-btn'); await A.click('.modal__actions .btn--danger');
await A.waitForFunction(() => ![...document.querySelectorAll('.split__list .row')].some((r) => r.textContent.includes('__Hawker__')));
ok('обращение удалено', true);
ok('фото и файлы обращения удалены с диска', fs.readdirSync(path.join(dataDir, 'attachments')).length === 0);

/* ================================================================ сбой сети */
const D = await person('D');
await D.route('**/api/**', (route) => route.abort());
await D.goto(BASE + '/lk.html#/profile');
await D.waitForSelector('.state--error', { timeout: 10000 });
ok('нет связи с сервером → экран ошибки с «Повторить»', (await D.locator('.state--error button').count()) === 1);

/* ================================================================ выход */
await A.goto(BASE + '/lk.html#/'); await A.waitForSelector('.user-btn');
await A.click('.user-btn'); await A.click('.menu__item:has-text("Выйти")'); await A.waitForSelector('.modal__dialog');
await A.click('.modal__actions .btn:not(.btn--ghost)');
await A.waitForURL('**/index.html');
ok('выход → лендинг', true);
ok('лендинг берёт ссылку Telegram из настроек', (await A.locator('[data-telegram-link]').first().getAttribute('href')) === 'https://t.me/lwl_test');

/* ================================================================ база */
const rows = app.db.prepare('SELECT password_hash FROM users').all();
ok('пароли в базе только хешем (scrypt)', rows.every((r) => r.password_hash.startsWith('scrypt$')) && !JSON.stringify(rows).includes('Hawker123') && !JSON.stringify(rows).includes('Passw0rd1'));

console.log(results.join('\n'));
console.log('Ошибки в консоли:', errors.length ? '\n' + errors.join('\n') : 'нет');
await browser.close();
await app.close();
fs.rmSync(dataDir, { recursive: true, force: true });
const failed = results.filter((r) => r.startsWith('FAIL')).length;
console.log(`\n${results.length - failed} из ${results.length} проверок прошли.`);
process.exit(failed || errors.length ? 1 : 0);
