import {
  Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Request, UseGuards, HttpCode,
} from '@nestjs/common';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AdminGuard, SuperAdminGuard } from './admin.guard';
import { AdminService } from './admin.service';

// ─────────────────────────────────────────────────────────────────────
// PEMBAGIAN ROLE (ditetapkan pemilik 2026-08-12)
//   super admin : akses penuh
//   admin biasa : SEMUA fitur, KECUALI panel whitelist
//
// Karena itu penjaganya DIBALIK dari sebelumnya: whitelist naik ke
// SuperAdminGuard, sedangkan config/real-access turun ke AdminGuard.
//
// SATU PENGECUALIAN YANG DISENGAJA: pengelolaan admin & super-admin
// (admins*, super-admins*) TETAP super admin. Itu bukan "fitur" melainkan
// mekanisme yang menentukan role itu sendiri — bila admin biasa boleh
// mengaksesnya, ia bisa mengangkat dirinya menjadi super admin dan
// pembedaan kedua role jadi tak berarti.
// ─────────────────────────────────────────────────────────────────────
@UseGuards(JwtAuthGuard)
@Controller('admin')
export class AdminController {
  constructor(private readonly svc: AdminService) {}

  // ── Self (cukup login) ─────────────────────────────────────────────────────
  /** Status role user saat ini — menggantikan checkIsAdmin/checkIsSuperAdmin dari anon. */
  @Get('me')
  me(@Request() req) {
    return this.svc.getMe(req.user.email);
  }

  /** Self-registration whitelist — user menambahkan DIRINYA sendiri (email & userId dari JWT). */
  @Post('whitelist/self')
  @HttpCode(200)
  selfRegister(@Request() req, @Body() body: { name?: string; deviceId?: string; isPrimary?: boolean; addedBy?: string }) {
    return this.svc.selfRegister(req.user.email, req.user.userId, body ?? {});
  }

  // ── Whitelist (admin) ──────────────────────────────────────────────────────
  @UseGuards(SuperAdminGuard)
  @Get('whitelist')
  async listWhitelist(@Request() req) {
    const { isSuperAdmin } = await this.svc.getMe(req.user.email);
    return this.svc.listWhitelist(req.user.email, isSuperAdmin);
  }

  /** Aktivasi Mode REAL per akun (super admin) — dipakai panel aktivasi. */
  @UseGuards(AdminGuard)
  @Post('real-access')
  @HttpCode(200)
  async setRealAccess(@Body() body: { stockityId?: string; enabled?: boolean }) {
    return this.svc.setRealAccess(String(body?.stockityId ?? ''), body?.enabled !== false);
  }

  @UseGuards(SuperAdminGuard)
  @Get('stats')
  async stats(@Request() req) {
    const { isSuperAdmin } = await this.svc.getMe(req.user.email);
    return this.svc.stats(req.user.email, isSuperAdmin);
  }

  @UseGuards(SuperAdminGuard)
  @Post('whitelist')
  @HttpCode(200)
  addWhitelist(@Request() req, @Body() body: { email: string; name?: string; userId?: string; deviceId?: string; isPrimary?: boolean; addedBy?: string }) {
    return this.svc.addWhitelist(body, body.addedBy ?? req.user.email);
  }

  @UseGuards(SuperAdminGuard)
  @Patch('whitelist')
  @HttpCode(200)
  async updateWhitelist(@Request() req, @Body() body: { oldEmail: string; email?: string; name?: string; userId?: string; deviceId?: string; isActive?: boolean; lastLogin?: number | null }) {
    const { oldEmail, ...updates } = body;
    const { isSuperAdmin } = await this.svc.getMe(req.user.email);
    return this.svc.updateWhitelist(oldEmail, updates, { email: req.user.email, isSuper: isSuperAdmin });
  }

  // Fitur nonaktifkan & hapus user DIHAPUS (2026-07): admin/super_admin tidak
  // boleh lagi menonaktifkan atau menghapus data user — user yang sudah masuk
  // tersimpan permanen. Endpoint whitelist/toggle & DELETE whitelist ditiadakan,
  // dan updateWhitelist mengabaikan field isActive (lihat admin.service.ts).

  @UseGuards(SuperAdminGuard)
  @Post('whitelist/import')
  @HttpCode(200)
  importWhitelist(@Request() req, @Body() body: { rows: any[]; addedBy?: string }) {
    return this.svc.importWhitelist(body.rows ?? [], body.addedBy ?? req.user.email);
  }

  // ── Admin users (super admin only) ─────────────────────────────────────────
  @UseGuards(SuperAdminGuard)
  @Get('admins')
  listAdmins() {
    return this.svc.listAdmins();
  }

  @UseGuards(SuperAdminGuard)
  @Post('admins')
  @HttpCode(200)
  addAdmin(@Body() body: { email: string; name?: string; role?: string }) {
    return this.svc.addAdmin(body.email, body.name, body.role);
  }

  @UseGuards(SuperAdminGuard)
  @Patch('admins/:id')
  @HttpCode(200)
  updateAdmin(@Param('id') id: string, @Body() body: { name?: string; role?: 'admin' | 'super_admin'; is_active?: boolean }) {
    return this.svc.updateAdmin(id, body);
  }

  @UseGuards(SuperAdminGuard)
  @Delete('admins')
  @HttpCode(200)
  removeAdmin(@Query('id') id: string, @Body() body?: { id?: string }) {
    return this.svc.removeAdmin(id ?? body?.id ?? '');
  }

  // ── Super admins (super admin only) ────────────────────────────────────────
  @UseGuards(SuperAdminGuard)
  @Get('super-admins')
  listSuperAdmins() {
    return this.svc.listSuperAdmins();
  }

