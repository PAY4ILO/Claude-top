/**
 * Настройки сервера сайта — только из переменных окружения.
 * На машине они лежат в /etc/lwl/lwl.env (см. deploy/), в репозитории — только пример deploy/lwl.env.example.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function loadConfig(env = process.env) {
  const publicUrl = String(env.LWL_PUBLIC_URL || '').replace(/\/+$/, '');
  const list = (v) =>
    String(v || '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  return {
    host: env.LWL_HOST || '127.0.0.1',
    port: Number(env.LWL_PORT || 8080),
    // База SQLite, загруженные сборки и аватары. Не внутри репозитория на проде: /var/lib/lwl
    dataDir: path.resolve(env.LWL_DATA_DIR || path.join(ROOT, 'data')),
    // Адрес сайта снаружи, например https://lwl.ru — из него собираются ссылки для сброса пароля
    publicUrl,
    // Почты или ники, которые всегда админы (владелец сайта). Их нельзя разжаловать из админки.
    admins: list(env.LWL_ADMINS),
    // За nginx: брать IP клиента из X-Real-IP (иначе все запросы будут «с 127.0.0.1»)
    trustProxy: env.LWL_TRUST_PROXY === '1',
    secureCookies: env.LWL_SECURE_COOKIES ? env.LWL_SECURE_COOKIES === '1' : publicUrl.startsWith('https://'),
    maxUploadBytes: Number(env.LWL_MAX_UPLOAD_MB || 2048) * 1024 * 1024,
    // RCON Minecraft-сервера: при одобрении заявки сайт сам выполняет /wl add <ник> [cracked].
    // Без пароля выключено — тогда команду вводят вручную (она показывается в одобренной заявке).
    rcon: {
      host: env.LWL_RCON_HOST || '127.0.0.1',
      port: Number(env.LWL_RCON_PORT || 25575),
      password: env.LWL_RCON_PASSWORD || '',
      timeoutMs: Number(env.LWL_RCON_TIMEOUT_MS || 5000),
    },
    // Токен игрового сервера для /api/game/… (мод LWL: config/lwl/connect.json → siteToken).
    // Пусто — эти маршруты отвечают 503, и сервер не может проверять коды входа.
    gameToken: String(env.LWL_GAME_TOKEN || '').trim(),
    staticRoot: ROOT,
    // Для тестов: ускорить хеширование паролей (никогда не включать на проде)
    fastHash: env.LWL_FAST_HASH === '1',
  };
}
