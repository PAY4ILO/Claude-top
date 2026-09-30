#!/bin/sh
# Ежедневный снимок базы сайта (аккаунты, заявки, переписка, настройки). Запускается таймером lwl-backup.timer.
# Файлы сборок не копируются: они большие, их можно загрузить заново.
set -eu
DIR=/var/backups/lwl
KEEP_DAYS=14
mkdir -p "$DIR"
FILE="$DIR/lwl-$(date +%F).db"
set -a; . /etc/lwl/lwl.env; set +a
/usr/bin/node --disable-warning=ExperimentalWarning /opt/lwl/server/cli.js backup "$FILE.tmp"
mv -f "$FILE.tmp" "$FILE"
chmod 600 "$FILE"
find "$DIR" -name 'lwl-*.db' -mtime +"$KEEP_DAYS" -delete
echo "Бэкап: $FILE"
