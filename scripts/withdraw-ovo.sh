#!/usr/bin/env bash
#
# withdraw-ovo.sh — buat permintaan withdrawal OVO Stockity via curl (tanpa Node).
# Setara dengan scripts/withdraw-ovo.ts. Butuh: bash, curl, jq.
#
# Dua mode kredensial:
#   A) Ambil token dari Supabase berdasarkan email (seperti versi TS):
#        ./withdraw-ovo.sh <email> <amount>
#      Perlu SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (dibaca dari ../.env).
#   B) Token manual via env (tanpa DB):
#        AUTH_TOKEN=... DEVICE_ID=... USER_AGENT='...' ./withdraw-ovo.sh <amount>
#
# Env opsional:
#   DRY_RUN=1        → cuma tampilkan body, TIDAK dikirim ke Stockity.
#   COUNTRY_ID       → default 100 (Indonesia).
#   LOCALE           → default en.
#   STOCKITY_PROXY   → proxy curl (mis. http://user:pass@host:port).
#
set -uo pipefail

BASE_URL="https://api.stockity1.id"
COUNTRY_ID="${COUNTRY_ID:-100}"
LOCALE="${LOCALE:-en}"

die() { echo "ERROR: $*" >&2; exit 1; }
command -v jq   >/dev/null || die "jq belum terpasang (apt install jq)."
command -v curl >/dev/null || die "curl belum terpasang."

