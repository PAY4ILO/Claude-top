#!/usr/bin/env bash
# Установка сайта LWL на Ubuntu 22.04/24.04 или Debian 12 — одной командой из папки с кодом:
#   sudo ./deploy/install.sh ваш-домен.ru ваша@почта.ru
# Что делает: ставит Node.js, nginx и certbot; кладёт код в /opt/lwl, данные — в /var/lib/lwl;
# создаёт службу lwl (автозапуск при загрузке и перезапуск при падении), ежедневный бэкап базы,
# настраивает nginx и HTTPS (Let's Encrypt). Повторный запуск безопасен — настройки не затирает.
set -euo pipefail

[ "$(id -u)" = 0 ] || { echo "Запустите через sudo: sudo $0 $*"; exit 1; }
SRC="$(cd "$(dirname "$0")/.." && pwd)"
DOMAIN="${1:-}"
ADMIN="${2:-}"
[ -n "$DOMAIN" ] || read -rp "Домен сайта (например, lwl.ru): " DOMAIN
[ -n "$ADMIN" ] || read -rp "Ваша почта (с ней зарегистрируйтесь на сайте — станете админом): " ADMIN
DOMAIN="${DOMAIN#http://}"; DOMAIN="${DOMAIN#https://}"; DOMAIN="${DOMAIN%%/*}"
[ -n "$DOMAIN" ] && [ -n "$ADMIN" ] || { echo "Нужны домен и почта."; exit 1; }

step() { printf '\n\033[1;36m==> %s\033[0m\n' "$1"; }
port_busy() { ss -Htln "( sport = :$1 )" 2>/dev/null | grep -q .; }

# Машина может быть общей (другие сайты, прокси, медиасервер): чужое не трогаем.
step "Проверка портов"
OTHER_WEB="$(ss -Htlnp '( sport = :80 or sport = :443 )' 2>/dev/null | grep -v '"nginx"' || true)"
if [ -n "$OTHER_WEB" ]; then
  echo "Порты 80/443 заняты другой программой (не nginx):"
  echo "$OTHER_WEB"
  echo "Они нужны nginx для сайта и HTTPS. Остановите эту программу или перенесите её на другой порт и запустите установку снова."
  exit 1
fi
# Порт, на котором сайт слушает локально (nginx ходит к нему). Уже установлен — берём из настроек,
# иначе 8080, а если он занят (часто им пользуются другие программы) — следующий свободный.
if [ -f /etc/lwl/lwl.env ]; then
  PORT="$(sed -n 's/^LWL_PORT=//p' /etc/lwl/lwl.env | tail -n 1)"
fi
if [ -z "${PORT:-}" ]; then
  PORT=8080
  while port_busy "$PORT"; do PORT=$((PORT + 1)); done
fi
echo "80/443 свободны или у nginx. Сайт будет слушать 127.0.0.1:$PORT."

step "Пакеты (nginx, certbot, rsync)"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nginx certbot python3-certbot-nginx rsync curl ca-certificates >/dev/null

step "Node.js (нужен 22.13 или новее)"
node_ok() {
  command -v node >/dev/null 2>&1 || return 1
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>22||(a===22&&b>=13)?0:1)'
}
if ! node_ok; then
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nodejs >/dev/null
fi
NODE_BIN="$(command -v node)"
echo "Node.js $("$NODE_BIN" --version) ($NODE_BIN)"

step "Пользователь lwl и папки"
id lwl >/dev/null 2>&1 || useradd --system --home-dir /var/lib/lwl --no-create-home --shell /usr/sbin/nologin lwl
install -d -o lwl -g lwl -m 750 /var/lib/lwl
install -d -o lwl -g lwl -m 700 /var/backups/lwl
install -d -o root -g lwl -m 750 /etc/lwl
install -d -m 755 /opt/lwl

step "Код сайта → /opt/lwl"
rsync -a --delete --exclude .git --exclude node_modules --exclude data --exclude design --exclude minecraft --exclude tests --exclude tools "$SRC"/ /opt/lwl/
chown -R root:root /opt/lwl   # служба код только читает
sed -i "s#/usr/bin/node#$NODE_BIN#" /opt/lwl/deploy/backup.sh

