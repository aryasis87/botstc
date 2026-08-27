import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';

// ─────────────────────────────────────────────────────────────────────────────
// AUTO-AKTIVASI: pengajuan aktivasi (real_activation_requests) yang masih
// 'pending' OTOMATIS diberi hak akses 10 MENIT setelah disubmit — supaya user
// tak menunggu konfirmasi manual admin (yang bisa telat >24 jam).
//
// PENTING: ini memberi akses TANPA verifikasi pembayaran manual. Rekonsiliasi
// pembayaran dilakukan terpisah oleh admin (bukti tetap tersimpan di tabel).
//
// Grant per fitur (di DB backend ini sendiri — STC atau KOALA):
//   real       → whitelist_users.real_access = true (+ real_access_at)
//   aisignal   → app_config 'aisignal_access'   map { user_id: expiresAt } (+30 hari)
//   blitz5s    → app_config 'blitz5s_access'     map { user_id: expiresAt } (+30 hari)
//   agentalpha → app_config 'agentalpha_access'  map { user_id: expiresAt } (seumur hidup)
//
// Format MAP { id: expiresAt } dipakai sesuai pembaca app + guard backend.
// ─────────────────────────────────────────────────────────────────────────────

const DAY_MS      = 24 * 60 * 60 * 1000;
const DELAY_MS    = 10 * 60 * 1000;    // aktif 10 menit setelah submit
const MAX_AGE_MS  = 24 * 60 * 60 * 1000; // abaikan pengajuan >24 jam (jangan retro-aktivasi backlog lama)
const SWEEP_MS    = 60 * 1000;         // periksa tiap 1 menit
const LIFETIME_MS = 50 * 365 * DAY_MS; // "seumur hidup" utk agentalpha

const FEATURE_LABEL: Record<string, string> = {
  real: 'REAL', aisignal: 'AI Signal', blitz5s: '5st', agentalpha: 'Agent Alpha',
};

@Injectable()
export class ActivationAutoService {
  private readonly logger = new Logger('ActivationAutoService');
  private sweeping = false;
  private readonly token = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
  private readonly chatIds = (process.env.SUPER_ADMIN_CHAT_IDS ?? '')
    .split(',').map((s) => s.trim()).filter(Boolean);

  constructor(private readonly supabase: SupabaseService) {}

  @Interval(SWEEP_MS)
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      const db = this.supabase.client;
      const now = Date.now();
      const cutoff = new Date(now - DELAY_MS).toISOString();  // dibuat ≤ 10 menit lalu
      const floor  = new Date(now - MAX_AGE_MS).toISOString(); // tapi ≤ 24 jam (recent)

      const { data: rows, error } = await db
        .from('real_activation_requests')
        .select('id, feature, stockity_id, created_at, app')
        .eq('status', 'pending')
        .lte('created_at', cutoff)
        .gte('created_at', floor)
        .limit(50);
      if (error) { this.logger.warn(`sweep query gagal: ${error.message}`); return; }
      if (!rows?.length) return;

      for (const r of rows as any[]) {
        const uid  = String(r.stockity_id ?? '').trim();
        const feat = String(r.feature ?? 'real').trim();
        if (!uid) { await this.mark(r.id, 'unpaid'); continue; }

        const ok = await this.grant(feat, uid);
        if (ok) {
          await this.mark(r.id, 'paid');
          this.logger.log(`[AUTO] Aktivasi ${feat} untuk ID ${uid} (10 menit, tanpa konfirmasi manual)`);
          this.notify(feat, uid, String(r.app ?? ''));
        } else {
          // Gagal grant (mis. REAL: user tak ada di whitelist) → tandai supaya tak
          // di-retry tiap menit; admin bisa cek manual.
          await this.mark(r.id, 'unpaid');
          this.logger.warn(`[AUTO] Gagal auto-aktivasi ${feat} ID ${uid} → ditandai unpaid`);
        }
      }
    } catch (e: any) {
      this.logger.warn(`sweep error: ${e?.message ?? e}`);
    } finally {
      this.sweeping = false;
    }
  }

  private async mark(id: any, status: 'paid' | 'unpaid'): Promise<void> {
    try {
      await this.supabase.client.from('real_activation_requests').update({ status }).eq('id', id);
    } catch { /* best-effort */ }
  }

  private async grant(feature: string, uid: string): Promise<boolean> {
    const db = this.supabase.client;
    try {
      if (feature === 'real') {
        const { data, error } = await db.from('whitelist_users')
          .update({ real_access: true, real_access_at: new Date().toISOString() })
          .eq('user_id', uid)
          .select('user_id');
        if (error) { this.logger.warn(`grant real gagal: ${error.message}`); return false; }
        return (data?.length ?? 0) > 0; // false bila user tak ada di whitelist
      }

      const key =
        feature === 'aisignal'   ? 'aisignal_access'   :
        feature === 'blitz5s'    ? 'blitz5s_access'    :
        feature === 'agentalpha' ? 'agentalpha_access' : null;
      if (!key) { this.logger.warn(`grant: fitur tak dikenal "${feature}"`); return false; }

      const dur = feature === 'agentalpha' ? LIFETIME_MS : 30 * DAY_MS;
      const { data } = await db.from('app_config').select('value').eq('key', key).maybeSingle();
      const map = this.toMap(data?.value);
      map[uid] = Date.now() + dur;                 // aktivasi ulang = perpanjang
      const { error } = await db.from('app_config').upsert(
        { key, value: JSON.stringify(map), updated_at: new Date().toISOString() },
        { onConflict: 'key' },
      );
      if (error) { this.logger.warn(`grant ${feature} gagal: ${error.message}`); return false; }
      return true;
    } catch (e: any) {
      this.logger.warn(`grant ${feature} error: ${e?.message ?? e}`);
      return false;
    }
  }

  /** Normalisasi value app_config ke map { id: expiresAt } (tahan bentuk array legacy). */
  private toMap(raw: unknown): Record<string, number> {
    let v: unknown = raw;
    if (typeof raw === 'string') { try { v = JSON.parse(raw); } catch { return {}; } }
    const out: Record<string, number> = {};
    const now = Date.now();
    if (Array.isArray(v)) {
      // Legacy array id → pertahankan sbg aktif (seumur hidup) agar tak tercabut.
      for (const id of v) { const k = String(id).trim(); if (k) out[k] = now + LIFETIME_MS; }
    } else if (v && typeof v === 'object') {
      for (const [k, e] of Object.entries(v as Record<string, unknown>)) {
        const key = String(k).trim(); const t = Number(e);
        if (key && Number.isFinite(t)) out[key] = t;
      }
    }
    return out;
  }

  private notify(feature: string, uid: string, app: string): void {
    if (!this.token || !this.chatIds.length) return;
    const label = FEATURE_LABEL[feature] ?? feature;
    const brand = app === 'koala' ? 'Koala S Pro' : 'STC AutoTrade';
    const text =
      `✅ AUTO-AKTIVASI (10 menit) — ${brand}\n\n` +
      `${label} untuk ID ${uid} otomatis diaktifkan tanpa konfirmasi manual.\n` +
      `➡️ Cek pembayaran bila perlu (bukti tersimpan di panel).`;
    for (const chatId of this.chatIds) {
      fetch(`https://api.telegram.org/bot${this.token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text }),
      }).catch(() => { /* best-effort */ });
    }
  }
}
