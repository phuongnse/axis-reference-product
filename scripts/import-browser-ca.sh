#!/bin/sh
set -eu

database="$1"
certificate="$2"

mkdir -p "$database"
if [ ! -f "$database/cert9.db" ]; then
  certutil -d "sql:$database" -N --empty-password
fi
certutil -d "sql:$database" -D -n axis-local-root >/dev/null 2>&1 || true
certutil -d "sql:$database" -A -t 'C,,' -n axis-local-root -i "$certificate"
