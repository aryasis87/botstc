#!/usr/bin/env bash
#
# top-balances.sh — ranking saldo akun (live dari Stockity) dari tabel `sessions`.
#
# ⚠️ JALANKAN DI VPS botstc — butuh proxy lokal (mis. socks5h://127.0.0.1:1080
#    yang tersimpan di sessions.proxy_url) + IP yang lolos geo-filter Stockity.
#    Dari mesin lain hampir semua akun akan gagal (unauthorized / proxy tak ada).
#
# Butuh: bash, curl, jq. Baca SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY dari ../.env.
#
# Usage:
#   ./scripts/top-balances.sh [TOP_N] [PARALEL]
#   ./scripts/top-balances.sh 5 20      # default
#
set -uo pipefail
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/$(basename "${BASH_SOURCE[0]}")"
BASE="https://api.stockity1.id"

# ── Worker mode (dipanggil paralel via xargs) ────────────────────────────────
if [ "${1:-}" = "--worker" ]; then
  IFS=$'\t' read -r email token did ua tz proxy pk <<<"$2"
  px=(); { [ -n "$proxy" ] && [ "$proxy" != "null" ]; } && px=(-x "$proxy")
  resp=$(curl -sS --max-time 20 "${px[@]}" "$BASE/platform/private/v2/profile?locale=en" \
    -H "authorization-token: $token" -H "device-id: $did" -H "device-type: web" \
    -H "user-timezone: ${tz:-Asia/Jakarta}" -H "User-Agent: $ua" \
    -H "Origin: https://stockity1.id" -H "Referer: https://stockity1.id/" 2>/dev/null)
  bal=$(jq -r '.data.balance // empty'        <<<"$resp" 2>/dev/null)
  cur=$(jq -r '.data.currency // "?"'          <<<"$resp" 2>/dev/null)
  docs=$(jq -r '.data.docs_verified // "?"'    <<<"$resp" 2>/dev/null)
  haspk="no"; { [ -n "$pk" ] && [ "$pk" != "null" ]; } && haspk="yes"
  # balance Stockity = satuan minor (×100). Output: balance_minor \t email \t cur \t pk \t docs
  [ -n "$bal" ] && printf '%s\t%s\t%s\t%s\t%s\n' "$bal" "$email" "$cur" "$haspk" "$docs"
  exit 0
fi

# ── Main ─────────────────────────────────────────────────────────────────────
command -v jq   >/dev/null || { echo "jq belum terpasang (apt install jq)"; exit 1; }
command -v curl >/dev/null || { echo "curl belum terpasang"; exit 1; }
TOP="${1:-5}"; PAR="${2:-20}"

# load ../.env
ENV_FILE="$(dirname "$SELF")/../.env"
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*([A-Z0-9_]+)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue
    k="${BASH_REMATCH[1]}"; v="${BASH_REMATCH[2]}"; v="${v%\"}"; v="${v#\"}"
    [ -z "${!k:-}" ] && export "$k=$v"
  done < "$ENV_FILE"
fi
: "${SUPABASE_URL:?belum di-set}"; : "${SUPABASE_SERVICE_ROLE_KEY:?belum di-set}"

tmp="$(mktemp)"; res="$(mktemp)"; trap 'rm -f "$tmp" "$res"' EXIT
echo "→ Ambil sessions dari Supabase…"
curl -sS "${SUPABASE_URL%/}/rest/v1/sessions?select=email,stockity_token,device_id,user_agent,user_timezone,proxy_url,PK&stockity_token=not.is.null" \
  -H "apikey: $SUPABASE_SERVICE_ROLE_KEY" -H "Authorization: Bearer $SUPABASE_SERVICE_ROLE_KEY" > "$tmp"
total=$(jq 'length' "$tmp")
echo "→ Query saldo live $total akun (paralel $PAR)… (akun token mati akan terlewat)"

jq -r '.[] | [.email,.stockity_token,.device_id,.user_agent,.user_timezone,.proxy_url,.PK] | @tsv' "$tmp" \
  | xargs -d '\n' -P "$PAR" -I{} bash "$SELF" --worker "{}" > "$res"

ok=$(wc -l < "$res")
echo ""
echo "Token hidup: $ok / $total"
echo "==== TOP $TOP SALDO ===="
printf "%-3s %16s  %-34s %-6s %s\n" "#" "Saldo" "Email" "PK?" "docs/cur"
sort -t$'\t' -k1,1 -rn "$res" | head -"$TOP" | awk -F'\t' '{
  idr = $1/100;
  printf "%-3d %13.0f Rp  %-34s %-6s %s/%s\n", NR, idr, $2, $4, $5, $3
}'
