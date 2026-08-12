/**
 * Pembulatan nilai martingale sebelum dikirim ke Stockity.
 *
 * KENAPA BERKAS INI ADA
 * Sebelumnya tujuh tempat menghitung `Math.floor(base * Math.pow(pengali, langkah))`.
 * Pengali seperti 2,3 tidak bisa diwakili persis oleh bilangan pecahan biner:
 *
 *     1.400.000 x 2,3  =  3.219.999,9999999995
 *
 * `Math.floor` memotongnya menjadi **3.219.999** — kurang satu sen dari satuan
 * mata uang penuh. Stockity menolak nilai seperti itu dengan
 * `{"field":"amount","validation":"deal_amount_invalid"}`, dan penolakan itu
 * sampai ke log hanya sebagai `unknown`, sehingga sebabnya tidak pernah
 * terlihat. Akun 183382931 kehilangan 56 order pada 12 Agustus 2026 karena ini,
 * di mode Indicator maupun CTC — bukan gangguan koneksi, bukan saldo kurang.
 *
 * `Math.round` mengembalikan nilai yang SEBENARNYA dimaksud (3.220.000), bukan
 * nilai yang rusak akibat galat pecahan biner.
 *
 * CATATAN yang sengaja TIDAK dilakukan di sini: memaksa hasil ke kelipatan 100
 * (satuan rupiah penuh). Itu benar untuk IDR, tetapi akun mata uang lain
 * memakai satuan berbeda, dan pemaksaan seperti itu akan mengubah nilai order
 * mereka tanpa alasan. Pengali dengan lebih dari dua angka desimal masih bisa
 * menghasilkan pecahan satuan; kalau itu muncul, batasi di sisi masukan
 * pengguna, bukan di sini.
 */
export function bulatkanAmountMartingale(nilai: number): number {
  if (!Number.isFinite(nilai) || nilai <= 0) return 0;
  return Math.round(nilai);
}
