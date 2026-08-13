-- ════════════════════════════════════════════════════════════════════════
-- PERF INDEXES — percepat query panas (bot monitoring, backend, Riwayat)
-- JALANKAN DI KEDUA Supabase SQL Editor:
--   STC   → njnrrwuhflnwumxjivca
--   KOALA → noyqhulqgsvhnufllxyp
-- Aman & idempoten (IF NOT EXISTS). CATATAN: ini mempercepat sisi SERVER
-- (bot, backend, halaman Riwayat) — BUKAN eksekusi order di APK (itu langsung
-- ke Stockity, tak lewat Supabase).
-- ════════════════════════════════════════════════════════════════════════

-- 0) PRATINJAU index yang SUDAH ada — lewati CREATE utk kolom yang sudah terindeks
--    (mis. user_id kalau itu Primary Key). Jalankan ini dulu.
SELECT tablename, indexname, indexdef
FROM pg_indexes
WHERE schemaname='public'
  AND tablename IN ('sessions','whitelist_users','mode_logs','deposit_events','withdrawal_events','app_config')
ORDER BY tablename, indexname;

-- ── sessions ── (bot memfilter monitored=true; lookup by user_id/email) ────────
CREATE INDEX IF NOT EXISTS idx_perf_sessions_monitored ON sessions (monitored) WHERE monitored = true;
CREATE INDEX IF NOT EXISTS idx_perf_sessions_email     ON sessions (lower(email));
-- user_id: buat HANYA bila belum jadi PK/unique (cek pratinjau di atas)
-- CREATE INDEX IF NOT EXISTS idx_perf_sessions_user_id ON sessions (user_id);

-- ── whitelist_users ── (filter afiliasi added_by+added_at; lookup user_id/email)
CREATE INDEX IF NOT EXISTS idx_perf_wl_added_by_at ON whitelist_users (added_by, added_at);
CREATE INDEX IF NOT EXISTS idx_perf_wl_user_id     ON whitelist_users (user_id);
CREATE INDEX IF NOT EXISTS idx_perf_wl_email       ON whitelist_users (lower(email));

-- ── mode_logs ── (halaman Riwayat: per user, urut waktu, per mode) ─────────────
CREATE INDEX IF NOT EXISTS idx_perf_mode_logs_user_created ON mode_logs (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_perf_mode_logs_user_mode    ON mode_logs (user_id, mode);

-- ── deposit_events / withdrawal_events ── (dedup txn + per user) ───────────────
CREATE INDEX IF NOT EXISTS idx_perf_dep_txn     ON deposit_events (transaction_id);
CREATE INDEX IF NOT EXISTS idx_perf_dep_user_at ON deposit_events (user_id, detected_at DESC);
CREATE INDEX IF NOT EXISTS idx_perf_wd_txn      ON withdrawal_events (transaction_id);
CREATE INDEX IF NOT EXISTS idx_perf_wd_user_at  ON withdrawal_events (user_id, detected_at DESC);

-- ── app_config ── (lookup by key: aisignal_access, fastreversal_access, dll) ───
CREATE INDEX IF NOT EXISTS idx_perf_app_config_key ON app_config (key);

-- Segarkan statistik planner
ANALYZE sessions; ANALYZE whitelist_users; ANALYZE mode_logs;
ANALYZE deposit_events; ANALYZE withdrawal_events; ANALYZE app_config;
