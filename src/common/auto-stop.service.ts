import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { SupabaseService } from '../supabase/supabase.service';
import { ScheduleService } from '../schedule/schedule.service';
import { FastradeService } from '../fastrade/fastrade.service';
import { AISignalService } from '../aisignal/aisignal.service';
import { IndicatorService } from '../indicator/indicator.service';
import { MomentumService } from '../momentum/momentum.service';

// ── Auto-stop mode yang berjalan terlalu lama ────────────────────────────────
// User yang start mode dibatasi maksimal AUTO_STOP_MAX_HOURS (default 24 jam).
// Sweep tiap 5 menit: baca tabel *_status (bot_state=RUNNING), hitung umur dari
// started_at (fallback updated_at = waktu transisi ke RUNNING), lewat batas →
// panggil method stop resmi service ybs (perilaku sama seperti user menekan
// Stop), lalu paksa baris status ke STOPPED (menyembuhkan baris stale yang
// tidak punya state in-memory, mis. sisa sebelum restart).

const MAX_RUN_HOURS = Number(process.env.AUTO_STOP_MAX_HOURS ?? 24);
const SWEEP_INTERVAL_MS = 5 * 60_000;

@Injectable()
export class AutoStopService {
  private readonly logger = new Logger(AutoStopService.name);
  private sweeping = false;

  constructor(
    private readonly supabaseService: SupabaseService,
    private readonly scheduleService: ScheduleService,
    private readonly fastradeService: FastradeService,
    private readonly aiSignalService: AISignalService,
    private readonly indicatorService: IndicatorService,
    private readonly momentumService: MomentumService,
  ) {}

  private get targets(): { table: string; label: string; stop: (userId: string) => Promise<unknown> }[] {
    return [
      { table: 'schedule_status',  label: 'Schedule',  stop: (u) => this.scheduleService.stopSchedule(u) },
      { table: 'fastrade_status',  label: 'Fastrade',  stop: (u) => this.fastradeService.stop(u) },
      { table: 'aisignal_status',  label: 'AI Signal', stop: (u) => this.aiSignalService.stopAISignalMode(u) },
      { table: 'indicator_status', label: 'Indicator', stop: (u) => this.indicatorService.stopIndicatorMode(u) },
      { table: 'momentum_status',  label: 'Momentum',  stop: (u) => this.momentumService.stopMomentumMode(u) },
    ];
  }

  @Interval(SWEEP_INTERVAL_MS)
  async sweep(): Promise<void> {
    if (MAX_RUN_HOURS <= 0) return; // 0/negatif = fitur dimatikan via env
    if (this.sweeping) return;      // guard re-entrant (stop bisa lambat)
    this.sweeping = true;
    try {
      const cutoff = Date.now() - MAX_RUN_HOURS * 3_600_000;

      for (const { table, label, stop } of this.targets) {
        const { data, error } = await this.supabaseService.client
          .from(table)
          .select('*')
          .eq('bot_state', 'RUNNING');
        if (error) {
          // Tabel bisa belum ada di DB (mis. momentum_status) — jangan berisik.
          if (!/could not find the table/i.test(error.message)) {
            this.logger.warn(`[AutoStop] ${table}: ${error.message}`);
          }
          continue;
        }

        for (const row of (data ?? []) as Record<string, any>[]) {
          const userId = String(row.user_id ?? '');
          if (!userId) continue;
          const startedRaw = row.started_at ?? row.updated_at;
          const startedMs = startedRaw ? Date.parse(startedRaw) : NaN;
          if (!Number.isFinite(startedMs) || startedMs >= cutoff) continue;

          const hours = ((Date.now() - startedMs) / 3_600_000).toFixed(1);
          this.logger.warn(
            `[AutoStop] [${userId}] ${label} berjalan ${hours} jam (batas ${MAX_RUN_HOURS} jam) → auto-stop`,
          );
          try {
            await stop(userId);
          } catch (err: any) {
            this.logger.error(`[AutoStop] [${userId}] ${label} stop error: ${err?.message}`);
          }
          // Paksa STOPPED — menutup kasus stop() no-op karena tak ada state
          // in-memory (baris stale). Aman: hanya baris yang masih RUNNING.
          try {
            await this.supabaseService.client
              .from(table)
              .update({ bot_state: 'STOPPED', updated_at: this.supabaseService.now() })
              .eq('user_id', row.user_id)
              .eq('bot_state', 'RUNNING');
          } catch { /* baris sudah diurus stop() */ }
        }
      }
    } finally {
      this.sweeping = false;
    }
  }
}
