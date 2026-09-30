/**
 * RCON — удалённая консоль Minecraft-сервера (enable-rcon=true в server.properties).
 * Через неё сайт сам добавляет одобренных игроков в вайтлист мода LWL Auth: /wl add <ник> [cracked].
 * Протокол (minecraft.wiki/w/RCON): пакет = [длина][id][тип][текст UTF-8]\0\0, числа int32 little-endian.
 * Сначала вход паролем (тип 3; в ответ id = -1, если пароль неверный), потом команда (тип 2).
 */
import net from 'node:net';

const LOGIN = 3;
const COMMAND = 2;
const LOGIN_ID = 1;
const COMMAND_ID = 2;
const NICK = /^[A-Za-z0-9_]{3,16}$/;

export const rconConfigured = (cfg) => !!(cfg && cfg.password);

function packet(id, type, text) {
  const body = Buffer.from(text, 'utf8');
  const buf = Buffer.alloc(14 + body.length);
  buf.writeInt32LE(10 + body.length, 0);
  buf.writeInt32LE(id, 4);
  buf.writeInt32LE(type, 8);
  body.copy(buf, 12);
  return buf; // два последних байта уже нули
}

/** Выполнить команду в консоли сервера; возвращает её ответ (текст без цветовых кодов). */
export function rconCommand(cfg, command) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: cfg.host, port: cfg.port });
    let buf = Buffer.alloc(0);
    let loggedIn = false;
    let finished = false;
    const finish = (err, value) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      socket.destroy();
      if (err) reject(err);
      else resolve(value);
    };
    const timer = setTimeout(() => finish(new Error('Сервер Minecraft не ответил вовремя.')), cfg.timeoutMs || 5000);

    socket.on('connect', () => socket.write(packet(LOGIN_ID, LOGIN, cfg.password)));
    socket.on('error', (e) =>
      finish(new Error(e.code === 'ECONNREFUSED' ? 'Сервер Minecraft выключен или на нём не включён RCON (enable-rcon=true).' : `Нет связи с сервером Minecraft (${e.code || e.message}).`))
    );
    socket.on('close', () => finish(new Error('Сервер Minecraft закрыл соединение.')));
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      while (buf.length >= 4) {
        const len = buf.readInt32LE(0);
        if (len < 10 || len > 1 << 20) return finish(new Error('Непонятный ответ от сервера Minecraft.'));
        if (buf.length < 4 + len) return;
        const id = buf.readInt32LE(4);
        const text = buf.toString('utf8', 12, 4 + len - 2);
        buf = buf.subarray(4 + len);
        if (!loggedIn) {
          if (id === -1) return finish(new Error('Сервер Minecraft не принял пароль RCON — сверьте LWL_RCON_PASSWORD и rcon.password.'));
          if (id === LOGIN_ID) {
            loggedIn = true;
            socket.write(packet(COMMAND_ID, COMMAND, command));
          }
        } else if (id === COMMAND_ID) {
          return finish(null, text.replace(/§./g, '').trim());
        }
      }
    });
  });
}

/**
 * Добавить ник в вайтлист мода LWL Auth. license 'cracked' — вход по паролю (пиратка),
 * иначе режим определится сам (лицензия заходит без пароля). Бросает ошибку с понятным текстом.
 */
export async function whitelistAdd(cfg, nickname, license) {
  // Ник уже проверен при регистрации, но в консоль сервера уходит только то, что точно ник.
  if (!NICK.test(nickname)) throw new Error('Такой ник в Minecraft невозможен.');
  const reply = await rconCommand(cfg, `wl add ${nickname}${license === 'cracked' ? ' cracked' : ''}`);
  if (/добавлен в вайтлист|уже был в вайтлисте/.test(reply)) return reply;
  if (/unknown or incomplete command|неизвестная или неполная команда/i.test(reply)) throw new Error('Сервер не знает команду /wl — установлен ли на нём мод LWL Auth?');
  throw new Error(reply || 'Сервер Minecraft ничего не ответил.');
}

export const whitelistList = (cfg) => rconCommand(cfg, 'wl list');
