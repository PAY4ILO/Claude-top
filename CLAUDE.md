# Заметки для разработки (LWL)

Сайт и моды Minecraft-сервера **LWL** (не «LWJ»). Владелец проекта пишет по-русски — отвечать и писать
тексты интерфейса тоже по-русски, простым языком. Сайт будет обновляться, поэтому ниже всё, что
нужно знать перед правками.

## Что где

- `index.html` + `assets/js/landing.js` — лендинг; `lk.html` + `assets/js/lk.js` — кабинет (роутер на `#/…`, все экраны);
  `assets/js/lk-chat.js` — чат; `assets/js/auth.js` — окно входа/регистрации/«Забыли пароль?»;
  `assets/js/ui.js` — `h()`, `UI.append`, окна, тосты, `field()`, иконки (`ICONS`).
- `assets/js/api.js` — **единственный** модуль страницы, который ходит в сервер. Новые запросы добавлять только сюда
  (и события `emit(...)`, чтобы другие экраны/вкладки обновились).
- `server/` — Node.js без зависимостей: `app.js` (сессии, права `need.user/admin/player`, настройки, роутинг),
  `routes/*.js` (API по разделам), `db.js` (SQLite, миграции), `lib/` (http, пароли scrypt, проверки), `cli.js` (команды админа).
- `deploy/` — установка на Linux (systemd `lwl.service`, nginx, certbot, бэкапы), инструкция `deploy/README.md`.
- `minecraft/` — Gradle-проект с двумя Fabric-модами для Minecraft 26.3: `lwl-skins` (скины) и `lwl-auth`
  (лицензия/пароль + вайтлист `/wl`). Инструкция `minecraft/README.md`.

## Правила, о которых легко забыть

- **Проверки полей продублированы**: `assets/js/api.js` (`LIMITS`, `validate`) и `server/lib/validate.js`. Меняешь одно — меняй другое.
- **Миграции базы только добавляются** в конец `MIGRATIONS` в `server/db.js`. Старые не редактировать: на рабочей базе они уже применены.
  Внутри `tx()` нельзя `await` (SQLite синхронный) — хеш пароля и работу с файлами делать до транзакции.
- **CSP без `unsafe-inline`**: никаких `style="…"` в HTML и `setAttribute('style')`; стили — классами в CSS.
  Менять `el.style.width` из JS можно (CSSOM разрешён), так сделан прогресс загрузки.
- **`UI.append`/`h()` пропускают `null/undefined/false`**, но не `0` — для чисел писать `n > 0 && …`.
  Нативный `Element.append(null)` печатает «null» — не использовать с условными детьми.
- `[hidden]` глобально `display:none !important` (base.css): если у элемента свой `display`, `hidden` всё равно работает.
- Персонажи на карточках «выглядывают» за край (`.card--art`, `.tile--art`, `.feature__art`); анимация — только
  `scale` от нижнего края (`transform-origin: bottom`), не `translateY`, иначе появляется щель.
- Вкладки фильтров (`.tabs`) переносятся на вторую строку, а не прокручиваются; нижнее меню на телефоне — всегда одна строка
  (длинные подписи — через `short` в `navItems()`).
- **Данных пользователей и секретов в репозитории нет и быть не должно**: база в `LWL_DATA_DIR` (локально `./data/`, в `.gitignore`),
  почта владельца — только в `/etc/lwl/lwl.env` на машине (`LWL_ADMINS`), не в коде.
- Роли: `user` → `player` (при одобрении заявки, `routes/applications.js`) → `admin`. Владельцы из `LWL_ADMINS` всегда админы
  (повышаются при старте, их нельзя понизить/удалить из админки). `/api/me/summary` отдаёт `role` — по нему открытый кабинет
  замечает смену роли и перестраивается.
- Ник «Игрока» сам не меняется (он в вайтлисте Minecraft-сервера) — только через поддержку.
- Сброс пароля без почты: запрос → админ в «Людях» выдаёт одноразовую ссылку `/lk.html#/reset/<токен>` (24 ч), или `sudo lwl-cli reset-link НИК`.

## Запуск и проверка

```bash
LWL_ADMINS=you@example.com npm start   # http://localhost:8080, данные в ./data
npm run test:api                       # API: node --test, временная база
npm test                               # браузер (Playwright) против настоящего сервера, два человека
```

Оба теста должны быть зелёными перед коммитом. Для скриншотов/ручных проверок удобно поднимать `createApp(loadConfig({...}))`
на временной папке с `LWL_FAST_HASH=1` (быстрый scrypt, только для тестов) и заполнять данные через API
(заголовок `X-Requested-With: lwl` обязателен для POST/PATCH/PUT/DELETE).

Моды: `cd minecraft && ./gradlew build` (Gradle сам скачает Java 25 — см. `gradle/gradle-daemon-jvm.properties`).
Проверялись на настоящем сервере 26.3 и клиенте под Xvfb: клиенту нужен `SDL_VIDEO_FORCE_EGL=1` (у Xvfb нет sRGB-визуала GLX).

## Деплой

`sudo ./deploy/install.sh домен почта` на Ubuntu/Debian; обновление — `git pull && sudo ./deploy/update.sh`.
Служба `lwl` (Restart=always, автозапуск), nginx → `127.0.0.1:LWL_PORT` (8080 или следующий свободный — выбирает `install.sh`,
`update.sh` читает из `lwl.env`), HTTPS certbot, бэкап базы каждую ночь в `/var/backups/lwl`.
Машина владельца общая (домашний сервер с другими программами): установщик не трогает чужие сайты nginx и порты.
У владельца 80/443 держит **Caddy** (bind на LAN-IP; на 443 Tailscale-IP ещё tailscaled), поэтому `install.sh` сам
выбирает режим Caddy. В этом режиме он пишет `deploy/Caddyfile.template` в `/etc/caddy/lwl.caddy` с тем же bind
и добавляет `import` в `/etc/caddy/Caddyfile`, затем делает `systemctl reload caddy`. При ошибке откатывает;
nginx и certbot не ставит. Сайт берёт IP посетителя из `X-Real-IP` (`clientIp` в `lib/http.js`): в любом прокси
его нужно выставлять (`header_up X-Real-IP {remote_host}`), иначе лимиты сработают на всех сразу.
Загрузка сборок идёт потоком (`proxy_request_buffering off` на `…/packs/<id>/file`), скачивание — без буфера nginx, с `Range`.
Если добавляешь зависимость, переменную окружения или системный пакет — обнови `deploy/install.sh`, `deploy/lwl.env.example` и `deploy/README.md`.

## Что дальше (идеи, о которых говорили)

- **Автовайтлист при одобрении заявки**: сайт через RCON Minecraft-сервера выполняет `wl add <ник>` / `wl add <ник> cracked`
  (данные уже есть: `applications.nickname`, `license`, `status`). Нужны настройки RCON (хост, порт, пароль) — хранить в `lwl.env`, не в базе.
  Команда для консоли уже показывается в одобренной заявке (`serverCommand()` в `lk.js`).
- Письма (сброс пароля, уведомления) — если появится SMTP: `LWL_SMTP_URL` в `lwl.env`, отправка из `routes/auth.js`.
- Чат без опроса (SSE) — заменить только `Api.chats.subscribe` и добавить поток на сервере.
- Скины с сайта в мод `lwl-skins` (загрузка PNG в кабинете → `/skin url` по ссылке сайта).
