/**
 * withdraw-ovo.js — buat withdrawal OVO Stockity untuk satu akun, mengambil
 * token/device-id/user-agent dari tabel `sessions` di Supabase (tanpa password/PK).
 * Untuk akun milik sendiri (mis. akun tes).
 *
 * JavaScript murni: TIDAK butuh ts-node maupun `npm install`. Hanya modul Node
 * bawaan + binary `curl` (sama seperti src/common/http-utils.ts — agar lolos
 * Cloudflare JA3/JA4 fingerprint, bukan via axios/fetch Node).
 *
 * Cara pakai di VPS:
 *   node scripts/withdraw-ovo.js <email> <amount>
 * Contoh:
 *   node scripts/withdraw-ovo.js jaytrade40@gmail.com 250000
 *
 * Env opsional:
 *   DRY_RUN=1   → tampilkan body request saja, TIDAK mengirim.
 *   COUNTRY_ID  → default 100 (Indonesia).
 *   LOCALE      → default en.
 *   STOCKITY_PROXY → kirim request Stockity lewat proxy (mis. LOGIN_PROXY).
 */

'use strict';

const { execFile } = require('child_process');
const { readFileSync } = require('fs');
const { join } = require('path');

const BASE_URL = 'https://api.stockity.id';
const STATUS_MARKER = '__HTTP_STATUS__';