# ── Loader .env sederhana dari folder repo (../.env relatif ke script) ───────
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="$SCRIPT_DIR/../.env"
if [ -f "$ENV_FILE" ]; then
  while IFS= read -r line; do
    [[ "$line" =~ ^[[:space:]]*([A-Z0-9_]+)[[:space:]]*=[[:space:]]*(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"; val="${BASH_REMATCH[2]}"
    val="${val%\"}"; val="${val#\"}"; val="${val%\'}"; val="${val#\'}"
    [ -z "${!key:-}" ] && export "$key=$val"
  done < "$ENV_FILE"
fi

# ── Argumen: <email> <amount>  ATAU  <amount> ────────────────────────────────
EMAIL="${EMAIL:-}"
if   [ "$#" -eq 2 ]; then EMAIL="$1"; AMOUNT="$2"
elif [ "$#" -eq 1 ]; then AMOUNT="$1"
else die "Usage: ./withdraw-ovo.sh <email> <amount>   (atau AUTH_TOKEN=... ./withdraw-ovo.sh <amount>)"
fi
[[ "$AMOUNT" =~ ^[0-9]+$ ]] || die "amount harus angka rupiah, mis. 200000 (= Rp200.000)."
AMOUNT_MINOR=$((AMOUNT * 100))   # Stockity pakai satuan minor (×100)

# ── Data penerima OVO (form_schema OVO tidak prefilled → wajib diisi) ─────────
WD_FIRST_NAME="${WD_FIRST_NAME:-}"
WD_LAST_NAME="${WD_LAST_NAME:-}"
WD_OVO_NUMBER="${WD_OVO_NUMBER:-}"   # nomor OVO, format +62XXXXXXXXXX
WD_CITY="${WD_CITY:-}"
for v in WD_FIRST_NAME WD_LAST_NAME WD_OVO_NUMBER WD_CITY; do
  [ -n "${!v}" ] || die "$v belum di-set (data penerima OVO wajib diisi)."
done

# ── Kredensial: dari env langsung, atau fetch dari Supabase by email ─────────
AUTH_TOKEN="${AUTH_TOKEN:-}"
DEVICE_ID="${DEVICE_ID:-}"
USER_AGENT="${USER_AGENT:-}"
DEVICE_TYPE="${DEVICE_TYPE:-web}"
USER_TZ="${USER_TZ:-Asia/Jakarta}"
PROXY="${STOCKITY_PROXY:-}"

if [ -z "$AUTH_TOKEN" ]; then
  [ -n "$EMAIL" ] || die "Tanpa AUTH_TOKEN, wajib kasih <email> untuk ambil session dari DB."
  [ -n "${SUPABASE_URL:-}" ] && [ -n "${SUPABASE_SERVICE_ROLE_KEY:-}" ] \
    || die "SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum di-set (.env)."

  email_enc="$(jq -rn --arg e "$EMAIL" '$e|@uri')"
  sess="$(curl -sS "${SUPABASE_URL%/}/rest/v1/sessions?select=*&email=eq.${email_enc}&limit=1" \
            -H "apikey: ${SUPABASE_SERVICE_ROLE_KEY}" \
            -H "Authorization: Bearer ${SUPABASE_SERVICE_ROLE_KEY}" \
            -H "Accept: application/json")" || die "gagal konek Supabase."
  [ "$(jq 'length' <<<"$sess" 2>/dev/null || echo 0)" -ge 1 ] || die "Session untuk $EMAIL tidak ada di DB."

  AUTH_TOKEN="$(jq -r '.[0].stockity_token // empty' <<<"$sess")"
  DEVICE_ID="$(jq -r '.[0].device_id // empty'       <<<"$sess")"
  USER_AGENT="$(jq -r '.[0].user_agent // empty'     <<<"$sess")"
  DEVICE_TYPE="$(jq -r '.[0].device_type // "web"'   <<<"$sess")"
  USER_TZ="$(jq -r '.[0].user_timezone // "Asia/Jakarta"' <<<"$sess")"
  [ -z "$PROXY" ] && PROXY="$(jq -r '.[0].proxy_url // empty' <<<"$sess")"
  logged_out="$(jq -r '.[0].logged_out_at // empty' <<<"$sess")"
  [ -n "$logged_out" ] && echo "⚠️  $EMAIL logged_out_at=$logged_out — token mungkin mati." >&2
  echo "✓ Session: $EMAIL (user_id=$(jq -r '.[0].user_id // "?"' <<<"$sess"))"
fi
[ -n "$AUTH_TOKEN" ] || die "authorization-token kosong."
echo "✓ Proxy: ${PROXY:-(direct)}"

# ── Wrapper curl dgn header standar Stockity ─────────────────────────────────
PROXY_ARGS=(); [ -n "$PROXY" ] && PROXY_ARGS=(-x "$PROXY")
req() { # req <METHOD> <URL> [json-body]
  local method="$1" url="$2" data="${3:-}"
  local args=(-sS -X "$method" "$url"
    -H "authorization-token: $AUTH_TOKEN"
    -H "device-id: $DEVICE_ID"
    -H "device-type: $DEVICE_TYPE"
    -H "user-timezone: $USER_TZ"
    -H "User-Agent: $USER_AGENT"
    -H "Accept: application/json, text/plain, */*"
    -H "Origin: https://stockity1.id"
    -H "Referer: https://stockity1.id/")
  [ -n "$data" ] && args+=(-H "Content-Type: application/json" --data "$data")
  curl "${PROXY_ARGS[@]}" "${args[@]}"
}

# ── 1. Ambil metode payout OVO (purse id + limit) ────────────────────────────
methods="$(req GET "$BASE_URL/platform/private/payouts/methods?country_id=$COUNTRY_ID&locale=$LOCALE")"
jq -e . >/dev/null 2>&1 <<<"$methods" || die "respons methods bukan JSON (token expired?): $(head -c 200 <<<"$methods")"
ovo="$(jq -c '.data[]?|select(.payment_system=="ovo")' <<<"$methods")"
[ -n "$ovo" ] || die "Metode OVO tdk tersedia. Yg ada: $(jq -r '[.data[]?.payment_system]|join(", ")' <<<"$methods")"

# Validasi nominal pakai limit dari Stockity (satuan minor).
MIN_MINOR="$(jq -r '.min_amount' <<<"$ovo")"
MAX_MINOR="$(jq -r '.max_amount' <<<"$ovo")"
if [ "$AMOUNT_MINOR" -lt "$MIN_MINOR" ] || [ "$AMOUNT_MINOR" -gt "$MAX_MINOR" ]; then
  die "Nominal Rp$AMOUNT di luar limit (Rp$((MIN_MINOR/100)) – Rp$((MAX_MINOR/100)))."
fi

# ── 2. Susun body withdrawal (struktur identik request browser) ──────────────
body="$(jq -n --argjson ovo "$ovo" \
  --arg amount "$AMOUNT" \
  --arg first_name "$WD_FIRST_NAME" --arg last_name "$WD_LAST_NAME" \
  --arg ovo_number "$WD_OVO_NUMBER" --arg city "$WD_CITY" '
  { amount: $amount,
    city: $city,
    bank_account_number: $ovo_number,
    last_name: $last_name,
    first_name: $first_name,
    purse: $ovo.purse_data.id,
    fingerprint: { color_depth:32, language:"en-US",
      screen_height:693, screen_width:1231,
      window_height:605, window_width:678,
      time_zone_offset:-420, java_enabled:false, javascript_enabled:true },
    comments_payout: "profits",
    comments_text: "" }')"

echo "── Request body (amount = Rp$AMOUNT) ──"; jq . <<<"$body"

if [ "${DRY_RUN:-}" = "1" ]; then
  echo "DRY_RUN=1 → tidak dikirim. Hapus DRY_RUN untuk eksekusi."; exit 0
fi

# ── 3. Kirim withdrawal ──────────────────────────────────────────────────────
resp="$(req POST "$BASE_URL/platform/private/payouts?locale=$LOCALE" "$body")"
echo "── Response ──"; jq . <<<"$resp" 2>/dev/null || echo "$resp"

if [ "$(jq -r '.success // false' <<<"$resp" 2>/dev/null)" = "true" ]; then
  echo "✅ Withdrawal dibuat: id=$(jq -r '.data.payout.id // "?"' <<<"$resp"), status=$(jq -r '.data.status // "?"' <<<"$resp")"
else
  echo "❌ Gagal — cek errors di atas (token expired / saldo / limit Rp140rb–2jt)."
  exit 1
fi
