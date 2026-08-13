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

  static botBerhenti(userId: string, mode: string, sebab: string): void {
    const now = Date.now();
    const kunci = `${userId}|${mode}|${sebab}`;
    if ((NotifyService.terakhir.get(kunci) ?? 0) > now - NotifyService.COOLDOWN_MS) return;
    NotifyService.terakhir.set(kunci, now);

    // Jaga Map tak tumbuh tanpa batas.
    if (NotifyService.terakhir.size > 500) {
      for (const [k, t] of NotifyService.terakhir) {
        if (t < now - NotifyService.COOLDOWN_MS) NotifyService.terakhir.delete(k);
      }
    }

    const teks =
      `⛔️ BOT BERHENTI\n\n` +
      `Mode  : ${mode}\n` +
      `User  : ${userId}\n` +
      `Sebab : ${sebab}\n\n` +
      `🕒 ${new Date().toLocaleString('id-ID', { timeZone: 'Asia/Jakarta' })} WIB`;
    void NotifyService.kirim(teks);
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