// ── .env loader sederhana ────────────────────────────────────────────────────
function loadEnv() {
  try {
    const raw = readFileSync(join(__dirname, '..', '.env'), 'utf-8');
    for (const line of raw.split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let val = m[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch (_) { /* .env opsional */ }
}

// ── curl helper (config + data sensitif via stdin, tidak muncul di `ps aux`) ──
function escConfig(v) {
  return String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function runCurl(opts) {
  const lines = [
    'silent',
    'show-error',
    `request = "${escConfig(opts.method)}"`,
    `url = "${escConfig(opts.url)}"`,
  ];
  if (opts.proxy) lines.push(`proxy = "${escConfig(opts.proxy)}"`);
  for (const [k, v] of Object.entries(opts.headers || {})) {
    lines.push(`header = "${escConfig(`${k}: ${v}`)}"`);
  }
  lines.push('header = "Content-Type: application/json"');
  if (opts.body !== undefined) {
    lines.push(`data-raw = "${escConfig(JSON.stringify(opts.body))}"`);
  }
  const timeoutSec = opts.timeoutSec || 15;
  lines.push(`max-time = ${timeoutSec}`);
  lines.push(`write-out = "${STATUS_MARKER}%{http_code}"`);
  const config = lines.join('\n') + '\n';

  return new Promise((resolve, reject) => {
    const cp = execFile(
      'curl',
      ['-K', '-'],
      { maxBuffer: 20 * 1024 * 1024, timeout: (timeoutSec + 5) * 1000 },
      (err, stdout, stderr) => {
        if (stdout) return resolve(stdout);
        if (err) {
          err.message = `curl gagal: ${err.message}` +
            (stderr ? ` | stderr: ${String(stderr).trim()}` : '');
          return reject(err);
        }
        resolve('');
      },
    );
    cp.stdin.end(config);
  });
}

function parseCurl(stdout) {
  const idx = stdout.lastIndexOf(STATUS_MARKER);
  const rawBody = (idx >= 0 ? stdout.slice(0, idx) : stdout).trim();
  const status = idx >= 0 ? parseInt(stdout.slice(idx + STATUS_MARKER.length).trim(), 10) : 0;
  if (!rawBody || !status) {
    const e = new Error('Request timeout / no response');
    e.code = 'ETIMEDOUT';
    throw e;
  }
  let data;
  try { data = JSON.parse(rawBody); }
  catch { throw new Error(`Non-JSON response (HTTP ${status}): ${rawBody.slice(0, 300)}`); }
  return { status, data };
}

const curlGet = (url, headers, timeoutSec, proxy) =>
  runCurl({ method: 'GET', url, headers, timeoutSec, proxy }).then(parseCurl);
const curlPost = (url, body, headers, timeoutSec, proxy) =>
  runCurl({ method: 'POST', url, body, headers, timeoutSec, proxy }).then(parseCurl);

// ── header Stockity (sama dengan ProfileService.buildHeaders) ────────────────
function buildHeaders(session) {
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

// ── ambil session dari Supabase via REST (PostgREST) ─────────────────────────
async function fetchSession(email) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY belum di-set di .env');
  const endpoint =
    `${url.replace(/\/$/, '')}/rest/v1/sessions?select=*&email=eq.${encodeURIComponent(email)}&limit=1`;
  const resp = await curlGet(endpoint, {
    apikey: key,
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
  }, 15);
  if (resp.status >= 400) {
    throw new Error(`Supabase REST error ${resp.status}: ${JSON.stringify(resp.data).slice(0, 200)}`);
  }
  const rows = Array.isArray(resp.data) ? resp.data : [];
  if (!rows.length) throw new Error(`Session untuk ${email} tidak ditemukan di DB`);
  return rows[0];
}

async function main() {
  loadEnv();

  const email = process.argv[2];
  const amount = process.argv[3];
  if (!email || !amount) {
    console.error('Usage: node scripts/withdraw-ovo.js <email> <amount>');
    process.exit(1);
  }

  const countryId = process.env.COUNTRY_ID || '100';
  const locale = process.env.LOCALE || 'en';
  const dryRun = process.env.DRY_RUN === '1';

  // 1. session (token dll) dari DB
  const session = await fetchSession(email);
  if (session.logged_out_at) {
    console.warn(`⚠️  Akun ${email} logged_out_at=${session.logged_out_at} — token mungkin mati.`);
  }
  console.log(`✓ Session ditemukan: ${email} (user_id=${session.user_id})`);

  // Proxy: utamakan override env, lalu proxy_url per-akun dari DB (Stockity
  // geo-filtered → request bisa perlu lewat proxy akun). Hanya untuk call
  // Stockity, bukan call Supabase. PK/password DI DB sengaja TIDAK dipakai.
  // NO_PROXY=1 atau STOCKITY_PROXY=direct → paksa direct (tanpa proxy).
  const stoxProxyEnv = (process.env.STOCKITY_PROXY || '').trim();
  const forceDirect = process.env.NO_PROXY === '1' || /^(none|direct)$/i.test(stoxProxyEnv);
  const proxy = forceDirect ? undefined : (stoxProxyEnv || session.proxy_url || '').trim() || undefined;
  console.log(`✓ Proxy Stockity: ${proxy || '(direct, tanpa proxy)'}`);

  const headers = buildHeaders(session);

  // 2. metode OVO (purse id + data form prefilled dari Stockity)
  const methodsResp = await curlGet(
    `${BASE_URL}/platform/private/payouts/methods?country_id=${countryId}&locale=${locale}`,
    headers, 15, proxy,
  );
  const methods = (methodsResp.data && methodsResp.data.data) || [];
  const ovo = methods.find((m) => m.payment_system === 'ovo');
  if (!ovo) {
    throw new Error(
      `Metode OVO tidak tersedia. Tersedia: ${methods.map((m) => m.payment_system).join(', ') || '(kosong / token invalid)'}`,
    );
  }

  const purseData = ovo.purse_data || {};
  const fields = {};
  for (const f of purseData.form_schema || []) {
    if (f.field && f.value !== undefined) fields[f.field] = f.value;
  }

  // 3. body withdrawal (identik struktur dengan request browser)
  const body = {
    amount: String(amount),
    city: fields.city,
    bank_account_number: fields.bank_account_number,
    last_name: fields.last_name,
    first_name: fields.first_name,
    purse: purseData.id,
    fingerprint: {
      color_depth: 32, language: 'en-US',
      screen_height: 693, screen_width: 1231,
      window_height: 605, window_width: 678,
      time_zone_offset: -420, java_enabled: false, javascript_enabled: true,
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

  // 4. kirim withdrawal
  const resp = await curlPost(`${BASE_URL}/platform/private/payouts?locale=${locale}`, body, headers, 20, proxy);
  console.log(`\n── Response (HTTP ${resp.status}) ──`);
  console.log(JSON.stringify(resp.data, null, 2));
  if (resp.data && resp.data.success) {
    const p = (resp.data.data && resp.data.data.payout) || {};
    console.log(`\n✅ Withdrawal dibuat: id=${p.id}, status=${resp.data.data.status}, sistem=${p.system}`);
  } else {
    console.log('\n❌ Gagal — cek errors di atas (token expired / saldo / limit Rp140rb–2jt).');
  }
}

main().catch((e) => { console.error('ERROR:', e.message || e); process.exit(1); });
