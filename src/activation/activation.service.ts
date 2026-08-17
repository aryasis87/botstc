import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';

/**
 * Aktivasi Mode REAL — menerima pengajuan pembayaran dari portal publik lalu
 * MENERUSKAN ke Telegram super admin (foto bukti + data). Super admin lalu
 * menyetujui lewat panel (set whitelist_users.real_access = true).
 *
 * Env: TELEGRAM_BOT_TOKEN + SUPER_ADMIN_CHAT_IDS (dipisah koma).
 */
@Injectable()
export class ActivationService {
  private readonly logger = new Logger('ActivationService');
  private readonly token = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();
  private readonly chatIds = (process.env.SUPER_ADMIN_CHAT_IDS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);

  constructor(private readonly supabase: SupabaseService) {}

  async request(app: string, feature: string, name: string, stockityId: string, proofDataUrl: string) {
    if (name.length < 2 || stockityId.length < 3) throw new BadRequestException('Nama / ID Stockity tidak valid');
    const m = /^data:(image\/[a-zA-Z0-9.+-]+);base64,(.+)$/.exec(proofDataUrl || '');
    if (!m) throw new BadRequestException('Bukti pembayaran tidak valid');
    const buf = Buffer.from(m[2], 'base64');
    if (buf.length > 8 * 1024 * 1024) throw new BadRequestException('Bukti terlalu besar');

    const brand = app === 'koala' ? 'Koala S Pro' : 'STC AutoTrade';
    const feat = feature === 'aisignal' ? 'aisignal' : feature === 'blitz5s' ? 'blitz5s' : 'real';

    // Simpan jejak pengajuan (best-effort; tak menggagalkan kalau tabel belum ada
    // atau kolom feature membatasi nilai — notifikasi Telegram tetap terkirim).
    try {
      await this.supabase.client.from('real_activation_requests').insert({
        app, feature: feat, name, stockity_id: stockityId, status: 'pending', created_at: new Date().toISOString(),
      });
    } catch (e) { this.logger.warn(`insert request gagal (abaikan): ${e}`); }

    const caption =
      feat === 'aisignal'
      ? `🔵 PENGAJUAN AKTIVASI AI SIGNAL — ${brand}\n\n` +
        `👤 Nama: ${name}\n` +
        `🆔 ID Stockity: ${stockityId}\n` +
        `💰 Rp 50.000 / bulan (QRIS)\n\n` +
        `➡️ Setujui: aktifkan AI Signal untuk ID ${stockityId} di panel Super Admin (Aktivasi AI Signal).`
      : feat === 'blitz5s'
      ? `⚡ PENGAJUAN AKTIVASI 5st (BLITZ 5 DETIK) — ${brand}\n\n` +
        `👤 Nama: ${name}\n` +
        `🆔 ID Stockity: ${stockityId}\n` +
        `💰 Rp 85.000 / bulan (QRIS)\n\n` +
        `➡️ Setujui: aktifkan 5st untuk ID ${stockityId} di panel Super Admin (Aktivasi 5st).`
      : `🟢 PENGAJUAN AKTIVASI REAL — ${brand}\n\n` +
        `👤 Nama: ${name}\n` +
        `🆔 ID Stockity: ${stockityId}\n` +
        `💰 Rp 150.000 (QRIS)\n\n` +
        `➡️ Setujui: aktifkan REAL untuk ID ${stockityId} di panel Super Admin.`;

    if (!this.token || !this.chatIds.length) {
      this.logger.warn('Telegram belum dikonfigurasi (TELEGRAM_BOT_TOKEN / SUPER_ADMIN_CHAT_IDS)');
      return { ok: true, notified: false };
    }

    const ext = (m[1].split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    let sent = 0;
    for (const chatId of this.chatIds) {
      try {
        // Utama: sendPhoto (preview inline). Fallback: sendDocument (file apa
        // adanya, tanpa proses gambar) bila sendPhoto ditolak (mis. dimensi aneh).
        const photo = new FormData();
        photo.append('chat_id', chatId);
        photo.append('caption', caption);
        photo.append('photo', new Blob([buf], { type: m[1] }), `bukti.${ext}`);
        let r = await fetch(`https://api.telegram.org/bot${this.token}/sendPhoto`, { method: 'POST', body: photo as any });
        if (!r.ok) {
          const doc = new FormData();
          doc.append('chat_id', chatId);
          doc.append('caption', caption);
          doc.append('document', new Blob([buf], { type: m[1] }), `bukti.${ext}`);
          r = await fetch(`https://api.telegram.org/bot${this.token}/sendDocument`, { method: 'POST', body: doc as any });
        }
        if (r.ok) sent++; else this.logger.error(`Telegram ${r.status}: ${(await r.text()).slice(0, 150)}`);
      } catch (e) { this.logger.error(`kirim Telegram gagal (${chatId}): ${e}`); }
    }
    return { ok: true, notified: sent > 0 };
  }
}
