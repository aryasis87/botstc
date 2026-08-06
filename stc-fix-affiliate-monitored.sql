-- ════════════════════════════════════════════════════════════════════════
-- STC — Lepas pemantauan VPS untuk SEMUA akun AFILIASI (self-register)
-- DB: njnrrwuhflnwumxjivca  (jalankan di Supabase SQL Editor STC)
-- ════════════════════════════════════════════════════════════════════════
--
-- MASALAH (Affiliate TOP — "no IP intersection / persinggungan"):
--   Bot Telegram di VPS memilih sesi lewat  monitored = true  lalu LOGIN ULANG
--   ke Stockity memakai password tersimpan di kolom "PK". Artinya setiap akun
--   monitored=true disentuh dari IP VPS. Untuk akun afiliasi (klien referral),
--   ini membuat IP VPS "bersinggungan" dengan akun trader → komisi dipotong.
--
-- SOLUSI:
--   Akun afiliasi = whitelist_users.added_by IN ('selfregister','self-register').
--   Set  monitored = false  DAN  "PK" = NULL  → bot tidak akan pernah memilihnya
--   maupun punya kredensial untuk login. Aktivitas akun afiliasi hanya dari
--   perangkat user sendiri.
--
-- Akun produk biasa (bukan afiliasi) TIDAK disentuh sama sekali.
-- ────────────────────────────────────────────────────────────────────────

-- 1) PRATINJAU — lihat dulu berapa & akun mana yang akan diubah:
SELECT s.email, s.monitored, (s."PK" IS NOT NULL) AS punya_pk, w.added_by
FROM sessions s
JOIN whitelist_users w
  ON (w.user_id = s.user_id OR lower(w.email) = lower(s.email))
WHERE lower(w.added_by) IN ('selfregister', 'self-register')
  AND (s.monitored IS DISTINCT FROM false OR s."PK" IS NOT NULL)
ORDER BY s.updated_at DESC;

-- 2) EKSEKUSI — lepaskan pemantauan + hapus PK untuk akun afiliasi:
UPDATE sessions s
SET monitored = false,
    "PK" = NULL
FROM whitelist_users w
WHERE (w.user_id = s.user_id OR lower(w.email) = lower(s.email))
  AND lower(w.added_by) IN ('selfregister', 'self-register')
  AND (s.monitored IS DISTINCT FROM false OR s."PK" IS NOT NULL);

-- 3) VERIFIKASI — harus 0 baris:
SELECT count(*) AS afiliasi_masih_terpantau
FROM sessions s
JOIN whitelist_users w
  ON (w.user_id = s.user_id OR lower(w.email) = lower(s.email))
WHERE lower(w.added_by) IN ('selfregister', 'self-register')
  AND (s.monitored = true OR s."PK" IS NOT NULL);
