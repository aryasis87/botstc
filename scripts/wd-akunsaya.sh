#!/usr/bin/env bash
#
# wd-akunsaya.sh — withdrawal OVO Stockity pakai akun sendiri.
# Kredensial diambil dari akunsaya.har (token bisa expired → re-capture bila 401).
#
# Usage:
#   ./scripts/wd-akunsaya.sh <amount>            # eksekusi WD
#   DRY_RUN=1 ./scripts/wd-akunsaya.sh <amount>  # lihat body, tidak dikirim
#   STOCKITY_PROXY=http://user:pass@host:port ./scripts/wd-akunsaya.sh <amount>
#
set -uo pipefail

# ── Kredensial akun (dari akunsaya.har) ──────────────────────────────────────
export AUTH_TOKEN='b46cbb99-cb74-4d54-8395-d06a68420ccd'
export DEVICE_ID='dfc90deccc6c90c97c9678cc2529ac0b'
export DEVICE_TYPE='web'
export USER_TZ='Asia/Bangkok'
export USER_AGENT='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'

# country_id 100 = Indonesia (OVO). Override via env kalau perlu.
export COUNTRY_ID="${COUNTRY_ID:-100}"
export LOCALE="${LOCALE:-en}"

exec "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/withdraw-ovo.sh" "$@"
