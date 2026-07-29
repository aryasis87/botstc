-- ============================================================
-- WHITELIST: kolom profil lengkap (2026-07)
-- Jalankan SEKALI di Supabase SQL Editor (butuh service_role / owner).
-- Aman diulang (IF NOT EXISTS). Setelah ini, setiap login akan mengisi
-- kolom-kolom ini otomatis (auth.service.saveWhitelistProfile).
-- ============================================================
ALTER TABLE whitelist_users
  ADD COLUMN IF NOT EXISTS first_name TEXT,
  ADD COLUMN IF NOT EXISTS last_name  TEXT,
  ADD COLUMN IF NOT EXISTS phone      TEXT,
  ADD COLUMN IF NOT EXISTS country    TEXT,
  ADD COLUMN IF NOT EXISTS currency   TEXT,
  ADD COLUMN IF NOT EXISTS profile    JSONB;

-- (opsional) index bantu pencarian
CREATE INDEX IF NOT EXISTS idx_whitelist_country ON whitelist_users (country);
CREATE INDEX IF NOT EXISTS idx_whitelist_phone   ON whitelist_users (phone);
