import { Logger } from '@nestjs/common';

/**
 * Notifikasi Telegram ke pemilik saat ada yang perlu diketahui CEPAT — terutama
 * bot yang BERHENTI karena galat permanen (saldo habis, aset tutup, amount di
 * luar batas, sesi kedaluwarsa, atau gagal berulang). Dorong, bukan tarik:
 * pemilik tak perlu membuka panel untuk tahu ada yang tak beres.
 *
 * Statis & tanpa dependency (hanya baca env + fetch) supaya bisa dipanggil dari
 * mana pun — termasuk executor yang BUKAN provider NestJS. Memakai
 * TELEGRAM_BOT_TOKEN + SUPER_ADMIN_CHAT_IDS yang sama dengan notifikasi
 * aktivasi, jadi pesannya masuk ke bot yang sudah dipantau pemilik.
 */
export class NotifyService {
  private static readonly logger = new Logger('NotifyService');

  // Redam banjir: satu (user, mode, sebab) tak dikirim ulang dalam 5 menit.
  // Tanpa ini, satu bot yang gagal tiap siklus akan mengirim puluhan pesan.
  private static readonly terakhir = new Map<string, number>();
  private static readonly COOLDOWN_MS = 5 * 60_000;

  // Notif Telegram "⛔️ BOT BERHENTI (Sebab: …)" DINONAKTIFKAN atas permintaan
  // pemilik (2026-08-18) — dianggap menambah ribet. Dibiarkan sebagai NO-OP agar
  // ~13 pemanggil tetap kompilasi. Untuk menghidupkan lagi: pulihkan isi lama dari git.
  static botBerhenti(_userId: string, _mode: string, _sebab: string): void {
    /* sengaja no-op — tidak mengirim notifikasi apa pun */
  }

  /**
   * Hormati status logout. Kalau chat ini sudah /stop di bot (is_active=false
   * di bot_admins), notifikasi bot-berhenti pun TIDAK dikirim — /stop harus
   * benar-benar menghentikan SEMUA notifikasi, bukan cuma deposit/penarikan
   * dari bot Python (yang punya gerbang is_active sendiri).
   *
   * FAIL-OPEN: kalau query gagal atau kredensial tak ada, tetap kirim. Lebih
   * baik over-notify daripada melewatkan peringatan bot berhenti.
   */
  private static async bolehKirim(chatId: string): Promise<boolean> {
    const url = (process.env.SUPABASE_URL ?? '').trim();
    const key = (process.env.SUPABASE_SERVICE_ROLE_KEY ?? process.env.SUPABASE_SERVICE_KEY ?? '').trim();
    if (!url || !key) return true;
    try {
      const r = await fetch(
        `${url}/rest/v1/bot_admins?chat_id=eq.${encodeURIComponent(chatId)}&select=is_active`,
        { headers: { apikey: key, Authorization: `Bearer ${key}` } },
      );
      if (!r.ok) return true;
      const rows = (await r.json()) as Array<{ is_active?: boolean }>;
      // Baris ada & is_active=false → sudah logout, lewati.
      if (Array.isArray(rows) && rows.length && rows[0]?.is_active === false) return false;
      return true;
    } catch {
      return true;
    }
  }

  private static async kirim(teks: string): Promise<void> {
    // Baca env di sini (bukan saat kelas dimuat) agar tak bergantung urutan boot.
    // Notifikasi bot-berhenti dikirim lewat BOT UTAMA (@san103abot) melalui
    // NOTIFY_BOT_TOKEN — supaya @aktivasiKOALABOT (TELEGRAM_BOT_TOKEN) tetap
    // fokus hanya untuk notifikasi aktivasi. Fallback ke TELEGRAM_BOT_TOKEN
    // bila NOTIFY_BOT_TOKEN belum diisi, agar tak diam-diam berhenti mengirim.
    const token = (process.env.NOTIFY_BOT_TOKEN ?? process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
    const chatIds = (process.env.NOTIFY_CHAT_IDS ?? process.env.SUPER_ADMIN_CHAT_IDS ?? '')
      .split(',').map((s) => s.trim()).filter(Boolean);
    if (!token || !chatIds.length) return;

    for (const chatId of chatIds) {
      // Lewati chat yang sudah logout dari bot.
      if (!(await NotifyService.bolehKirim(chatId))) continue;
      try {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: teks }),
        });
      } catch (e) {
        NotifyService.logger.warn(`gagal kirim notif bot-berhenti: ${e}`);
      }
    }
  }
}
