#!/usr/bin/env node
/**
 * Запуск сайта: node --disable-warning=ExperimentalWarning server/index.js
 * (на машине — через systemd, см. deploy/lwl.service; настройки — переменные окружения, см. server/config.js).
 */
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = createApp(config);

app.server.listen(config.port, config.host, () => {
  console.log(`LWL: сайт на http://${config.host}:${config.port}, данные в ${config.dataDir}`);
  if (!config.admins.length) console.warn('LWL_ADMINS не задан: админов назначайте командой node server/cli.js role <ник> admin');
  if (!config.publicUrl) console.warn('LWL_PUBLIC_URL не задан: ссылки для сброса пароля будут собираться из адреса запроса');
});

let stopping = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    console.log(`${signal}: останавливаю сайт`);
    const force = setTimeout(() => process.exit(0), 10_000);
    force.unref();
    await app.close();
    process.exit(0);
  });
}
