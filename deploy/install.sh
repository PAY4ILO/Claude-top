#!/usr/bin/env bash
# Установка сайта LWL на Ubuntu 22.04/24.04 или Debian 12 — одной командой из папки с кодом:
#   sudo ./deploy/install.sh ваш-домен.ru ваша@почта.ru
# Что делает: ставит Node.js; кладёт код в /opt/lwl, данные — в /var/lib/lwl; создаёт службу lwl
# (автозапуск при загрузке и перезапуск при падении) и ежедневный бэкап базы. Веб-сервер с HTTPS:
# nginx + certbot (Let's Encrypt), а если порты 80/443 уже занимает Caddy — сайт подключается к нему.
# Повторный запуск безопасен — настройки не затирает.
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
# Веб-сервер перед сайтом: nginx (ставим сами) или уже работающий Caddy — тогда подключаемся к нему.
step "Проверка портов"
WEB_LISTEN="$(ss -Htlnp '( sport = :80 or sport = :443 )' 2>/dev/null || true)"
CADDY_PID="$(grep -o '"caddy",pid=[0-9]*' <<<"$WEB_LISTEN" | head -n 1 | grep -o '[0-9]*$' || true)"
if [ -n "$CADDY_PID" ]; then
  WEB=caddy
  # Если Caddy слушает конкретный IP (bind), наш сайт должен слушать тот же, иначе Caddy не примет настройку.
  CADDY_BIND="$(awk '/"caddy"/ { a = $4; sub(/:[0-9]+$/, "", a); gsub(/[][]/, "", a); print a }' <<<"$WEB_LISTEN" | sort -u | paste -sd ' ' -)"
  case " $CADDY_BIND " in *" * "* | *" 0.0.0.0 "* | *" :: "*) CADDY_BIND="" ;; esac
  echo "80/443 занимает Caddy — сайт подключу к нему${CADDY_BIND:+ (адрес $CADDY_BIND)}, сертификат он получит сам."
else
  WEB=nginx
  OTHER_WEB="$(grep -v '"nginx"' <<<"$WEB_LISTEN" || true)"
  if [ -n "$OTHER_WEB" ]; then
    echo "Порты 80/443 заняты другой программой (не nginx и не Caddy):"
    echo "$OTHER_WEB"
    echo "Они нужны для сайта и HTTPS. Остановите эту программу или перенесите её на другой порт и запустите установку снова."
    exit 1
  fi
  echo "80/443 свободны или у nginx."
fi
# Порт, на котором сайт слушает локально (веб-сервер ходит к нему). Уже установлен — берём из настроек,
# иначе 8080, а если он занят (часто им пользуются другие программы) — следующий свободный.
if [ -f /etc/lwl/lwl.env ]; then
  PORT="$(sed -n 's/^LWL_PORT=//p' /etc/lwl/lwl.env | tail -n 1)"
fi
if [ -z "${PORT:-}" ]; then
  PORT=8080
  while port_busy "$PORT"; do PORT=$((PORT + 1)); done
fi
echo "Сайт будет слушать 127.0.0.1:$PORT."

PKGS=(rsync curl ca-certificates)
[ "$WEB" = nginx ] && PKGS+=(nginx certbot python3-certbot-nginx)
step "Пакеты (${PKGS[*]})"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "${PKGS[@]}" >/dev/null

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

if [ "$WEB" = caddy ]; then
  step "Caddy: подключаю сайт $DOMAIN"
  SITE="# Сайт LWL (сделал deploy/install.sh из deploy/Caddyfile.template)
$(sed -e '/^#/d' -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__PORT__/$PORT/g" "$SRC/deploy/Caddyfile.template")"
  if [ -n "$CADDY_BIND" ]; then SITE="${SITE//__BIND__/$CADDY_BIND}"; else SITE="$(grep -v '__BIND__' <<<"$SITE")"; fi
  CONF=/etc/caddy/Caddyfile
  SNIPPET=/etc/caddy/lwl.caddy
  # Сами правим только обычную установку Caddy: служба caddy с /etc/caddy/Caddyfile. Перезагружаем через
  # systemctl — с окружением службы (в Caddyfile бывают {$ТОКЕН}); при ошибке Caddy остаётся на старых настройках.
  if [ "$(systemctl show -p MainPID --value caddy 2>/dev/null || true)" = "$CADDY_PID" ] && [ -f "$CONF" ] \
    && tr '\0' ' ' <"/proc/$CADDY_PID/cmdline" | grep -qF -- "$CONF"; then
    STAMP="$(date +%Y%m%d-%H%M%S)"
    [ -f "$SNIPPET" ] && cp -p "$SNIPPET" "$SNIPPET.bak-$STAMP"
    printf '%s\n' "$SITE" >"$SNIPPET"
    chmod 644 "$SNIPPET"
    ADDED_IMPORT=""
    if ! grep -qx "import $SNIPPET" "$CONF"; then
      cp -p "$CONF" "$CONF.bak-$STAMP"
      printf '\n# Сайт LWL (добавил deploy/install.sh; отключить — удалить эту строку и sudo systemctl reload caddy)\nimport %s\n' "$SNIPPET" >>"$CONF"
      ADDED_IMPORT=1
    fi
    if systemctl reload caddy; then
      CADDY_OK=1
      rm -f "$SNIPPET.bak-$STAMP"
      echo "Сайт подключён к Caddy ($SNIPPET). Остальные сайты Caddy не тронуты."
    else
      # Возвращаем и файлы — иначе Caddy не запустился бы после перезагрузки машины.
      [ -n "$ADDED_IMPORT" ] && mv "$CONF.bak-$STAMP" "$CONF"
      if [ -f "$SNIPPET.bak-$STAMP" ]; then mv "$SNIPPET.bak-$STAMP" "$SNIPPET"; else rm -f "$SNIPPET"; fi
      echo "Caddy не принял настройку — всё вернул как было, ваши сайты работают. Причина: journalctl -u caddy -n 30"
    fi
  fi
  if [ -z "${CADDY_OK:-}" ]; then
    printf '%s\n' "$SITE" >/etc/lwl/lwl.caddy
    echo "Подключите сайт к Caddy вручную: добавьте этот блок (он же в /etc/lwl/lwl.caddy) в свой Caddyfile и перезагрузите Caddy."
    echo
    cat /etc/lwl/lwl.caddy
  fi
  SITE_NOTE="https://$DOMAIN  (сертификат Caddy получит сам, когда домен заработает)"
else
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
  SITE_NOTE="https://$DOMAIN  (пока нет сертификата — http://$DOMAIN)"
fi

cat <<DONE

Готово.
  Сайт:           $SITE_NOTE
  Админ:          зарегистрируйтесь на сайте с почтой $ADMIN
  Статус и логи:  systemctl status lwl   |   journalctl -u lwl -f
  Команды:        sudo lwl-cli users   (role, reset-link, backup)
  Обновление:     git pull && sudo ./deploy/update.sh
  Бэкапы базы:    /var/backups/lwl (каждую ночь, хранятся 14 дней)
DONE
