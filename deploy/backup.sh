#!/bin/sh
# Ежедневный снимок сайта: база (аккаунты, заявки, переписка, настройки) и фото/файлы из чата поддержки.
# Запускается таймером lwl-backup.timer. Файлы сборок не копируются: они большие, их можно загрузить заново.
set -eu
DIR=/var/backups/lwl
KEEP_DAYS=14
mkdir -p "$DIR"
DAY="$(date +%F)"
FILE="$DIR/lwl-$DAY.db"
set -a; . /etc/lwl/lwl.env; set +a
/usr/bin/node --disable-warning=ExperimentalWarning /opt/lwl/server/cli.js backup "$FILE.tmp"
mv -f "$FILE.tmp" "$FILE"
chmod 600 "$FILE"
find "$DIR" -name 'lwl-*.db' -mtime +"$KEEP_DAYS" -delete
echo "Бэкап базы: $FILE"

# Фото и файлы из чата (LWL_DATA_DIR/attachments) — папка-снимок за тот же день, что и база.
# Файл вложения никогда не меняется (имя на диске — его id), поэтому всё, что было во вчерашнем снимке,
# берётся жёсткой ссылкой: место на диске тратится только на новые файлы.
SRC="${LWL_DATA_DIR:-/var/lib/lwl}/attachments"
if [ -d "$SRC" ]; then
  SNAP="$DIR/attachments-$DAY"
  PREV=""
  for d in "$DIR"/attachments-*; do
    case "$d" in *.tmp) continue ;; esac
    if [ -d "$d" ] && [ "$d" != "$SNAP" ]; then PREV="$d"; fi
  done
  rm -rf "$SNAP.tmp"
  mkdir -p "$SNAP.tmp"
  for f in "$SRC"/*; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    if [ -n "$PREV" ] && [ -f "$PREV/$name" ] && ln "$PREV/$name" "$SNAP.tmp/$name" 2>/dev/null; then
      :
    else
      cp -p "$f" "$SNAP.tmp/$name"
    fi
  done
  rm -rf "$SNAP"
  mv "$SNAP.tmp" "$SNAP"
  chmod 700 "$SNAP"
  find "$DIR" -maxdepth 1 -name 'attachments-*' -type d -mtime +"$KEEP_DAYS" -exec rm -rf {} +
  echo "Бэкап файлов из чата: $SNAP ($(ls "$SNAP" | wc -l) шт.)"
fi
