/**
 * Вход на Minecraft-сервер по личному коду вместо адреса сервера.
 * Игрок получает код во вкладке «Сервер», вводит его в игре (мод LWL: «Сетевая игра» → «Сервер LWL»),
 * мод спрашивает у сайта адрес (/api/connect), а сервер при входе проверяет код (/api/game/…).
 *
 * Контракт с модом (lwl-mod, dev.lwl.connect.SiteClient) МЕНЯТЬ НЕЛЬЗЯ: пути, поля, статусы, ошибки
 * { code, message }, Retry-After у 429. Коротко он описан в CLAUDE.md («Коды входа»).
 */
import { HttpError } from '../lib/http.js';
import { formatCode, generateCode, isCode, normalizeCode, safeEqual, sha256 } from '../lib/security.js';

const str = (v) => (typeof v === 'string' ? v : '');
const isPlayer = (u) => !!u && (u.role === 'player' || u.role === 'admin');

// Ограничения частоты для /api/connect: по IP — все запросы, по нику — только неверные коды.
const IP_LIMIT = { max: 10, windowMs: 60_000 };
const NICK_LIMIT = { max: 10, windowMs: 10 * 60_000 };

const WRONG_CODE = 'Неверный код';
const rateLimited = (seconds) => new HttpError(429, 'rate_limited', `Слишком много попыток. Подождите ${seconds} с.`, { retryAfter: seconds });

export default function register(router, s) {
  const { db, config, limiter } = s;

  const userByNick = db.prepare('SELECT * FROM users WHERE nickname = ?'); // nickname COLLATE NOCASE — без учёта регистра
  const codeOf = db.prepare('SELECT * FROM connect_codes WHERE user_id = ?');
  const findUser = (nickname) => {
    const nick = str(nickname).trim();
    return nick && nick.length <= 64 ? userByNick.get(nick) : null;
  };

  /** Коды входа — общие для кабинета игрока, админки и игрового сервера. */
  const codes = {
    /** Что показать в кабинете: { exists, last4, createdAt } — без самого кода. */
    info(userId) {
      const row = codeOf.get(userId);
      return row ? { exists: true, last4: row.last4, createdAt: row.created_at } : { exists: false, last4: null, createdAt: null };
    },
    /** Новый код (старый перестаёт работать). Возвращает его в виде XXXX-XXXX-XXXX — больше его нигде нет. */
    issue(userId) {
      const code = generateCode();
      db.prepare(
        'INSERT INTO connect_codes (user_id, code_hash, last4, created_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET code_hash = excluded.code_hash, last4 = excluded.last4, created_at = excluded.created_at'
      ).run(userId, sha256(code), code.slice(-4), Date.now());
      return formatCode(code);
    },
    revoke(userId) {
      return db.prepare('DELETE FROM connect_codes WHERE user_id = ?').run(userId).changes > 0;
    },
    /**
     * Проверка кода игрока: 'ok' | 'no_player' | 'no_code' | 'wrong'.
     * Хеш сравнивается всегда (и с пустышкой, если кода нет) — чтобы время ответа не выдавало, есть ли такой ник.
     */
    check(user, rawCode) {
      const code = normalizeCode(rawCode);
      const row = isPlayer(user) ? codeOf.get(user.id) : null;
      const same = safeEqual(sha256(isCode(code) ? code : ''), row ? row.code_hash : 'no-code');
      if (!isPlayer(user)) return 'no_player';
      if (!row) return 'no_code';
      return same && isCode(code) ? 'ok' : 'wrong';
    },
  };
  s.codes = codes;

  /* ------------------------------------------------------------ клиент игры (без входа на сайт) */

  router.add('POST', '/api/connect', (ctx) => {
    const ipWait = limiter.hit(`connect-ip:${ctx.ip}`, IP_LIMIT.max, IP_LIMIT.windowMs);
    if (ipWait) throw rateLimited(ipWait);
    const nickKey = 'connect-nick:' + str(ctx.body.nickname).trim().toLowerCase().slice(0, 64);
    const nickWait = limiter.wait(nickKey, NICK_LIMIT.max);
    if (nickWait) throw rateLimited(nickWait);

    // Неизвестный ник, не игрок, нет кода, неверный код — один и тот же ответ.
    if (codes.check(findUser(ctx.body.nickname), ctx.body.code) !== 'ok') {
      limiter.hit(nickKey, NICK_LIMIT.max, NICK_LIMIT.windowMs);
      throw new HttpError(404, 'wrong_code', WRONG_CODE);
    }
    const address = s.settings.all().serverAddress.trim();
    if (!address) throw new HttpError(503, 'no_address', 'Адрес сервера ещё не указан');
    return { address };
  });

  /* ------------------------------------------------------------ игровой сервер (Authorization: Bearer) */

  function needGame(ctx) {
    if (!config.gameToken) throw new HttpError(503, 'disabled', 'Вход по коду на сайте выключен: не задан LWL_GAME_TOKEN.');
    const m = /^Bearer\s+(\S+)\s*$/i.exec(String(ctx.req.headers.authorization || ''));
    if (!m || !safeEqual(m[1], config.gameToken)) throw new HttpError(401, 'unauthorized', 'Неверный токен сайта (siteToken в config/lwl/connect.json).');
  }

  const VERIFY_MESSAGES = {
    no_player: (nick) => `Ника ${nick} нет среди игроков сайта LWL. Подайте заявку на сайте — после одобрения там появится код.`,
    no_code: () => 'У вас ещё нет кода. Получите его на сайте LWL во вкладке «Сервер».',
    wrong: () => 'Код не подходит. Возьмите код на сайте LWL во вкладке «Сервер»; потеряли — создайте там новый.',
  };

  router.add('POST', '/api/game/codes/verify', (ctx) => {
    needGame(ctx);
    const nick = str(ctx.body.nickname).trim();
    const result = codes.check(findUser(nick), ctx.body.code);
    return result === 'ok' ? { valid: true } : { valid: false, message: VERIFY_MESSAGES[result](nick) };
  });

  router.add('POST', '/api/game/codes', (ctx) => {
    needGame(ctx);
    const nick = str(ctx.body.nickname).trim();
    const user = findUser(nick);
    if (!isPlayer(user)) throw new HttpError(404, 'player_not_found', `Игрок ${nick || '(без ника)'} не найден на сайте: нет такого аккаунта или заявку ещё не одобрили.`);
    return { code: codes.issue(user.id) };
  });

  router.add('DELETE', '/api/game/codes/:nickname', (ctx) => {
    needGame(ctx);
    const user = findUser(ctx.params.nickname);
    if (user) codes.revoke(user.id);
    return null; // 204 — и когда кода не было
  });
}
