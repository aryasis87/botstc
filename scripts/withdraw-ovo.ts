/**
 * withdraw-ovo.ts — buat permintaan withdrawal OVO Stockity untuk satu akun,
 * mengambil token/device-id/user-agent langsung dari tabel `sessions` di Supabase
 * (tanpa password / private key). Untuk akun milik sendiri (mis. akun tes).
 *
 * Versi tanpa dependency: tidak butuh `npm install`. Supabase diakses via REST
 * memakai util curl yang sudah ada (hanya pakai modul `child_process` bawaan).
 *
 * Cara pakai (pakai --transpile-only agar tidak perlu @types/node):
 *   npx ts-node --transpile-only scripts/withdraw-ovo.ts <email> <amount>
 * Contoh:
 *   npx ts-node --transpile-only scripts/withdraw-ovo.ts jaytrade40@gmail.com 250000
 *
 * Env opsional:
 *   DRY_RUN=1   → hanya tampilkan body request, TIDAK mengirim ke Stockity.
 *   COUNTRY_ID  → default 100 (Indonesia).
 *   LOCALE      → default en.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { curlGet, curlPost } from '../src/common/http-utils';

const BASE_URL = 'https://api.stockity.id';

/** Loader .env sederhana (hindari dependency tambahan). */
function loadEnv(): void {
  try {
    const raw = readFileSync(join(__dirname, '..', '.env'), 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      const key = m[1];
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch {
    /* .env opsional kalau env sudah di-export */
  }
}

function buildHeaders(session: any): Record<string, string> {
  return {
    'device-id': session.device_id,
    'device-type': session.device_type || 'web',
    'user-timezone': session.user_timezone || 'Asia/Jakarta',
    'authorization-token': session.stockity_token,
    'User-Agent': session.user_agent,
    Accept: 'application/json, text/plain, */*',
    Origin: 'https://stockity.id',
    Referer: 'https://stockity.id/',
  };
}

/** Ambil 1 baris session dari Supabase via REST (PostgREST), pakai service role key. */
async function fetchSession(email: string): Promise<any> {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum di-set di .env');

  const endpoint =
    `${url.replace(/\/$/, '')}/rest/v1/sessions` +
    `?select=*&email=eq.${encodeURIComponent(email)}&limit=1`;

  const resp = await curlGet(endpoint, {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
  }, 15);

  if (resp.status >= 400) {
    throw new Error(`Supabase REST error ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}`);
  }
  const rows: any[] = Array.isArray(resp.data) ? resp.data : [];
  if (rows.length === 0) throw new Error(`Session untuk ${email} tidak ditemukan di DB`);
  return rows[0];
}

async function main(): Promise<void> {
  loadEnv();

  const email = process.argv[2];
  const amount = process.argv[3];
  if (!email || !amount) {
    console.error('Usage: npx ts-node --transpile-only scripts/withdraw-ovo.ts <email> <amount>');
    process.exit(1);
  }

  const countryId = process.env.COUNTRY_ID || '100';
  const locale = process.env.LOCALE || 'en';
  const dryRun = process.env.DRY_RUN === '1';

  // ── 1. Ambil session (token dll) dari DB berdasarkan email ────────────────
  const session = await fetchSession(email);
  if (session.logged_out_at) {
    console.warn(`⚠️  Akun ${email} tercatat logged_out_at=${session.logged_out_at} — token mungkin mati.`);
  }
  console.log(`✓ Session ditemukan: ${email} (user_id=${session.user_id})`);

  // Proxy per-akun dari DB (Stockity geo-filtered). PK/password TIDAK dipakai.
  const proxy = (process.env.STOCKITY_PROXY || session.proxy_url || '').trim() || undefined;
  console.log(`✓ Proxy Stockity: ${proxy || '(direct, tanpa proxy)'}`);

  const headers = buildHeaders(session);

  // ── 2. Ambil metode payout OVO (purse id + data form prefilled dari Stockity) ─
  const methodsResp = await curlGet(
    `${BASE_URL}/platform/private/payouts/methods?country_id=${countryId}&locale=${locale}`,
    headers,
    15,
    proxy,
  );
  const methods: any[] = methodsResp.data?.data || [];
  const ovo = methods.find((m) => m.payment_system === 'ovo');
  if (!ovo) {
    throw new Error(
      `Metode OVO tidak tersedia. Tersedia: ${methods.map((m) => m.payment_system).join(', ') || '(kosong / token invalid)'}`,
    );
  }

  const purseData = ovo.purse_data || {};
  // Field first_name/last_name/bank_account_number/city sudah prefilled & readonly
  // dari sisi Stockity (data rekening OVO milik akun) → tinggal pakai apa adanya.
  const fields: Record<string, any> = {};
  for (const f of purseData.form_schema || []) {
    if (f.field && f.value !== undefined) fields[f.field] = f.value;
  }

  // ── 3. Susun body withdrawal (identik struktur dengan request browser) ────
  const body = {
    amount: String(amount),
    city: fields.city,
    bank_account_number: fields.bank_account_number,
    last_name: fields.last_name,
    first_name: fields.first_name,
    purse: purseData.id,
    fingerprint: {
      color_depth: 32,
      language: 'en-US',
      screen_height: 693,
      screen_width: 1231,
      window_height: 605,
      window_width: 678,
      time_zone_offset: -420,
      java_enabled: false,
      javascript_enabled: true,
    },
    comments_payout: 'profits',
    comments_text: '',
  };

  console.log('\n── Request body ──');
  console.log(JSON.stringify(body, null, 2));

  if (dryRun) {
    console.log('\nDRY_RUN=1 → tidak dikirim. Hapus DRY_RUN untuk eksekusi.');
    return;
  }

  // ── 4. Kirim withdrawal ───────────────────────────────────────────────────
  const resp = await curlPost(`${BASE_URL}/platform/private/payouts?locale=${locale}`, body, headers, 20, proxy);
  console.log(`\n── Response (HTTP ${resp.status}) ──`);
  console.log(JSON.stringify(resp.data, null, 2));

  if (resp.data?.success) {
    const p = resp.data.data?.payout;
    console.log(`\n✅ Withdrawal dibuat: id=${p?.id}, status=${resp.data.data?.status}, sistem=${p?.system}`);
  } else {
    console.log('\n❌ Gagal — cek errors di atas (token expired / saldo / limit Rp140rb–2jt).');
  }
}

main().catch((e) => {
  console.error('ERROR:', e.message || e);
  process.exit(1);
});
