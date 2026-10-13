/**
 * Скин лицензии по нику — как `/skin set <ник>` в моде lwl-skins: ник → UUID (api.mojang.com, при 403/5xx —
 * api.minecraftservices.com) → профиль (sessionserver.mojang.com) → ссылка на текстуру.
 * Саму картинку качает lib/skins.js и только с textures.minecraft.net.
 *
 * Защита от SSRF: адреса фиксированные (config.mojang, тесты подменяют их на локальный сервер), в путь попадают
 * только проверенный ник (латиница, цифры, _) и UUID из 32 hex; без редиректов, тайм-аут, ответ не больше 32 КБ.
 * Ответы кешируются на 10 минут: Mojang разрешает около 600 запросов за 10 минут с одного IP.
 */
const NICK = /^[A-Za-z0-9_]{3,16}$/;
const UUID = /^[0-9a-f]{32}$/;
const MAX_BYTES = 32 * 1024;
const CACHE_MS = 10 * 60 * 1000;
const MAX_CACHE = 1000;

export class MojangError extends Error {}

export function createMojang({ api, servicesApi, session, timeoutMs = 8000 }) {
  const cache = new Map(); // ник в нижнем регистре → { at, value }

  async function get(url) {
    let res;
    try {
      res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(timeoutMs), headers: { 'User-Agent': 'LWL-site (skins for player cards)', Accept: 'application/json' } });
    } catch {
      throw new MojangError('Mojang не отвечает. Попробуйте через минуту.');
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of res.body || []) {
      size += chunk.length;
      if (size > MAX_BYTES) throw new MojangError('Mojang прислал странный ответ. Попробуйте позже.');
      chunks.push(chunk);
    }
    const text = Buffer.concat(chunks).toString('utf8');
    let json = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }
    return { status: res.status, json };
  }

  function check(res) {
    if (res.status === 429) throw new MojangError('Mojang просит подождать: слишком много запросов. Попробуйте через минуту.');
    if (res.status !== 200 && res.status !== 204 && res.status !== 404) throw new MojangError(`Mojang не отвечает (код ${res.status}). Попробуйте позже.`);
    return res;
  }

  /** Ник → { name, id } или null, если лицензии с таким ником нет. */
  async function profileOf(nick) {
    const name = nick.toLowerCase();
    let res = await get(`${api}/users/profiles/minecraft/${name}`);
    // Старый адрес иногда отвечает 403/5xx — тогда спрашиваем новый (как мод lwl-skins).
    if (res.status === 403 || res.status >= 500) res = await get(`${servicesApi}/minecraft/profile/lookup/name/${name}`);
    check(res);
    if (res.status !== 200) return null;
    const id = String(res.json?.id || '').replace(/-/g, '').toLowerCase();
    if (!UUID.test(id) || typeof res.json?.name !== 'string' || !NICK.test(res.json.name)) throw new MojangError('Mojang прислал странный ответ. Попробуйте позже.');
    return { name: res.json.name, id };
  }

  /** UUID → { url, slim } (url = null — у лицензии стандартный скин). */
  async function texturesOf(id) {
    const res = check(await get(`${session}/session/minecraft/profile/${id}`));
    if (res.status !== 200) return { url: null, slim: false };
    const prop = (Array.isArray(res.json?.properties) ? res.json.properties : []).find((p) => p && p.name === 'textures');
    if (!prop || typeof prop.value !== 'string') return { url: null, slim: false };
    let textures;
    try {
      textures = JSON.parse(Buffer.from(prop.value, 'base64').toString('utf8'));
    } catch {
      throw new MojangError('Mojang прислал странный ответ. Попробуйте позже.');
    }
    const skin = textures?.textures?.SKIN;
    if (!skin || typeof skin.url !== 'string') return { url: null, slim: false };
    return { url: skin.url, slim: skin.metadata?.model === 'slim' };
  }

  return {
    /**
     * Скин лицензии с этим ником: { name (как у Mojang), url | null, slim } или null — такой лицензии нет.
     * Ошибки связи — MojangError с текстом для игрока.
     */
    async skinOf(nick) {
      if (typeof nick !== 'string' || !NICK.test(nick)) throw new MojangError('Ник — латиница, цифры и _, от 3 до 16 символов.');
      const key = nick.toLowerCase();
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < CACHE_MS) return hit.value;
      const profile = await profileOf(nick);
      const value = profile ? { name: profile.name, ...(await texturesOf(profile.id)) } : null;
      if (cache.size >= MAX_CACHE) cache.clear();
      cache.set(key, { at: Date.now(), value });
      return value;
    },
  };
}
