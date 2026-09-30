# LWL — сайт minecraft-сервера

Лендинг и личный кабинет по макету Figma
[`YKqqIlIyP7Xq28pw7R1e5T`](https://www.figma.com/design/YKqqIlIyP7Xq28pw7R1e5T/Untitled?node-id=0-1).
Чистые HTML/CSS/JS без фреймворков и сборки, адаптив от 320px до 1920px и шире.

| Страница | Что внутри |
| --- | --- |
| `index.html` | Лендинг: шапка, большая картинка с 3D-логотипом, «О нас» (6 карточек), футер с Telegram |
| `lk.html` | Личный кабинет: главная игрока и админа, чаты, заявки, профиль |

## Запуск

```bash
npm start            # http://localhost:8080 — простой сервер без зависимостей
```

Можно открыть `index.html` двойным кликом, но через сервер надёжнее (шрифты, localStorage).

## Экраны кабинета

Четыре экрана из макета плюс всё, что нужно для работы.

| Маршрут | Экран | Макет |
| --- | --- | --- |
| `#/` | Главная игрока: «Прогресс заявки», «Тех поддержка» | Frame 2 |
| `#/` | Главная админа: «Просмотр Заявок», «Просмотр Обращений» | Frame 4 |
| `#/support` | Чат игрока с поддержкой | Frame 5 |
| `#/admin/tickets/:id` | Чат админа с игроком | Frame 6 |
| `#/apply` | Анкета «Подать заявку» | — |
| `#/application` | Прогресс заявки: этапы, решение, причина отказа, отзыв заявки | — |
| `#/admin/applications[/:id]` | Список заявок с фильтрами и поиском, решение с комментарием | — |
| `#/admin/tickets` | Список обращений: непрочитанные, «в сети», поиск, открытые/закрытые | — |
| `#/profile` | Фото (загрузка, перетаскивание, удаление), ник, пароль, удаление аккаунта | — |

Что продумано:

- **Пустые состояния.** Нет заявки, нет обращений, пустой чат, ничего не найдено.
- **Загрузка.** Скелетоны, спиннеры на кнопках.
- **Ошибки.** Ошибки полей и общие, экран «Не удалось загрузить» с кнопкой «Повторить», истёкшая сессия, 404, «нет доступа».
- **Чат:**
  - сообщение появляется сразу, до ответа сервера; неотправленное можно повторить или удалить;
  - повторная отправка не создаёт дублей;
  - при прокрутке вверх подгружается история, есть разделители по дням;
  - сообщения группируются по автору;
  - кнопка «N новых сообщений», если вы прокрутили ленту вверх;
  - статус «В сети... / был(а) N минут назад», отметки о прочтении, бейджи непрочитанного;
  - ссылки кликабельны, HTML из сообщений не выполняется;
  - черновик сохраняется, поле растёт по высоте, счётчик символов;
  - Enter отправляет сообщение, Shift+Enter переносит строку (на телефоне Enter переносит строку);
  - админ может закрыть обращение и открыть его снова.
- **Мобильная версия.** Чат на весь экран с кнопкой «назад» в шапке, поле ввода учитывает безопасные зоны экрана, окна открываются снизу, на лендинге меню-бургер.
- **Доступность.** Ловушка фокуса в модальных окнах, Esc, aria-атрибуты, `prefers-reduced-motion`.

## Демо-режим (сейчас)

Сервера пока нет, поэтому все данные живут **только в localStorage браузера**. В репозитории пользовательских данных нет.

- Пароли хешируются **PBKDF2-SHA256, 600 000 итераций, соль 16 байт на пользователя** (WebCrypto, рекомендация OWASP 2023). Сравнение хешей идёт за постоянное время.
- После 5 неверных паролей вход блокируется на минуту.
- Сессия хранится в sessionStorage, а с галочкой «Запомнить меня» — в localStorage.
- В профиле можно переключить роль «Игрок / Админ», чтобы посмотреть кабинет администратора.
- Переписку можно проверить с двух сторон: войдите вторым аккаунтом в соседней вкладке без галочки «Запомнить меня». Сообщения приходят между вкладками мгновенно (BroadcastChannel).
- Параметр `?demoFail=0.3` имитирует сбои сети в 30% запросов, чтобы проверить экраны ошибок.

## Подключение своего сервера

**Все обращения к данным — в одном файле `assets/js/api.js`.** Интерфейс ничего не знает о хранилище. Чтобы переключиться на сервер, поменяйте `assets/js/config.js`:

```js
window.LWL_CONFIG = {
  apiMode: 'server',
  apiBaseUrl: 'https://api.example.com',
  telegramUrl: 'https://t.me/ваш_канал', // ссылка кнопки «Подписаться» в футере
};
```

Если API на другом домене, добавьте его в `connect-src` в мета-теге CSP в `index.html` и `lk.html` (сейчас там стоит `https:`).

### Контракт API

- Все ответы в JSON, время — в миллисекундах Unix.
- После входа сервер отдаёт `{ token, user }`. Клиент шлёт `Authorization: Bearer <token>` и `credentials: 'include'`, так что подойдут и httpOnly-куки.
- Ошибки приходят со статусом 4xx/5xx и телом `{ "code": "…", "message": "текст для пользователя", "fields": { "поле": "ошибка" } }`. Коды: `VALIDATION`, `INVALID_CREDENTIALS`, `NICK_TAKEN`, `EMAIL_TAKEN`, `UNAUTHORIZED`, `FORBIDDEN`, `NOT_FOUND`, `CONFLICT`, `RATE_LIMITED` (+ заголовок `Retry-After`).

| Метод | Путь | Тело → ответ |
| --- | --- | --- |
| POST | `/auth/register` | `{nickname, email, password}` → `{token, user}` |
| POST | `/auth/login` | `{login, password, remember}` (login — ник или почта) → `{token, user}` |
| POST | `/auth/logout` | → 204 |
| GET | `/auth/me` | → `{user}` или 401 |
| POST | `/auth/password-reset` | `{email}` → 204 |
| PATCH | `/me` | `{nickname?, avatar?}` (avatar — data URL или `null`) → `{user}` |
| POST | `/me/password` | `{currentPassword, newPassword}` → 204 |
| DELETE | `/me` | `{password}` → 204 |
| POST | `/me/presence` | → 204 (раз в 25 с, пока вкладка открыта) |
| GET | `/me/summary` | → игрок `{unreadMessages, applicationStatus}`, админ `{pendingApplications, unreadConversations}` |
| GET | `/applications/mine` | → `{application}` (последняя или `null`) |
| POST | `/applications` | `{age, source, about, contact, agree}` → `{application}` |
| POST | `/applications/:id/withdraw` | → `{application}` |
| GET | `/applications?status=pending\|approved\|rejected\|all&q=` | админ → `{items, counts}` |
| GET | `/applications/:id` | → `{application}` |
| POST | `/applications/:id/review` | админ, `{status: 'approved'\|'rejected', comment}` → `{application}` |
| POST | `/support/conversation` | → `{conversation}` (создаёт, если ещё нет) |
| GET | `/conversations?status=open\|closed\|all&q=` | админ → `{items}` |
| GET | `/conversations/:id` | → `{conversation}` |
| GET | `/conversations/:id/messages?before=&limit=` | → `{items, hasMore}` (по возрастанию времени) |
| POST | `/conversations/:id/messages` | `{text, clientId}` → `{message}` (повтор с тем же `clientId` не создаёт дубль) |
| POST | `/conversations/:id/read` | → 204 |
| POST | `/conversations/:id/close`, `/reopen` | админ → 204 |

Форма объектов — как в демо-реализации в `api.js`:

- `user`: `{id, nickname, email, role: 'player'|'admin', avatar, createdAt, lastSeenAt}`;
- краткий пользователь: `{id, nickname, role, avatar, online, lastSeenAt}`;
- `application`: `{id, nickname, age, about, source, contact, status, comment, createdAt, updatedAt, history[], applicant, reviewer}`;
- `conversation`: `{id, status, player, partner, lastMessage, unread, createdAt, updatedAt}`;
- `message`: `{id, clientId, text, createdAt, authorId, system, author}`.

Новые сообщения в серверном режиме подтягиваются опросом раз в 4 с (`pollIntervalMs`). Когда появятся WebSocket/SSE, заменить нужно только `Api.chats.subscribe`.

## Что взято из Figma

Макет прочитан через коннектор Figma: координаты, цвета, шрифты, тексты и исходные картинки.

- **Шрифт** — Russo One. Лежит в репозитории в `assets/fonts` (лицензия OFL).
- **Цвета**:
  - фон `#2B2B2B`;
  - шапка `#202020`;
  - полоса сверху `#005337`;
  - карточки `#343434`;
  - панели чата `#3F3F3F` и `#333333`;
  - градиент кнопок `#1598D9 → #1EC5DC`;
  - «в сети» `#1F9837`.
- **Размеры** — лендинг 1920px с контейнером 1200px, кабинет 1920×993. Токены лежат в `assets/css/base.css`.
- **Оригиналы картинок** байт в байт как в Figma лежат в `design/figma/originals/`. Рендеры фреймов для сравнения — в `design/figma/frames/`.
- **Картинки на сайте** (`assets/img/*.webp`) обрезаны ровно по кадру слоя в Figma и сохранены в 2× (скрипт `tools/prepare-assets.py`).
- **Логотип и иконка Telegram в Figma — растровые PNG**, векторного оригинала в файле нет. Поэтому `logo.svg`, `logo-3d.svg` и `telegram.svg` получены векторизацией. У Telegram окружности построены точными примитивами. Сходство с оригиналом проверено попиксельно: средняя разница около 2 из 255.
- Тексты абзацев в макете масштабированы: в Figma указано «28», а по рендеру видно ≈27.8px. В CSS стоят измеренные значения.

`tools/figma-export.mjs` — выгрузка тех же данных напрямую через REST API Figma (`FIGMA_TOKEN` со скоупом **File content: Read-only**). У нынешнего токена этого скоупа нет, поэтому использовался коннектор.

## Сравнение с макетом

`npm run compare` снимает 5 экранов в 1920px с теми же данными, что в макете, и сравнивает попиксельно с рендерами фреймов (pixelmatch, порог 0.1):

| Экран | Отличающихся пикселей |
| --- | --- |
| Лендинг | 0.93% |
| Кабинет игрока | 0.22% |
| Кабинет админа | 0.28% |
| Чат игрока | 0.12% |
| Чат админа | 0.11% |

Остаток — сглаживание текста. Кроме того, Chromium под Linux округляет кегль 27.8px до целого; на macOS и Windows совпадение выше. Картинки «макет | сайт» лежат в `design/compare/*.webp`.

## Тесты

```bash
npm install && npx playwright install chromium
npm test          # сквозной сценарий: 38 проверок
npm run compare   # сравнение с макетом
```

Сценарий проверяет:

- регистрацию и валидацию;
- занятый ник, неверный пароль и блокировку входа после ошибок;
- загрузку аватара;
- заявку от подачи до одобрения;
- переписку игрока и админа в реальном времени;
- XSS в сообщениях;
- бейджи, закрытие обращения, экран ошибки сети, выход;
- что пароль хранится только хешем.

## Структура

```
index.html, lk.html
assets/css/      base.css (токены, кнопки, формы, окна), landing.css, lk.css
assets/js/       config.js — настройки
                 api.js    — ЕДИНСТВЕННЫЙ слой данных (демо + сервер)
                 ui.js     — DOM-помощники, окна, уведомления, форматирование
                 auth.js   — окно входа и регистрации
                 landing.js, lk.js (роутер и экраны), lk-chat.js (чат)
assets/img/      картинки сайта (SVG, WebP)
assets/fonts/    Russo One + лицензия
design/figma/    оригиналы из Figma и рендеры фреймов
design/compare/  результаты сравнения
tools/           figma-export.mjs, prepare-assets.py, compare.mjs, static-server.mjs
tests/           e2e.mjs
```
