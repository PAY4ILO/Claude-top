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
- `assets/js/mc-art.js` (`window.McArt`) — блоки и предметы игры по оглавлению `assets/js/mc-index.json`
  (собирает `tools/mc-index.mjs`), см. «Предметы и блоки» ниже. `#/studio` в кабинете — студия персонажа (**в работе**).
- `server/` — Node.js без зависимостей: `app.js` (сессии, права `need.user/admin/perm/creator/player`, настройки, роутинг),
  `routes/*.js` (API по разделам), `db.js` (SQLite, миграции), `lib/` (http, пароли scrypt, проверки, `permissions.js` —
  права админов, `rcon.js` — консоль Minecraft-сервера, `files.js` — картинка ли файл по первым байтам, безопасное имя,
  отдача с `Range`), `cli.js` (команды админа).
- `deploy/` — установка на Linux (systemd `lwl.service`, nginx, certbot, бэкапы), инструкция `deploy/README.md`.
- `minecraft/` — Gradle-проект с тремя Fabric-модами для Minecraft 26.3: `lwl-skins` (скины), `lwl-auth`
  (лицензия/пароль + вайтлист `/wl`) и `lwl-stats` (кто в игре и статистика → сайт). Инструкция `minecraft/README.md`.
  `lwl-skins` нужен и в клиентской сборке: клиентский миксин `SkinManagerLoaderMixin` (обёртка `unpackTextures`
  в `SkinManager$1.lambda$load$0`) доверяет текстурам с textures.minecraft.net, когда подпись не проверить
  (пиратские лаунчеры подменяют authlib/ключи — иначе все чужие скины = Стив). Имя лямбды сверено по клиенту 26.3:
  при обновлении Minecraft проверь `javap -p -c 'SkinManager$1'`.

## Правила, о которых легко забыть

- **Проверки полей продублированы**: `assets/js/api.js` (`LIMITS`, `validate`) и `server/lib/validate.js`. Меняешь одно — меняй другое.
- **Миграции базы только добавляются** в конец `MIGRATIONS` в `server/db.js`. Старые не редактировать: на рабочей базе они уже применены.
  Внутри `tx()` нельзя `await` (SQLite синхронный) — хеш пароля и работу с файлами делать до транзакции.
- **CSP без `unsafe-inline`**: никаких `style="…"` в HTML и `setAttribute('style')`; стили — классами в CSS.
  Менять `el.style.width` из JS можно (CSSOM разрешён), так сделан прогресс загрузки.
- **Внешние адреса** (разрешены владельцем, других нет): сервер сайта ходит только к `textures.minecraft.net` и, для скина
  по нику, к `api.mojang.com`, `api.minecraftservices.com`, `sessionserver.mojang.com`; браузер посетителя — только
  к `piston-data.mojang.com` (куски `client.jar`, `McArt`). Это `connect-src` в CSP — он и в `server/lib/http.js`,
  и в мета-тегах `index.html`, `lk.html`, `players.html`: меняешь — меняй везде. `tools/mc-index.mjs` (ещё
  `piston-meta.mojang.com`) запускается только на машине разработчика.
- **`UI.append`/`h()` пропускают `null/undefined/false`**, но не `0` — для чисел писать `n > 0 && …`.
  Нативный `Element.append(null)` печатает «null» — не использовать с условными детьми.
- `[hidden]` глобально `display:none !important` (base.css): если у элемента свой `display`, `hidden` всё равно работает.
- Персонажи на карточках «выглядывают» за край (`.card--art`, `.tile--art`, `.feature__art`); анимация — только
  `scale` от нижнего края (`transform-origin: bottom`), не `translateY`, иначе появляется щель.
- Вкладки фильтров (`.tabs`) переносятся на вторую строку, а не прокручиваются; нижнее меню на телефоне — всегда одна строка
  (длинные подписи — через `short` в `navItems()`).
- **Данных пользователей и секретов в репозитории нет и быть не должно**: база в `LWL_DATA_DIR` (локально `./data/`, в `.gitignore`),
  почта владельца — только в `/etc/lwl/lwl.env` на машине (`LWL_ADMINS`), не в коде.
