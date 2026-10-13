/**
 * Письма через SMTP владельца — без зависимостей (node:net / node:tls). Выключено, пока не задан LWL_SMTP_URL:
 *   smtps://логин:пароль@smtp.example.ru:465 — сразу TLS;
 *   smtp://логин:пароль@smtp.example.ru:587  — STARTTLS (обязателен, кроме адреса 127.0.0.1/localhost).
 * Логин и пароль в адресе — URL-кодированные. Отправитель — LWL_MAIL_FROM (по умолчанию логин).
 * Это единственный внешний адрес, который задаёт сам владелец; других сайт не знает.
 */
import net from 'node:net';
import tls from 'node:tls';
import { randomBytes } from 'node:crypto';

const LOCAL = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);
const ADDR = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+$/;

/** Разбор LWL_SMTP_URL; пусто или ошибка — null (письма выключены). */
export function parseSmtpUrl(raw, from = '') {
  if (!raw) return null;
  let u;
  try {
    u = new URL(raw);
  } catch {
    console.error('LWL_SMTP_URL: неверный адрес — письма выключены.');
    return null;
  }
  if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:') {
    console.error('LWL_SMTP_URL: нужен smtp:// или smtps:// — письма выключены.');
    return null;
  }
  const user = decodeURIComponent(u.username);
  const sender = String(from || user).trim();
  if (!ADDR.test(sender)) {
    console.error('LWL_MAIL_FROM: нужна почта отправителя — письма выключены.');
    return null;
  }
  return {
    host: u.hostname,
    port: Number(u.port) || (u.protocol === 'smtps:' ? 465 : 587),
    secure: u.protocol === 'smtps:',
    user,
    password: decodeURIComponent(u.password),
    from: sender,
    timeoutMs: 15_000,
  };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const word = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);

/** Текст письма: заголовки + тело в base64 (кириллица, длинные строки). */
export function buildMessage({ from, to, subject, text, fromName = 'LWL' }) {
  const body = b64(text.replace(/\r?\n/g, '\r\n'))
    .match(/.{1,76}/g)
    .join('\r\n');
  return [
    `From: ${word(fromName)} <${from}>`,
    `To: <${to}>`,
    `Subject: ${word(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${randomBytes(12).toString('hex')}@${from.split('@')[1]}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
}

/** Одно письмо. Ошибка — исключение с текстом ответа сервера. */
export function sendMail(cfg, { to, subject, text }) {
  if (!ADDR.test(to)) return Promise.reject(new Error('Неверная почта получателя.'));
  const message = buildMessage({ from: cfg.from, to, subject, text });
  return new Promise((resolve, reject) => {
    let sock = cfg.secure ? tls.connect({ host: cfg.host, port: cfg.port, servername: cfg.host }) : net.connect({ host: cfg.host, port: cfg.port });
    let buf = '';
    let waiter = null;
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      sock.destroy();
      if (err) reject(err);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error('Почтовый сервер не ответил вовремя.')), cfg.timeoutMs);

    // Ответ SMTP: строки «250-…» и последняя «250 …».
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      const m = buf.match(/(?:^|\r\n)(\d{3}) [^\r\n]*\r\n$/);
      if (!m || !waiter) return;
      const reply = { code: Number(m[1]), text: buf.trim() };
      buf = '';
      const w = waiter;
      waiter = null;
      w(reply);
    };
    const read = () =>
      new Promise((r) => {
        waiter = r;
        onData(''); // ответ мог прийти раньше, чем его стали ждать
      });
    const cmd = async (line, ok) => {
      if (line !== null) sock.write(line + '\r\n');
      const reply = await read();
      if (!ok.includes(reply.code)) throw new Error(`Почтовый сервер: ${reply.text.slice(0, 200)}`);
      return reply;
    };
    const attach = (s) => {
      s.on('data', onData);
      s.on('error', (e) => finish(e));
      s.on('close', () => finish(new Error('Почтовый сервер закрыл соединение.')));
    };
    attach(sock);

    (async () => {
      await cmd(null, [220]);
      let ehlo = await cmd('EHLO lwl', [250]);
      if (!cfg.secure) {
        if (/STARTTLS/i.test(ehlo.text)) {
          await cmd('STARTTLS', [220]);
          sock.removeAllListeners('data');
          sock.removeAllListeners('close');
          sock.removeAllListeners('error');
          sock = tls.connect({ socket: sock, servername: cfg.host });
          attach(sock);
          await new Promise((r, j) => (sock.once('secureConnect', r), sock.once('error', j)));
          ehlo = await cmd('EHLO lwl', [250]);
        } else if (!LOCAL.has(cfg.host)) {
          throw new Error('Почтовый сервер не умеет STARTTLS — пароль без шифрования не отправляем. Используйте smtps://.');
        }
      }
      if (cfg.user) {
        await cmd('AUTH PLAIN ' + Buffer.from(`\0${cfg.user}\0${cfg.password}`, 'utf8').toString('base64'), [235]);
      }
      await cmd(`MAIL FROM:<${cfg.from}>`, [250]);
      await cmd(`RCPT TO:<${to}>`, [250, 251]);
      await cmd('DATA', [354]);
      // Строки, начинающиеся с точки, удваиваем (так требует SMTP).
      await cmd(message.replace(/(^|\r\n)\./g, '$1..') + '\r\n.', [250]);
      sock.write('QUIT\r\n');
      finish();
    })().catch(finish);
  });
}

/**
 * Почта сайта: send() ничего не ждёт и не бросает — ошибка только в журнал (письмо — не главное).
 * Без настроек enabled = false, и send() молча ничего не делает.
 */
export function createMailer(cfg) {
  return {
    enabled: !!cfg,
    send(to, subject, text) {
      if (!cfg || !to) return Promise.resolve(false);
      return sendMail(cfg, { to, subject, text }).then(
        () => true,
        (err) => {
          console.error(`[${new Date().toISOString()}] письмо на ${to.replace(/^(.).*@/, '$1…@')} не ушло: ${err.message}`);
          return false;
        }
      );
    },
  };
}