step "Настройки /etc/lwl/lwl.env"
if [ ! -f /etc/lwl/lwl.env ]; then
  sed -e "s#^LWL_PUBLIC_URL=.*#LWL_PUBLIC_URL=https://$DOMAIN#" -e "s#^LWL_ADMINS=.*#LWL_ADMINS=$ADMIN#" \
    -e "s#^LWL_PORT=.*#LWL_PORT=$PORT#" "$SRC/deploy/lwl.env.example" > /etc/lwl/lwl.env
  echo "Создан. Поменять потом: sudo nano /etc/lwl/lwl.env && sudo systemctl restart lwl"
else
  echo "Уже есть — оставляю как есть."
fi
chown root:lwl /etc/lwl/lwl.env
chmod 640 /etc/lwl/lwl.env

step "Служба lwl (автозапуск) и ежедневный бэкап"
sed "s#/usr/bin/node#$NODE_BIN#" "$SRC/deploy/lwl.service" > /etc/systemd/system/lwl.service
install -m 644 "$SRC/deploy/lwl-backup.service" "$SRC/deploy/lwl-backup.timer" /etc/systemd/system/
sed "s#/usr/bin/node#$NODE_BIN#" "$SRC/deploy/lwl-cli" > /usr/local/bin/lwl-cli
chmod 755 /usr/local/bin/lwl-cli
systemctl daemon-reload
systemctl enable --now lwl.service lwl-backup.timer
systemctl restart lwl.service
for _ in $(seq 1 20); do
  curl -fsS "http://127.0.0.1:$PORT/api/settings" >/dev/null 2>&1 && break
  sleep 0.5
done
if curl -fsS "http://127.0.0.1:$PORT/api/settings" >/dev/null 2>&1; then
  echo "Сайт запущен."
else
  echo "Сайт не отвечает. Логи: journalctl -u lwl -n 50"; exit 1
fi

step "nginx"
# Остальные сайты nginx (в том числе default) не трогаем: наш отвечает только на свой домен.
sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__PORT__/$PORT/g" "$SRC/deploy/nginx.conf.template" > /etc/nginx/sites-available/lwl
ln -sf /etc/nginx/sites-available/lwl /etc/nginx/sites-enabled/lwl
nginx -t
systemctl enable nginx >/dev/null 2>&1
systemctl reload nginx

if command -v ufw >/dev/null 2>&1 && ufw status | grep -q "Status: active"; then
  step "Файрвол: открываю 80 и 443"
  ufw allow 'Nginx Full' >/dev/null
fi

step "HTTPS (Let's Encrypt)"
if certbot --nginx -d "$DOMAIN" -d "www.$DOMAIN" --redirect --agree-tos -m "$ADMIN" --non-interactive --quiet; then
  echo "Сертификат для $DOMAIN и www.$DOMAIN получен, продлевается сам."
elif certbot --nginx -d "$DOMAIN" --redirect --agree-tos -m "$ADMIN" --non-interactive --quiet; then
  echo "Сертификат для $DOMAIN получен (www не настроен в DNS — это не страшно)."
else
  echo "Сертификат пока не получен: домен ещё не указывает на эту машину (DNS обновляется до нескольких часов)"
  echo "или закрыт порт 80. Когда DNS обновится, выполните:"
  echo "  sudo certbot --nginx -d $DOMAIN --redirect"
fi

cat <<DONE

Готово.
  Сайт:           https://$DOMAIN  (пока нет сертификата — http://$DOMAIN)
  Админ:          зарегистрируйтесь на сайте с почтой $ADMIN
  Статус и логи:  systemctl status lwl   |   journalctl -u lwl -f
  Команды:        sudo lwl-cli users   (role, reset-link, backup)
  Обновление:     git pull && sudo ./deploy/update.sh
  Бэкапы базы:    /var/backups/lwl (каждую ночь, хранятся 14 дней)
DONE