- **Коды входа вместо адреса сервера** (`routes/connect.js`, таблица `connect_codes`): игрок адрес **не видит** — ни в кабинете,
  ни в API (`/api/me/server` отдаёт `server.ready` и `code: {exists, last4, createdAt}`, адрес знают только админы с правом «Сервер»).
  Код — 12 символов `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`, вид `XXXX-XXXX-XXXX`, в базе только `sha256` нормализованного кода
  и последние 4 символа; целиком отдаётся один раз (`POST /api/me/connect-code`). **Контракт с модом LWL менять нельзя**
  (мод уже выпущен; клиент — `lwl-mod`, `dev.lwl.connect.SiteClient`, спека `docs/superpowers/specs/2026-10-07-lwl-connect-code-design.md`):
  `POST /api/connect {code,nickname}` → `{address}` | 404 «Неверный код» (одинаково для ника и кода) | 429 + `Retry-After` | 503 `no_address`;
  игровой сервер с `Authorization: Bearer LWL_GAME_TOKEN`: `POST /api/game/codes/verify` → `{valid[,message]}`,
  `POST /api/game/codes {nickname}` → `{code}` | 404, `DELETE /api/game/codes/{ник}` → 204; 401 — неверный токен, 503 — токен не задан.
  Ошибки этих маршрутов — ровно `{code, message}` (коды строчные: `wrong_code`, `rate_limited`, …). Лимиты `/api/connect`:
  10/мин по IP (все запросы) и 10 неверных за 10 мин по нику (`limiter.wait` до проверки, `hit` после ошибки). Тесты контракта — `tests/api.test.mjs` («коды: …»).
- Роли: `user` → `player` (при одобрении заявки, `routes/applications.js`) → `admin`. **Создатель** — не роль в базе
  (там CHECK на три роли), а владелец из `LWL_ADMINS` (`isOwner`): админ со всеми правами, повышается при старте,
  его нельзя понизить/удалить, выдать на него ссылку сброса пароля (иначе админ забрал бы аккаунт). В API — `user.creator`.
- **Права админов** — `server/lib/permissions.js` (applications, tickets, users, server, delete, admins; по умолчанию первые 4),
  хранятся в `users.admin_perms` (JSON, NULL — по умолчанию; при выдаче/снятии админа сбрасываются). Раздаёт только создатель.
  На сервере — `need.perm(ctx, …)`, в кабинете — `can(…)` (меню, маршруты, кнопки). Трогать другого админа (роль, удаление,
  сброс пароля) — только с правом «Админы» (`guardTarget` в `routes/admin.js`). Подписи прав приходят с сервера (`permissionCatalog`).
- `/api/me/summary` отдаёт `role` и (админу) `permissions` — по ним открытый кабинет замечает смену и перестраивается.
- **Автовайтлист**: при одобрении `routes/applications.js` выполняет `wl add <ник> [cracked]` через RCON (`lib/rcon.js`,
  `LWL_RCON_*` в `lwl.env`); результат — в `applications.whitelist_*`, в карточке — «Повторить» или команда вручную.
  Ответ мода проверяется по тексту («добавлен в вайтлист») — меняешь тексты `/wl` в `lwl-auth`, поправь `whitelistAdd`.
- Чат: «прочитано» (две галочки) — из `conversation_reads`, поле `peerReadAt` у обращения.
- **Фото и файлы в чате** (`routes/attachments.js`, таблица `attachments`, миграция 4): каждый файл — отдельное сообщение,
  `messages.text` — подпись (может быть пустой); новое сообщение с файлом или текстом — только через `s.chat.addMessage`
  (автоответ, открытие закрытого обращения, «прочитано»). Загрузка — `PUT /api/conversations/:id/attachments` сырым телом
  (`{raw: true}`), заголовки `X-File-Name`/`X-Caption` URL-кодированные, `X-Client-Id` — повтор без дубля; лимит
  `LWL_CHAT_MAX_FILE_MB` (25, приходит в кабинет как `conversation.maxFileBytes`), 30 файлов в минуту на человека.
  На диске — `LWL_DATA_DIR/attachments/<id>` (не имя от пользователя). **Картинка — только PNG/JPEG/GIF/WebP по первым
  байтам** (`sniffImage`, там же ширина/высота с учётом поворота из EXIF) — отдаётся `inline`; всё остальное, в том числе
  SVG и HTML, — `application/octet-stream` + `Content-Disposition: attachment`, всегда `nosniff`. Скачивание
  `GET /api/attachments/:id` — доступ как к обращению (`canAccess`), `Range`, `private, no-cache` + ETag (304).
  Удаляешь обращение или аккаунт — сначала собери id файлов (`s.attachments.idsOfConversation/idsOfPlayer`), потом
  DELETE, потом `s.attachments.removeFiles` (каскад сотрёт строки, но не файлы); остальное подчищает `sweep()` при старте
  и раз в час. Подпись идёт заголовком: длиннее `Api.chats.CAPTION_HEADER_MAX` (после кодирования) кабинет шлёт
  обычным сообщением перед файлами — nginx режет заголовки больше 8 КБ. В кабинете (`lk-chat.js`) все сообщения
  уходят по одному через `sendChain` (порядок как при отправке), неотправленные рисуются после серверных.
