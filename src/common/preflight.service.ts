import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ProfileService } from '../profile/profile.service';
import { bulatkanAmountMartingale } from './martingale-amount';

/**
 * Pemeriksaan konfigurasi SEBELUM bot mulai. Tujuannya menolak konfigurasi yang
 * PASTI gagal — dan memberi tahu pengguna DI MUKA — bukan membiarkan bot jalan
 * lalu berhenti di tengah karena order ditolak Stockity.
 *
 * Mencegah persis tiga kegagalan yang pernah kita temukan di produksi:
 *   • amount dasar di bawah minimum Stockity
 *   • langkah martingale menembus maksimum Stockity (nilai berlipat tiap langkah)
 *   • saldo tak cukup menutup skenario kalah-beruntun (deal_amount_balance)
 *
 * PRINSIP: FAIL-OPEN. Kalau data limit/saldo gagal diambil (mis. Stockity lambat),
 * start TIDAK dihalangi — validasi tak boleh jadi titik gagal baru yang mengunci
 * pengguna dari trading. Hanya menolak bila datanya ADA dan jelas bermasalah.
 */
@Injectable()
export class PreflightService {
  private readonly logger = new Logger('PreflightService');

  constructor(private readonly profile: ProfileService) {}

  /**
   * @param config objek konfigurasi mode — dibaca lentur: martingale.baseAmount,
   *               atau baseAmount (aisignal), plus martingale{maxSteps,multiplier}.
   */
  async validasi(userId: string, config: any, mode: string): Promise<void> {
    const mart = config?.martingale;
    const base = Number(
      mart?.baseAmount ?? config?.baseAmount ?? config?.settings?.amount ?? 0,
    );
    // Tak ada amount yang bisa dinilai → jangan blokir apa pun.
    if (!Number.isFinite(base) || base <= 0) return;

    let cfg: any, bal: any;
    try {
      [cfg, bal] = await Promise.all([
        this.profile.getCurrencyConfig(userId),
        this.profile.getBalance(userId),
      ]);
    } catch (e) {
      // FAIL-OPEN — gagal ambil data bukan alasan mengunci pengguna.
      this.logger.warn(`[${userId}] preflight dilewati (gagal ambil limit/saldo): ${e}`);
      return;
    }

    // getCurrencyConfig mengembalikan nilai DISPLAY (cents ÷100); amount internal
    // dalam cents. Kalikan 100 agar dibandingkan dalam satuan yang sama.
    const rawMin = Number(cfg?.minAmount ?? 0) * 100;
    const rawMax = Number(cfg?.maxAmount ?? 0) * 100;
    const unit = cfg?.currencyUnit ?? 'Rp';
    const isDemo = config?.isDemoAccount ?? true;
    const saldo = Number(isDemo ? bal?.demo_balance : bal?.real_balance) || 0;

    const fmt = (cents: number) =>
      `${unit} ${Math.round(cents / 100).toLocaleString('id-ID')}`;

    // Proyeksi amount tiap langkah martingale (sama rumus dengan eksekusi asli).
    const enabled = !!mart?.isEnabled;
    const maxSteps = enabled ? Math.max(1, Number(mart.maxSteps) || 1) : 0;
    const mult = enabled
      ? (mart.multiplierType === 'FIXED'
          ? Number(mart.multiplierValue)
          : 1 + Number(mart.multiplierValue) / 100)
      : 1;
    const steps: number[] = [];
    for (let s = 0; s <= maxSteps; s++) {
      steps.push(s === 0
        ? bulatkanAmountMartingale(base)
        : bulatkanAmountMartingale(base * Math.pow(mult, s)));
    }
    const stepMax = steps.reduce((a, b) => Math.max(a, b), 0);
    const totalWorst = steps.reduce((a, b) => a + b, 0);

    // 1) amount dasar di bawah minimum
    if (rawMin > 0 && base < rawMin) {
      throw new BadRequestException(
        `Amount dasar ${fmt(base)} di bawah minimum Stockity ${fmt(rawMin)}. ` +
        `Naikkan amount sebelum memulai ${mode}.`);
    }
    // 2) langkah martingale menembus maksimum
    if (rawMax > 0 && stepMax > rawMax) {
      throw new BadRequestException(
        `Dengan martingale ini amount bisa mencapai ${fmt(stepMax)} pada langkah ke-${maxSteps} — ` +
        `melebihi maksimum Stockity ${fmt(rawMax)}. Kurangi pengali, jumlah langkah, atau amount dasar.`);
    }
    // 3) saldo tak cukup untuk skenario kalah beruntun (REAL saja, bila saldo terbaca)
    if (!isDemo && saldo > 0 && totalWorst > saldo) {
      const rincian = maxSteps > 0
        ? `${maxSteps} langkah martingale bila semua kalah`
        : 'order ini';
      throw new BadRequestException(
        `Saldo ${fmt(saldo)} tidak cukup untuk menutup ${rincian} (butuh ${fmt(totalWorst)}). ` +
        `Tambah saldo, atau kecilkan amount/langkah.`);
    }

    this.logger.log(
      `[${userId}] preflight ${mode} lolos — base=${fmt(base)} stepMax=${fmt(stepMax)} ` +
      `total=${fmt(totalWorst)} saldo=${fmt(saldo)} (demo=${isDemo})`);
  }
}
