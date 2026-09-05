import { createCipheriv, randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';
import { curlPost } from './http-utils';

// ─────────────────────────────────────────────────────────────────────────────
// Cadangkan KODE PEMULIHAN 2FA user ke app_config saat login 2FA berhasil.
//
// Stockity tak menyediakan cara BACA kode pemulihan (GET /2fa hanya kembalikan
// jumlah sisa). Satu-satunya cara memperoleh string kodenya = REGENERASI lewat
// POST /passport/v1/2fa/backup_refresh (auth = authorization-token sesi yg baru
// saja lolos 2FA). Karena itu kode DIREGENERASI tiap login 2FA (kode lama hangus)
// — sesuai keputusan pemilik: admin selalu punya set valid terbaru.
//
// Disimpan TERENKRIPSI (AES-256-GCM, kunci TWOFA_ENC_KEY — SAMA dgn webadmin)
// karena app_config bisa terbaca anon. Format base64(iv|tag|ciphertext) identik
// crypto2fa.ts webadmin → webadmin bisa mendekripsi utk ditampilkan.
//
// app_config key 'twofa_recovery_codes' = { "<email>": "<enc>" }
//   enc = encrypt(JSON.stringify({ codes:[...], at:<epoch ms> }))
// ─────────────────────────────────────────────────────────────────────────────

const BASE_URL = 'https://api.stockity1.id';
const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
const RECOVERY_KEY = 'twofa_recovery_codes';
const logger = new Logger('TwofaRecovery');

function encKey(): Buffer | null {
  const k = (process.env.TWOFA_ENC_KEY ?? '').trim();
  if (!/^[0-9a-fA-F]{64}$/.test(k)) return null;
  return Buffer.from(k, 'hex');
}

/** AES-256-GCM → base64(iv|tag|ciphertext). null bila kunci tak ada. */
function encrypt(plain: string): string | null {
  const k = encKey();
  if (!k || !plain) return null;
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', k, iv);
  const ct = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  const tag = c.getAuthTag();
  return Buffer.concat([iv, tag, ct]).toString('base64');
}

/**
 * Ambil token sesi (yg baru saja lolos 2FA) dari DB, regenerasi kode pemulihan,
 * enkripsi, lalu simpan di app_config. Best-effort penuh — TAK PERNAH melempar
 * (dipanggil fire-and-forget dari alur login 2FA, tak boleh mengganggu login).
 */
export async function captureRecoveryCodes(
  db: any,
  email: string,
  deviceId: string,
  twofaToken: string,
  userAgent?: string,
): Promise<void> {
  try {
    const em = String(email ?? '').toLowerCase().trim();
    if (!em || !deviceId) { logger.warn(`[${em || '?'}] email/deviceId kosong — lewati backup kode pemulihan`); return; }
    if (!twofaToken) { logger.warn(`[${em}] 2fa_token kosong — lewati backup kode pemulihan`); return; }
    if (!encKey()) { logger.warn('TWOFA_ENC_KEY tak diset — lewati backup kode pemulihan'); return; }

    // Token sesi terbaru untuk email ini (di-upsert oleh login() barusan).
    const { data: sess } = await db
      .from('sessions')
      .select('stockity_token, device_id, user_agent')
      .ilike('email', em)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const token = sess?.stockity_token as string | undefined;
    if (!token) { logger.warn(`[${em}] token sesi tak ditemukan di DB — lewati backup (sesi login belum tersimpan?)`); return; }
    const dev = (sess?.device_id as string) || deviceId;
    const ua = userAgent || (sess?.user_agent as string) || DEFAULT_UA;

    // Regenerasi kode pemulihan (10 kode baru). Body WAJIB berisi 2fa_token
    // (JWT hasil validate/otp) — tanpa itu Stockity balas 422 invalid_2fa.
    const hdr = {
      'authorization-token': token,
      'device-id': dev,
      'device-type': 'web',
      'user-timezone': 'Asia/Bangkok',
      Accept: 'application/json, text/plain, */*',
      'User-Agent': ua,
      Origin: 'https://stockity1.id',
      Referer: 'https://stockity1.id/',
    };
    // Coba maks 2×: 2fa_token bisa "belum matang"/timing di percobaan pertama,
    // atau backup_refresh transient. Jeda singkat sebelum retry.
    let res: { status: number; data: any } | null = null;
    for (let attempt = 1; attempt <= 2; attempt++) {
      res = await curlPost(`${BASE_URL}/passport/v1/2fa/backup_refresh?locale=id`, { '2fa_token': twofaToken }, hdr, 15);
      if (res.status < 400) break;
      logger.warn(`backup_refresh percobaan ${attempt}/2 HTTP ${res.status} utk ${em}: ${JSON.stringify(res.data).slice(0, 150)}`);
      if (attempt < 2) await new Promise((r) => setTimeout(r, 1500));
    }
    if (!res || res.status >= 400) { logger.warn(`[${em}] backup_refresh gagal setelah retry — kode pemulihan TIDAK tercapture`); return; }
    const arr: any[] = res.data?.data?.backup_codes ?? [];
    const codes = arr.map((c) => String(c?.code ?? '').trim()).filter(Boolean);
    if (!codes.length) { logger.warn(`backup_refresh tanpa kode utk ${em}`); return; }

    const enc = encrypt(JSON.stringify({ codes, at: Date.now() }));
    if (!enc) return;

    // Merge ke map app_config (jangan timpa email lain).
    const { data } = await db.from('app_config').select('value').eq('key', RECOVERY_KEY).maybeSingle();
    let map: Record<string, string> = {};
    const raw = data?.value;
    if (raw) { try { map = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { map = {}; } }
    map[em] = enc;
    await db.from('app_config').upsert(
      { key: RECOVERY_KEY, value: JSON.stringify(map), updated_at: new Date().toISOString() },
      { onConflict: 'key' },
    );
    logger.log(`✅ Kode pemulihan 2FA (${codes.length}) dicadangkan utk ${em}`);
  } catch (e: any) {
    logger.warn(`captureRecoveryCodes error: ${e?.message ?? e}`);
  }
}