- **Карточки игроков** (`routes/players.js`, `routes/game.js`, `lib/skins.js`; страница — `assets/js/players.js`,
  `skin3d.js`, `players-page.js`, `players.html`). Таблицы: `player_stats` (что прислал мод `lwl-stats`, ключ — ник
  в нижнем регистре; `skin_url` + `skin_hash` — скин из игры) и `player_cards` (миграция 6: «о себе», скрыто, скрытые
  поля, поза, фон, соцсети JSON, свой скин `skin_hash`/`skin_slim`/`skin_at`, `skin_sync`/`skin_sync_note`).
  Мод шлёт `POST /api/game/presence` (полный список в игре) и `/api/game/stats` с `Bearer LWL_GAME_TOKEN`.
  **На сайт не принимаются и не отдаются координаты, инвентарь, IP, способ входа.**
  `GET /api/players` открыт всем: гостю/пользователю — только ник, роль, скин, поза, фон, «о себе», соцсети
  (`full: false`); игроку/админу (`isFull`) — ещё статистика, «в сети», даты. Скрытая карточка не попадает никуда
  (ни в список, ни в «Топы»; в `/api/online` игрок входит только числом — как в списке серверов в игре), скрытые поля вырезаются на сервере (`view()`), а не в браузере.
  Соцсети хранятся **ником**, ссылку собирает страница по `Api.SOCIALS` (`parseSocial` достаёт ник из ссылки);
  ключи и шаблоны — и в `api.js`, и в `server/lib/validate.js`.
  Скины: сервер сайта качает **только** `https://textures.minecraft.net/texture/<hex>` (`skins.normalize`), хранит
  `LWL_DATA_DIR/skins/<sha256>.png`, отдаёт `GET /api/skins/<hash>.png` (immutable). Свой скин —
  `PUT /api/me/skin` сырым PNG (проверка `isSkinPng`: 64×64 или 64×32, ≤64 КБ); если есть RCON и публичный
  `LWL_PUBLIC_URL` (`publicBase` отсекает localhost и адреса домашней сети) — `skin of <ник> url <сайт>/api/skins/<hash>.png [slim]`
  (ответ lwl-skins «Загружаю скин…» = принято; сам MineSkin может ещё упасть — это видно только в логе сервера).
  Скин по нику — `POST /api/me/skin/nick`: `lib/mojang.js` (адреса фиксированы в `config.mojang`, не env; тесты
  подменяют на локальный сервер; ник/UUID проверяются регэкспом, без редиректов, ≤32 КБ, кеш 10 мин) → URL текстуры →
  `skins.fetchNow` (всё равно только textures.minecraft.net) → `player_cards.skin_nick` (миграция 7) и RCON
  `skin of <ник> set <лицензия>` («Ищу скин лицензии…» = принято). Смена рук (`PATCH`) обнуляет `skin_nick` — дальше
  это скин по ссылке. `DELETE` («Как в игре») стирает скин из игры только если свой был поставлен на сервер (`skin_sync = 'ok'`).
  Кроме textures.minecraft.net сервер сайта ходит **только** к этим трём адресам Mojang (разрешено владельцем).
  На карточке — более новый из двух скинов (`skinOf`). `sweep()` не удаляет хеши из обеих таблиц; бэкап копирует `skins/`.
  Нет скина нигде — Стив: `config.defaultSkinTexture` (`31f477eb…`), `skins.defaultSkin()` качает его с textures.minecraft.net
  при первом обращении (асинхронно, повтор через час при ошибке), в API `skinDefault: true`; пока не скачан — `/assets/img/skin-default.png`.
  **Поза по видам** (миграция 8, `player_cards.looks` JSON): `looks.card` — маленькая карточка, `looks.detail` — окно игрока,
  каждый `{pose: ключ | 'custom', angles (у custom: head/body/руки/ноги [x,y,z] ±180°, lift), scale 0.2–4, turn ±180}`.
  Пределы `LOOK` — и в `api.js`, и в `server/lib/validate.js` (`normalizeLook`). Старая колонка `pose` = поза карточки
  (если она не custom); старое поле `pose` в PATCH меняет `looks.card.pose`. Рисует `Skin3D.draw` (`zoom` растёт от ног,
  голова и руки поворачиваются вместе с телом); `scale` — размер фигуры, не пропорции тела.
  Своя поза в кабинете — `Skin3D.poser` (как в Blockbench): `draw()` возвращает `{scale, toScreen, camera, pivot, axes}`
  и собирает в `opts.hits` грани частей (выбор нажатием). Кольца — «карданные» оси углов части (x — вокруг оси X,
  повёрнутой на y; y — вертикаль; z — после x и y), поэтому каждое кольцо меняет ровно один угол. Ползунки
  перечитывают углы (`read` в `slider()`), история для «Отменить»/Ctrl+Z — в `lookSection()`. e2e считает, где
  кольцо и стрелка «Присесть», той же математикой — меняешь радиус колец (`px`) или место стрелки в `skin3d.js`,
  поправь `poserPoints()` в `tests/e2e.mjs`.
  **Предметы и блоки** — в том же `looks.<вид>` (без миграции): `offset` [x, y] ±200 — сдвиг фигуры в кадре;
  `held` — `{rightHand, leftHand, head}`, каждый `{id, rot [x,y,z] ±180, size 0.5–2, at [x,y,z] ±16}` или `null`;
  `blocks` — до 32 `{id, at [x,y,z] (низ-центр; x, z ±96, y −48…96), rot ±180 (вокруг вертикали), size 0.25–2}`;
  `textures` — до 3 PNG 16×16 data URL (≤4096 символов, сервер смотрит IHDR), в `held`/`blocks` это id `tex1…tex3`.
  id предметов и блоков сервер сверяет с `assets/js/mc-index.json` с диска (`mcKnown` в `validate.js`: без сети,
  читается раз за запуск; файла нет — можно только свои картинки). `normalizeLook` округляет и выкидывает пустое.
  Пределы `LOOK` — и в `validate.js`, и в `api.js`.
  Рисует `Skin3D.draw` (`held`, `blocks`, `textures`; `onModel` — перерисовать, когда модель догрузилась; в `opts.hits`
  ключи `held:<слот>` и `block:<i>`). Предмет в руке/на голове — цепочкой игры (`heldTransform`: ItemInHandLayer /
  CustomHeadLayer + `display.thirdperson_righthand|thirdperson_lefthand|head` модели, нет левой — зеркало правой),
  поверх — свои `rot`/`size`/`at`. Блоки сцены: 16 единиц = блок (персонаж — 32).
  Модели — `McArt`: браузер берёт куски официального `client.jar` прямо у Mojang (`piston-data.mojang.com`, Range
  кусками по 32 КБ, соседние — одним запросом), распаковывает `DecompressionStream('deflate-raw')`, куски хранит
  в Cache Storage `mc-jar-<версия>` и качает с `cache: 'no-store'` — HTTP-кеш браузера на Range иногда отдавал весь
  jar (41 МБ). Не загрузилось — модели нет до перезагрузки страницы. Названия — английские, `lang/en_us.json` из jar
  (русские лежат на `resources.download.minecraft.net`, а там нет CORS). Сундук, щит и прочее, что игра рисует
  сущностями (`special`), в оглавление не попадает; вода и лава — кубы с текстурой `*_still`.
  `node tools/mc-index.mjs [версия]` (по умолчанию 26.3) — только на машине разработчика, не на сервере сайта:
  читает `client.jar` кусками (Range) и пишет в `mc-index.json` лишь имена, смещения и размеры файлов в jar, родителей
  моделей, списки блоков и предметов — содержимого Mojang в репозитории нет. Обновляешь Minecraft — перезапусти его.
  **Свой фон** (`lib/backgrounds.js`, `player_cards.bg_file`): браузер сжимает (`compressBackground` в `api.js`: WebP,
  запасной JPEG, ≤1280 точек), сервер принимает `PUT /api/me/background` сырым телом WebP/JPEG/PNG ≤400 КБ и ≤1600 точек,
  без анимированного WebP (проверка по первым байтам `sniffImage`), хранит `LWL_DATA_DIR/backgrounds/<sha256>.<ext>`,
  отдаёт `GET /api/backgrounds/<имя>` (immutable, `nosniff`). При замене старый файл удаляется (`release`, если на него
  больше никто не ссылается), остальное подчищает `sweep()` раз в час; бэкап копирует `backgrounds/`.
  Один фон на оба вида. Убрать чужую картинку — `DELETE /api/players/:nick/background` (право «Люди»; кнопка в окне
  игрока, `Players.allowModeration` — из кабинета и с `players-page.js`). Так же свои картинки 16×16 —
  `DELETE /api/players/:nick/textures` (кнопка «Убрать свои картинки», `Api.players.removePlayerTextures`): убирает
  `textures` из обоих видов и все `held`/`blocks` с id `texN`, остальное в позе не трогает. Журнала действий админов нет.
  `GET /api/online` → `{count}` без входа, 60/мин с IP; «в сети» = `online = 1` и вести не старше `ONLINE_WINDOW_MS` (150 с).
  В e2e статистику шлёт сам тест с `LWL_GAME_TOKEN` (как мод).
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
`update.sh` читает из `lwl.env`), HTTPS certbot, бэкап базы и файлов из чата каждую ночь в `/var/backups/lwl`.
Машина владельца общая (домашний сервер с другими программами): установщик не трогает чужие сайты nginx и порты.
У владельца 80/443 держит **Caddy в Docker** (контейнер `caddy`, образ `caddy:2`, host-сеть, bind на LAN-IP;
на 443 Tailscale-IP ещё tailscaled), поэтому `install.sh` сам выбирает режим Caddy; nginx и certbot не ставит.
Блок сайта — `deploy/Caddyfile.template`, bind тот же, что у Caddy. Как подключает:
служба `caddy` → `/etc/caddy/lwl.caddy` + `import` + `systemctl reload caddy`;
Docker → находит Caddyfile на машине по `docker inspect` (Mounts), дописывает блок между `# >>> Сайт LWL`/`# <<< Сайт LWL`
на месте (не `mv`: файл примонтирован) и делает `docker exec … caddy reload`. При ошибке откатывает. Сайт берёт IP посетителя из `X-Real-IP` (`clientIp` в `lib/http.js`): в любом прокси
его нужно выставлять (`header_up X-Real-IP {remote_host}`), иначе лимиты сработают на всех сразу.
Загрузка сборок и файлов в чат идёт потоком (`proxy_request_buffering off` на `…/packs/<id>/file` и
`…/conversations/<id>/attachments`), скачивание сборок — без буфера nginx, с `Range`. Бэкап (`deploy/backup.sh`) —
база и папки-снимки `attachments-ДАТА`, `skins-ДАТА`, `backgrounds-ДАТА` (неизменившиеся файлы — жёсткими ссылками на вчерашний снимок).
Если добавляешь зависимость, переменную окружения или системный пакет — обнови `deploy/install.sh`, `deploy/lwl.env.example` и `deploy/README.md`.
`LWL_GAME_TOKEN` (токен игрового сервера для входа по коду и статистики) `install.sh` и `update.sh` генерируют сами, если его нет в `lwl.env`,
и печатают, куда вписать на сервере: `config/lwl/connect.json` → `siteToken` (и `siteUrl`); тот же токен — в `config/lwl-stats.json`.

## Что дальше (идеи, о которых говорили)

- Убирать из вайтлиста через RCON (`wl remove`), когда админ удаляет аккаунт игрока или снимает роль «Игрок».
- Письма (сброс пароля, уведомления) — если появится SMTP: `LWL_SMTP_URL` в `lwl.env`, отправка из `routes/auth.js`.
- Чат без опроса (SSE) — заменить только `Api.chats.subscribe` и добавить поток на сервере.
- Узнавать, что MineSkin не смог взять свой скин игрока (сейчас «ок» = мод принял команду): ответ мода приходит позже, по RCON его не видно.
- Проверить `lwl-stats` на настоящем сервере 26.3 (пока только сборка и тесты сайта).
