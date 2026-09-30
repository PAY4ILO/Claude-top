#!/usr/bin/env bash
# Обновление сайта: из папки с кодом после git pull —  sudo ./deploy/update.sh
# Перед обновлением делается бэкап базы; миграции базы применяются сами при запуске.
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Запустите через sudo: sudo $0"; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"
NODE_BIN="$(command -v node)"
PORT="$(sed -n 's/^LWL_PORT=//p' /etc/lwl/lwl.env 2>/dev/null | tail -n 1)"
PORT="${PORT:-8080}"

echo "==> Бэкап базы перед обновлением"
systemctl start lwl-backup.service || echo "(бэкап не удался — продолжаю)"

echo "==> Код → /opt/lwl"
rsync -a --delete --exclude .git --exclude node_modules --exclude data --exclude design --exclude minecraft --exclude tests --exclude tools "$SRC"/ /opt/lwl/
chown -R root:root /opt/lwl
sed -i "s#/usr/bin/node#$NODE_BIN#" /opt/lwl/deploy/backup.sh
sed "s#/usr/bin/node#$NODE_BIN#" "$SRC/deploy/lwl.service" > /etc/systemd/system/lwl.service
install -m 644 "$SRC/deploy/lwl-backup.service" "$SRC/deploy/lwl-backup.timer" /etc/systemd/system/
sed "s#/usr/bin/node#$NODE_BIN#" "$SRC/deploy/lwl-cli" > /usr/local/bin/lwl-cli
chmod 755 /usr/local/bin/lwl-cli
systemctl daemon-reload

echo "==> Перезапуск"
systemctl restart lwl
for _ in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:$PORT/api/settings" >/dev/null 2>&1 && { echo "Сайт обновлён и работает."; exit 0; }
  sleep 0.5
done
echo "Сайт не отвечает после обновления. Логи: journalctl -u lwl -n 50"
exit 1
