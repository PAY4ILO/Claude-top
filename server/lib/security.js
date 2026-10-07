/** Пароли, токены, идентификаторы, ограничение частоты запросов. */
import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(crypto.scrypt);

// scrypt: N=2^15 — около 60–100 мс на обычном VPS и 32 МБ памяти на один хеш.
const PROD = { N: 32768, r: 8, p: 1 };
const FAST = { N: 1024, r: 8, p: 1 }; // только для тестов (LWL_FAST_HASH=1)
let params = PROD;

export function useFastHashing(fast) {
  params = fast ? FAST : PROD;
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const { N, r, p } = params;
  const key = await scrypt(String(password).normalize('NFKC'), salt, 32, { N, r, p, maxmem: 128 * N * r * 2 });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  const key = await scrypt(String(password).normalize('NFKC'), salt, expected.length, { N, r, p, maxmem: 128 * N * r * 2 });
  return crypto.timingSafeEqual(key, expected);
}

/** Хеш-пустышка: чтобы по времени ответа нельзя было понять, есть ли такой аккаунт. */
let dummyHash = null;
export async function burnPasswordTime(password) {
  if (!dummyHash) dummyHash = await hashPassword('dummy-password-1');
  await verifyPassword(password, dummyHash);
}

export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const newId = (prefix) => prefix + '_' + crypto.randomBytes(9).toString('base64url');

/** Сравнение секретов без утечки по времени (и по длине): сравниваются хеши одинаковой длины. */
export function safeEqual(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y);
}

/* ---------------------------------------------------------------- коды входа на сервер */

// Без похожих 0/O и 1/I. Тот же алфавит и та же нормализация — в моде LWL (dev.lwl.connect.ConnectCode).
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const CODE_LENGTH = 12;

/** Любой регистр, с дефисами и пробелами или без (в том числе неразрывные пробелы и тире из буфера обмена). */
export const normalizeCode = (raw) => String(raw == null ? '' : raw).replace(/[\s\p{Zs}\p{Pd}]/gu, '').toUpperCase();
export const isCode = (normalized) => normalized.length === CODE_LENGTH && [...normalized].every((c) => CODE_ALPHABET.includes(c));
/** XXXX-XXXX-XXXX */
export const formatCode = (normalized) => normalized.match(/.{1,4}/g).join('-');

export function generateCode() {
  let code = '';
  for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
  return code;
}

/**
 * Простой ограничитель частоты в памяти процесса (сайт работает одним процессом).
 * hit(key, max, windowMs) → сколько секунд ждать (0 — можно).
 */
export class RateLimiter {
  constructor() {
    this.buckets = new Map();
    this.timer = setInterval(() => this.sweep(), 60_000).unref();
  }

  hit(key, max, windowMs) {
    const now = Date.now();
    let b = this.buckets.get(key);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + windowMs };
      this.buckets.set(key, b);
    }
    b.count++;
    return b.count > max ? Math.ceil((b.resetAt - now) / 1000) : 0;
  }

  /** Сколько секунд ждать, не считая саму попытку (когда считаются только неудачи: wait() до, hit() после ошибки). */
  wait(key, max) {
    const b = this.buckets.get(key);
    const now = Date.now();
    return b && b.resetAt > now && b.count >= max ? Math.ceil((b.resetAt - now) / 1000) : 0;
  }

  sweep() {
    const now = Date.now();
    for (const [k, b] of this.buckets) if (b.resetAt <= now) this.buckets.delete(k);
  }

  stop() {
    clearInterval(this.timer);
  }
}
