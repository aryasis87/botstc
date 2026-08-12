/**
 * Pembulatan nilai order sebelum dikirim ke Stockity.
 *
 * ATURAN YANG SEBENARNYA BERLAKU
 * Amount dinyatakan dalam SEN, dan Stockity hanya menerima **satuan mata uang
 * penuh** — nilainya harus kelipatan 100. Apa pun di luar itu ditolak dengan
 * `{"field":"amount","validation":"deal_amount_invalid"}`.
 *
 * Dibuktikan dari log produksi: dari 17 nilai amount yang PERNAH berhasil,
 * seluruhnya kelipatan 100, tanpa kecuali. Sementara yang ditolak:
 *
 *   3.219.999  ← 1.400.000 x 2,3, dipotong Math.floor dari 3.219.999,9999999995
 *         250  ← 100 x 2,5, aritmetika bulat, tanpa galat pecahan sama sekali
 *
 * Dua sebab yang berbeda, satu aturan yang sama. Karena itu `Math.round` saja
 * TIDAK cukup: ia membetulkan kasus pertama tetapi meloloskan kasus kedua.
 * Akun 183892037 tetap gagal berulang setelah perbaikan yang hanya memakai
 * Math.round — itulah yang membuka aturan sebenarnya.
 *
 * PEMBULATAN KE TERDEKAT, BUKAN KE BAWAH
 * Ke terdekat memulihkan maksud asli pada kasus galat pecahan
 * (3.219.999,9999999995 -> 3.220.000, persis angka yang dimaksud). Memotong ke
 * bawah akan menghasilkan 3.219.900 — sah diterima, tapi meleset satu rupiah
 * dari yang diminta pengguna tanpa alasan.
 *
 * BATAS BAWAH
 * Hasil tidak boleh 0: nol bukan order yang sah dan hanya akan ditolak dengan
 * alasan lain. Nilai positif yang lebih kecil dari satu satuan dinaikkan ke
 * 100, satuan terkecil yang bisa diterima.
 */
export function bulatkanAmountMartingale(nilai: number): number {
  if (!Number.isFinite(nilai) || nilai <= 0) return 0;
  const bulat = Math.round(nilai / 100) * 100;
  return bulat < 100 ? 100 : bulat;
}

/**
 * Menerjemahkan penolakan Stockity yang TIDAK akan hilang kalau dicoba lagi,
 * jadi kalimat yang bisa langsung ditunjukkan ke pengguna.
 *
 * Mengembalikan null untuk galat yang sifatnya sesaat. Bedanya penting:
 * hanya kegagalan permanen yang layak menghentikan bot — koneksi yang
 * terputus sebentar tidak boleh ikut mematikan bot orang.
 *
 * Kalimatnya UTUH, bukan potongan. Versi sebelumnya mengembalikan potongan
 * yang hanya masuk akal disisipkan ke "Amount ___ Stockity", dan itu langsung
 * buntu begitu ada sebab yang bukan soal amount.
 */
export function galatOrderPermanen(err: string | undefined): string | null {
  if (err === 'amount_min') return 'Amount di bawah minimum Stockity';
  if (err === 'amount_max') return 'Amount melebihi maksimum Stockity';
  // Kelipatan 100 sen = satu satuan mata uang penuh.
  if (err === 'amount_invalid') return 'Amount bukan satuan mata uang penuh';
  // Saldo bisa bertambah nanti, tapi selama belum, setiap order pasti gagal —
  // lebih baik berhenti dan bilang, daripada menembak terus tanpa kabar.
  if (err === 'amount_balance') return 'Saldo tidak cukup untuk amount ini';
  // Aset OTC tutup di hari kerja — ini sebab yang paling sering disalahartikan
  // sebagai gangguan koneksi.
  if (err === 'expire_at') return 'Aset sedang tutup — pilih aset lain';
  return null;
}