  @UseGuards(SuperAdminGuard)
  @Post('super-admins')
  @HttpCode(200)
  addSuperAdmin(@Body() body: { email: string }) {
    return this.svc.addSuperAdmin(body.email);
  }

  @UseGuards(SuperAdminGuard)
  @Delete('super-admins')
  @HttpCode(200)
  deleteSuperAdmin(@Query('email') email: string, @Body() body?: { email?: string }) {
    return this.svc.deleteSuperAdmin(email ?? body?.email ?? '');
  }

  // ── Config (super admin only) ──────────────────────────────────────────────
  @UseGuards(AdminGuard)
  @Put('config')
  @HttpCode(200)
  upsertConfig(@Body() body: { key: string; value: unknown }) {
    return this.svc.upsertConfig(body.key, body.value);
  }

  // ── Broadcast email (super admin only) ─────────────────────────────────────
  @UseGuards(SuperAdminGuard)
  @Post('email/send')
  @HttpCode(200)
  sendEmail(@Body() body: { target: 'one' | 'all' | 'custom'; email?: string; emails?: string[]; subject: string; message: string; html?: boolean }) {
    return this.svc.sendBroadcastEmail(body);
  }

  // ── Chat DM antar admin/super-admin ────────────────────────────────────────
  /** Daftar kontak: super→semua admin, admin→super-admin saja. */
  @UseGuards(SuperAdminGuard)
  @Get('chat/contacts')
  async chatContacts(@Request() req) {
    const { isSuperAdmin } = await this.svc.getMe(req.user.email);
    return this.svc.listChatContacts({ email: req.user.email, isSuper: isSuperAdmin });
  }

  /** Pesan dalam percakapan dengan ?with=<email> (&after=<id> untuk polling). */
  @UseGuards(SuperAdminGuard)
  @Get('chat')
  chatConversation(@Request() req, @Query('with') withEmail: string, @Query('after') after?: string) {
    return this.svc.getConversation(req.user.email, withEmail ?? '', after ? parseInt(after, 10) || 0 : 0);
  }

  @UseGuards(SuperAdminGuard)
  @Post('chat')
  @HttpCode(200)
  async sendChat(@Request() req, @Body() body: { to: string; content: string }) {
    const { isSuperAdmin } = await this.svc.getMe(req.user.email);
    return this.svc.sendDm({ email: req.user.email, isSuper: isSuperAdmin }, body.to, body.content);
  }

  @UseGuards(SuperAdminGuard)
  @Delete('chat/:id')
  @HttpCode(200)
  async deleteChat(@Request() req, @Param('id') id: string) {
    const { isSuperAdmin } = await this.svc.getMe(req.user.email);
    return this.svc.deleteChat(parseInt(id, 10), { email: req.user.email, isSuper: isSuperAdmin });
  }

  // ── Masa aktif admin (super-admin only) ────────────────────────────────────
  @UseGuards(SuperAdminGuard)
  @Post('period')
  @HttpCode(200)
  setPeriod(@Body() body: { email: string; days: number }) {
    return this.svc.setUserPeriod(body.email, Number(body.days) || 0);
  }

  // ── Status sistem ──────────────────────────────────────────────────────────
  /**
   * Ringkasan hidup/mati layanan penopang, untuk kartu pantauan di halaman
   * profil. SuperAdminGuard bukan sekadar formalitas: jawabannya memuat IP
   * keluar proxy dan pesan galat mentah — bahan yang tak perlu dilihat admin
   * biasa, apalagi pengguna.
   */
  @UseGuards(SuperAdminGuard)
  @Get('system-status')
  systemStatus() {
    return this.svc.systemStatus();
  }

  // ── Standing & reaktivasi ──────────────────────────────────────────────────
  /** Standing admin saat ini (masa aktif, jumlah user, biaya, request pending). */
  @UseGuards(SuperAdminGuard)
  @Get('standing')
  standing(@Request() req) {
    return this.svc.getMyStanding(req.user.email);
  }

  /** Admin biasa mengajukan reaktivasi (paket 7/14/30 hari). */
  @UseGuards(SuperAdminGuard)
  @Post('reactivation/request')
  @HttpCode(200)
  requestReactivation(@Request() req, @Body() body: { days: number }) {
    return this.svc.requestReactivation(req.user.email, Number(body.days) || 0);
  }

  /** Super-admin: daftar permintaan reaktivasi. */
  @UseGuards(SuperAdminGuard)
  @Get('reactivation/requests')
  listReactivation() {
    return this.svc.listReactivationRequests();
  }

  /** Super-admin ACCEPT + tetapkan nominal → status menunggu pembayaran. */
  @UseGuards(SuperAdminGuard)
  @Post('reactivation/approve')
  @HttpCode(200)
  approveReactivation(@Request() req, @Body() body: { id: number; amount: number }) {
    return this.svc.approveReactivation(Number(body.id), req.user.email, Number(body.amount) || 0);
  }

  /** Super-admin konfirmasi pembayaran diterima → reaktivasi diterapkan. */
  @UseGuards(SuperAdminGuard)
  @Post('reactivation/confirm-payment')
  @HttpCode(200)
  confirmReactivationPayment(@Request() req, @Body() body: { id: number }) {
    return this.svc.confirmReactivationPayment(Number(body.id), req.user.email);
  }

  @UseGuards(SuperAdminGuard)
  @Post('reactivation/reject')
  @HttpCode(200)
  rejectReactivation(@Request() req, @Body() body: { id: number }) {
    return this.svc.rejectReactivation(Number(body.id), req.user.email);
  }
}
