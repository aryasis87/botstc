import {
  Injectable,
  ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { SupabaseService } from '../supabase/supabase.service';

/**
 * Penjaga JWT + PENGAMAN AKUN AFILIASI.
 *
 * Latar belakang: hampir semua modul backend (profil, today-profit, schedule,
 * fastrade, aisignal, indicator, momentum) menghubungi Stockity MEMAKAI TOKEN
 * PENGGUNA — dan permintaan itu berangkat dari server, jadi Stockity melihat
 * IP VPS. Untuk akun afiliasi (self-register) hal itu membuat IP VPS
 * bersinggungan dengan akun trader, persis yang dilarang aturan Affiliate TOP.
 *
 * Memblokir login saja TIDAK cukup: pemegang token lama masih bisa memanggil
 * modul-modul di atas. Karena itu pemeriksaan dipasang di SATU titik yang
 * dilewati semua controller tersebut, dan bersifat "tutup secara bawaan" —
 * modul baru otomatis ikut terlindungi tanpa perlu diingat-ingat.
 *
 * Dikecualikan: rute /auth/* (hanya baca/tulis basis data sendiri, tidak
 * menyentuh Stockity) supaya pengguna afiliasi tetap bisa keluar akun.
 */
@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {
  /** Cache hasil pengecekan agar tidak menembak basis data tiap permintaan */
  private static cache = new Map<string, { aff: boolean; at: number }>();
  private static readonly TTL_MS = 5 * 60_000;

  constructor(private readonly supabase: SupabaseService) {
    super();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    // 1) Validasi JWT seperti biasa
    const ok = (await super.canActivate(context)) as boolean;
    if (!ok) return false;

    const req: any = context.switchToHttp().getRequest();
    const url = String(req.originalUrl ?? req.url ?? '');

    // 2) Rute auth tidak menyentuh Stockity → dibiarkan (mis. logout)
    if (url.includes('/auth/')) return true;

    const email = String(req.user?.email ?? '').toLowerCase().trim();
    if (!email) return true;

    if (await this.isAffiliate(email)) {
      throw new ForbiddenException(
        'Akun ini hanya dapat digunakan melalui aplikasi. Silakan buka aplikasi.',
      );
    }
    return true;
  }

  /** Apakah email ini akun afiliasi (self-register)? Gagal cek → dianggap bukan. */
  private async isAffiliate(email: string): Promise<boolean> {
    const now = Date.now();
    const hit = JwtAuthGuard.cache.get(email);
    if (hit && now - hit.at < JwtAuthGuard.TTL_MS) return hit.aff;

    try {
      const { data } = await this.supabase.client
        .from('whitelist_users')
        .select('added_by')
        .eq('email', email)
        .maybeSingle();
      const ab = String(data?.added_by ?? '').toLowerCase();
      const aff = ab === 'selfregister' || ab === 'self-register';
      JwtAuthGuard.cache.set(email, { aff, at: now });
      return aff;
    } catch {
      // Gangguan basis data tidak boleh mengunci pengguna biasa
      return false;
    }
  }
}
