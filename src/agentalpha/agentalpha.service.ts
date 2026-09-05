import { Injectable, Logger } from '@nestjs/common';
import { SupabaseService } from '../supabase/supabase.service';
import { AuthService } from '../auth/auth.service';
import { StockityWebSocketClient } from '../schedule/websocket-client';
import { curlGet } from '../common/http-utils';
import { v4 as uuidv4 } from 'uuid';
import { bulatkanAmountMartingale, galatOrderPermanen } from '../common/martingale-amount';
import { NotifyService } from '../common/notify.service';

const BASE_URL = 'https://api.stockity1.id';

// ─────────────────────────────────────────────────────────────────────────────
// AGENT ALPHA — mode kejar-balik arah (reversal chase), TANPA martingale searah.
//
// Alur (1 siklus):
//   1. Di awal menit: Entry-1 mengikuti arah candle 1-menit sebelumnya (turbo 1m).
//   2. 15 detik setelah SETIAP entry: bandingkan harga sekarang vs harga entry itu.
//        • sisi KALAH  → buka entry baru arah BERLAWANAN, nominal ×1.5 (bulat 100).
//        • sisi MENANG → berhenti membuka entry, tunggu entry terakhir tutup = WIN.
//   3. Tanpa batas jumlah entry, tapi AUTO-STOP bila saldo tak cukup entry berikut.
//   4. Setelah entry terakhir tutup → siklus reset, entry-1 baru dari candle berikut.
//
// Gandaan 1.5× MELEKAT pada mode (bukan setting martingale user).
// ─────────────────────────────────────────────────────────────────────────────

const MULTIPLIER = 1.5;         // gandaan tiap entry balik-arah
const CHECK_AFTER_MS = 15_000;  // cek 15 detik setelah tiap entry

type Trend = 'call' | 'put';

interface AlphaCfg {
  asset: { ric: string; name: string };
  baseAmount: number;
  isDemoAccount: boolean;
  currency?: string;
}

interface AlphaEntry {
  orderId: string;
  dealId: string | null;
  trend: Trend;
  amount: number;
  entryPrice: number | null;
  placedAt: number;
  expireAtMs: number;
}

interface AlphaLog {
  id: string; orderId: string; dealId?: string | null;
  trend: string; amount: number; martingaleStep: number;
  executedAt: number; result?: string; profit?: number; note?: string;
}

interface AlphaState {
  isRunning: boolean;
  ws: StockityWebSocketClient;
  session: any;
  cfg: AlphaCfg;
  deals: Map<string, AlphaEntry>;     // dealId → entry (menunggu hasil)
  chase: {
    lastEntry: AlphaEntry;
    nextAmount: number;
    step: number;                     // jumlah pembalikan (0 = entry pertama)
    stopHunting: boolean;             // sudah di sisi menang → tunggu tutup
    checkTimer: ReturnType<typeof setTimeout> | null;
  } | null;
  totalExecutions: number;
  totalWins: number;
  totalLosses: number;
  sessionPnL: number;
  logs: AlphaLog[];
  loopTimer: ReturnType<typeof setTimeout> | null;
  lastCycleMinute: number;
  placing: boolean;                   // guard re-entrant saat menaruh order
  carryLossAmount: number | null;     // siklus lalu KALAH → entry-1 siklus baru = ×2 nominal ini (null = reset ke base)
  priceCache: { price: number | null; candles: any[]; ts: number };  // cache harga (poller latar)
  balCache: { bal: number | null; ts: number };                       // cache saldo
  pollTimer: ReturnType<typeof setInterval> | null;
}

@Injectable()
export class AgentAlphaService {
  private readonly logger = new Logger('AgentAlphaService');
  private active = new Map<string, AlphaState>();

  constructor(
    private readonly supabase: SupabaseService,
    private readonly auth: AuthService,
  ) {}

  // ── START / STOP ───────────────────────────────────────────────────────────
  async start(userId: string, cfg: AlphaCfg): Promise<{ message: string; status: string }> {
    if (this.active.get(userId)?.isRunning) return { message: 'Agent Alpha sudah berjalan', status: 'RUNNING' };
    if (!cfg?.asset?.ric) throw new Error('Asset belum dikonfigurasi');
    if (!cfg.baseAmount || cfg.baseAmount < 100) throw new Error('Nominal minimal 100');

    const session = await this.auth.getSession(userId);
    if (!session) throw new Error('Session tidak ditemukan');

    // Gerbang aktivasi BERBAYAR (server-side) — Agent Alpha berjalan penuh di
    // server, jadi kunci di sini biar tak bisa ditembus lewat API langsung.
    if (!(await this.isAgentAlphaAllowed(userId, session))) {
      throw new Error('Agent Alpha belum diaktivasi untuk akun ini');
    }

    const ws = new StockityWebSocketClient(
      userId, session.stockity_token, session.device_id, session.device_type || 'web', session.user_agent,
    );
    ws.setOnDealResult((p) => this.onDealResult(userId, p).catch((e) => this.logger.error(`[${userId}] deal result: ${e.message}`)));
    try { await ws.connect(); } catch (e: any) { ws.disconnect(); throw new Error(`Gagal koneksi WebSocket: ${e.message}`); }

    const state: AlphaState = {
      isRunning: true, ws, session, cfg,
      deals: new Map(), chase: null,
      totalExecutions: 0, totalWins: 0, totalLosses: 0, sessionPnL: 0,
      logs: [], loopTimer: null, lastCycleMinute: -1, placing: false, carryLossAmount: null,
      priceCache: { price: null, candles: [], ts: 0 }, balCache: { bal: null, ts: 0 }, pollTimer: null,
    };
    this.active.set(userId, state);
    await this.updateStatus(userId, 'RUNNING');
    this.logger.log(`[${userId}] Agent Alpha started (asset=${cfg.asset.ric} base=${cfg.baseAmount} demo=${cfg.isDemoAccount})`);
    this.startPricePoller(userId);
    this.startLoop(userId);
    return { message: 'Agent Alpha dimulai', status: 'RUNNING' };
  }

  /**
   * Cek hak akses Agent Alpha (fitur berbayar Rp 850rb).
   *  1. Admin / super admin (by email di sesi) → selalu boleh.
   *  2. Peta app_config 'agentalpha_access' = { "<user_id>": expiresAt } → aktif
   *     bila expiresAt > sekarang.
   * FAIL-OPEN saat gangguan infra supaya user sah tak terkunci sesaat.
   */
  private async isAgentAlphaAllowed(userId: string, session: any): Promise<boolean> {
    const db = this.supabase.client;
    try {
      const email = String(session?.email ?? '').toLowerCase().trim();
      if (email) {
        const [{ data: adm }, { data: sup }] = await Promise.all([
          db.from('admin_users').select('email').eq('email', email).eq('is_active', true).maybeSingle(),
          db.from('super_admins').select('email').eq('email', email).maybeSingle(),
        ]);
        if (adm || sup) return true;
      }
      const { data } = await db.from('app_config').select('value').eq('key', 'agentalpha_access').maybeSingle();
      if (!data?.value) return false;
      const v = typeof data.value === 'string' ? JSON.parse(data.value) : data.value;
      const uid = String(userId).trim();
      // TAHAN SEMUA BENTUK: array lama (id=aktif selamanya) atau { id: expiresAt }.
      if (Array.isArray(v)) return v.map((x) => String(x).trim()).includes(uid);
      if (!v || typeof v !== 'object') return false;
      const exp = Number(v[uid]);
      return Number.isFinite(exp) && exp > Date.now();
    } catch (e) {
      this.logger.warn(`[${userId}] cek akses agentalpha gagal (fail-open): ${e}`);
      return true;
    }
  }

  async stop(userId: string): Promise<{ message: string }> {
    const state = this.active.get(userId);
    if (!state?.isRunning) return { message: 'Agent Alpha tidak berjalan' };
    state.isRunning = false;
    if (state.loopTimer) clearTimeout(state.loopTimer);
    if (state.pollTimer) clearInterval(state.pollTimer);
    if (state.chase?.checkTimer) clearTimeout(state.chase.checkTimer);
    try { state.ws.disconnect(); } catch { /* abaikan */ }
    this.active.delete(userId);
    await this.updateStatus(userId, 'STOPPED');
    this.logger.log(`[${userId}] Agent Alpha stopped`);
    return { message: 'Agent Alpha dihentikan' };
  }

  // ── LOOP: mulai siklus baru di awal menit bila tak ada chase aktif ───────────
  private startLoop(userId: string) {
    const tick = async () => {
      const state = this.active.get(userId);
      if (!state?.isRunning) return;
      try {
        const sec = new Date().getSeconds();
        const minute = Math.floor(Date.now() / 60_000);
        if (!state.chase && !state.placing && sec < 2 && minute !== state.lastCycleMinute) {
          state.lastCycleMinute = minute;
          await this.startCycle(userId);
        }
      } catch (e: any) { this.logger.error(`[${userId}] loop: ${e.message}`); }
      const s = this.active.get(userId);
      if (s?.isRunning) s.loopTimer = setTimeout(tick, 400);
    };
    const state = this.active.get(userId);
    if (state) state.loopTimer = setTimeout(tick, 400);
  }

  private async startCycle(userId: string) {
    const state = this.active.get(userId);
    if (!state?.isRunning || state.chase) return;
    const dir = await this.prevCandleDirection(state); // ikut candle sebelumnya
    if (!dir) { this.logger.warn(`[${userId}] arah candle belum terbaca — lewati siklus`); return; }
    // Siklus lalu KALAH → entry-1 = ×2 nominal order yang kalah; menang/awal → base.
    const base = state.carryLossAmount != null ? state.carryLossAmount * 2 : state.cfg.baseAmount;
    const amount = bulatkanAmountMartingale(base);
    if (state.carryLossAmount != null) {
      this.logger.log(`[${userId}] Entry-1 siklus baru = ×2 dari loss sebelumnya (${state.carryLossAmount} → ${amount})`);
    }
    await this.placeEntry(userId, dir, amount, true);
  }

  // ── Menaruh satu entry (entry-1 atau balik-arah) ─────────────────────────────
  private async placeEntry(userId: string, trend: Trend, amountRaw: number, isFirst: boolean) {
    const state = this.active.get(userId);
    if (!state?.isRunning || state.placing) return;
    state.placing = true;
    try {
      const amount = bulatkanAmountMartingale(amountRaw);

      // Guard saldo — auto-stop bila tak cukup untuk entry ini.
      const bal = await this.fetchBalance(state);
      if (bal != null && bal < amount) {
        this.logger.warn(`[${userId}] Saldo ${bal} < ${amount} — bot dihentikan`);
        NotifyService.botBerhenti(userId, 'Agent Alpha', 'Saldo tidak cukup untuk entry berikutnya');
        await this.stop(userId);
        return;
      }

      const entryPrice = await this.currentPrice(state);
      const orderId = uuidv4();
      const payload = this.buildTurbo(state, amount, trend);
      const res = await state.ws.placeTrade(payload as any);

      const sebabHenti = galatOrderPermanen(res.error);
      if (sebabHenti) {
        this.logger.error(`[${userId}] ❌ ${sebabHenti} — bot dihentikan`);
        NotifyService.botBerhenti(userId, 'Agent Alpha', sebabHenti);
        await this.stop(userId);
        return;
      }

      const step = state.chase ? state.chase.step + 1 : 0;
      state.totalExecutions++;
      const entry: AlphaEntry = { orderId, dealId: res.dealId ?? null, trend, amount, entryPrice, placedAt: Date.now(), expireAtMs: (payload as any).expireAt * 1000 };
      if (res.dealId) state.deals.set(res.dealId, entry);

      this.appendLog(userId, {
        id: orderId, orderId, dealId: res.dealId, trend, amount, martingaleStep: step,
        executedAt: entry.placedAt,
        note: isFirst
          ? (state.carryLossAmount != null ? 'Entry-1 ×2 (loss siklus sebelumnya)' : 'Entry-1 (ikut candle sebelumnya)')
          : `Balik arah #${step} (×1.5)`,
      });
      this.logger.log(`[${userId}] Entry ${isFirst ? '1' : '#' + step} ${trend} amount=${amount} price=${entryPrice ?? '?'} deal=${res.dealId ?? 'gagal'}`);

      // Set/replace chase → jadwalkan cek 15 detik setelah entry ini.
      if (state.chase?.checkTimer) clearTimeout(state.chase.checkTimer);
      state.chase = {
        lastEntry: entry,
        nextAmount: bulatkanAmountMartingale(amount * MULTIPLIER),
        step,
        stopHunting: false,
        checkTimer: setTimeout(() => this.checkChase(userId).catch((e) => this.logger.error(`[${userId}] checkChase: ${e.message}`)), CHECK_AFTER_MS),
      };
    } finally {
      const s = this.active.get(userId);
      if (s) s.placing = false;
    }
  }

  // ── Cek 15 detik: kalah → balik lagi; menang → berhenti kejar ────────────────
  private async checkChase(userId: string) {
    const state = this.active.get(userId);
    if (!state?.isRunning || !state.chase || state.chase.stopHunting) return;
    const le = state.chase.lastEntry;
    const price = await this.currentPrice(state);
    if (price == null || le.entryPrice == null) {
      // gagal baca harga → coba lagi sebentar
      if (state.chase) state.chase.checkTimer = setTimeout(() => this.checkChase(userId).catch(() => {}), 2_000);
      return;
    }
    const losing = le.trend === 'call' ? price < le.entryPrice : price > le.entryPrice;
    if (losing) {
      const rev: Trend = le.trend === 'call' ? 'put' : 'call';
      this.logger.log(`[${userId}] Entry #${state.chase.step} sisi KALAH (price=${price} entry=${le.entryPrice}) → balik ${rev}`);
      await this.placeEntry(userId, rev, state.chase.nextAmount, false);
    } else {
      state.chase.stopHunting = true;
      this.logger.log(`[${userId}] Entry #${state.chase.step} sisi MENANG (price=${price} entry=${le.entryPrice}) → berhenti kejar, tunggu tutup`);
      // Fallback: bila hasil WS kelewat, tetap selesaikan siklus setelah order
      // tutup + buffer, supaya loop LANJUT (siklus baru di menit berikutnya).
      if (state.chase.checkTimer) clearTimeout(state.chase.checkTimer);
      const waitMs = Math.max(3_000, (le.expireAtMs - Date.now()) + 9_000);
      state.chase.checkTimer = setTimeout(async () => {
        const st = this.active.get(userId);
        if (st?.isRunning && st.chase?.stopHunting) {
          // Hasil WS kelewat → tebak menang/kalah dari harga terakhir vs entry.
          const le2 = st.chase.lastEntry;
          const p = await this.currentPrice(st).catch(() => null);
          const lost = p != null && le2.entryPrice != null
            ? (le2.trend === 'call' ? p < le2.entryPrice : p > le2.entryPrice)
            : false;
          st.carryLossAmount = lost ? le2.amount : null;
          this.logger.log(`[${userId}] Siklus selesai (fallback timer) hasil≈${lost ? `LOSE → ×2 (${le2.amount})` : 'WIN → reset base'}`);
          st.chase = null;
        }
      }, waitMs);
    }
  }

  // ── Hasil deal via WebSocket (bo:closed / deal_result) ───────────────────────
  private async onDealResult(userId: string, payload: any) {
    const state = this.active.get(userId);
    if (!state) return;
    const dealId = String(payload.uuid ?? payload.id ?? payload.numericId ?? '');
    let entry = state.deals.get(dealId);
    if (!entry) entry = [...state.deals.values()].find((e) => e.dealId && (e.dealId === dealId || e.dealId === String(payload.numericId)));
    if (!entry) return;

    const winAmt = Number(payload.win ?? 0); // sen
    const isWin = /win/i.test(String(payload.result ?? '')) || winAmt > entry.amount * 100;
    const pnl = isWin ? Math.max(0, winAmt / 100 - entry.amount) : -entry.amount; // Rupiah
    state.sessionPnL += pnl;
    if (isWin) state.totalWins++; else state.totalLosses++;
    this.updateLog(userId, entry.orderId, { result: isWin ? 'WIN' : 'LOSE', profit: pnl });
    if (entry.dealId) state.deals.delete(entry.dealId);
    this.logger.log(`[${userId}] Hasil ${isWin ? 'WIN' : 'LOSE'} deal=${dealId} pnl=${pnl} sesi=${state.sessionPnL}`);

    // Kalau ini entry terakhir yang sedang "tunggu tutup" → siklus selesai.
    if (state.chase?.stopHunting && state.chase.lastEntry.dealId === entry.dealId) {
      if (state.chase.checkTimer) clearTimeout(state.chase.checkTimer);
      // Siklus KALAH → simpan nominal order kalah agar entry-1 siklus baru ×2.
      // Siklus MENANG → reset ke base.
      state.carryLossAmount = isWin ? null : entry.amount;
      this.logger.log(`[${userId}] Siklus selesai ${isWin ? 'WIN → reset base' : `LOSE → cycle berikut ×2 (${entry.amount})`}`);
      state.chase = null;
    }
  }

  // ── STATUS / LOGS ────────────────────────────────────────────────────────────
  async getStatus(userId: string): Promise<object> {
    const state = this.active.get(userId);
    if (state) {
      return {
        isRunning: state.isRunning,
        botState: state.isRunning ? 'RUNNING' : 'STOPPED',
        mode: 'agentalpha',
        totalTrades: state.totalExecutions,
        totalWins: state.totalWins,
        totalLosses: state.totalLosses,
        sessionPnL: state.sessionPnL,
        martingaleStep: state.chase?.step ?? 0,
        activeTrend: state.chase?.lastEntry.trend ?? null,
        activeOrderId: state.chase?.lastEntry.dealId ?? null,
        phase: state.chase ? (state.chase.stopHunting ? 'WAITING_RESULT' : 'HUNTING') : 'IDLE',
        wsConnected: state.ws.isConnected(),
      };
    }
    const { data } = await this.supabase.client.from('agentalpha_status').select('bot_state').eq('user_id', userId).maybeSingle();
    return { isRunning: false, botState: data?.bot_state ?? 'STOPPED', mode: 'agentalpha', totalTrades: 0, totalWins: 0, totalLosses: 0, sessionPnL: 0 };
  }

  async getLogs(userId: string, limit = 100): Promise<any[]> {
    // Baca dari mode_logs (PERSISTEN) — riwayat tetap ada walau bot berhenti/restart.
    // (Dulu hanya baca state.logs di-memori → kosong saat bot tak aktif → riwayat hilang.)
    try {
      const { data } = await this.supabase.client
        .from('mode_logs').select('data')
        .eq('user_id', userId).eq('mode', 'AGENT_ALPHA')
        .order('executed_at', { ascending: false }).limit(limit);
      return (data ?? []).map((r: any) => r.data).reverse();
    } catch (e: any) {
      this.logger.warn(`[${userId}] getLogs mode_logs gagal: ${e?.message}`);
      const state = this.active.get(userId);
      return state ? state.logs.slice(-limit) : [];
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────
  private buildTurbo(state: AlphaState, amount: number, trend: Trend) {
    const createdAtSec = Math.floor(Date.now() / 1000) + 1;
    const remaining = 60 - (createdAtSec % 60);
    const expireAt = remaining >= 48 ? createdAtSec + remaining : createdAtSec + remaining + 60;
    return {
      amount: amount * 100, // internal amount = Rupiah; payload Stockity = sen
      createdAt: createdAtSec * 1000,
      dealType: state.cfg.isDemoAccount ? 'demo' : 'real',
      expireAt,
      iso: state.session.currency_iso || state.cfg.currency || 'IDR',
      optionType: 'turbo',
      ric: state.cfg.asset.ric,
      trend,
    };
  }

  private stockityHeaders(session: any): Record<string, string> {
    return {
      'authorization-token': session.stockity_token,
      'device-id': session.device_id,
      'device-type': session.device_type || 'web',
      'User-Agent': session.user_agent || 'Mozilla/5.0',
      'user-timezone': session.user_timezone || 'Asia/Bangkok',
      Accept: 'application/json, text/plain, */*',
      Origin: 'https://stockity1.id',
      Referer: 'https://stockity1.id/',
      'Cache-Control': 'no-cache',
    };
  }

  private candlesUrl(state: AlphaState): string {
    const encoded = state.cfg.asset.ric.replace('/', '%2F');
    const dateForApi = new Date().toISOString().slice(0, 13) + ':00:00';
    return `${BASE_URL}/candles/v1/${encoded}/${dateForApi}/5`;
  }

  // Poller LATAR: refresh harga (candle 5s) tiap 600ms + saldo tiap ~4s, supaya
  // di titik keputusan (cek 15 detik / entry) harga & saldo dibaca INSTAN dari
  // cache — menghilangkan delay fetch 0.5–1 detik. Respon jadi maksimal.
  private startPricePoller(userId: string) {
    const state = this.active.get(userId);
    if (!state) return;
    const tick = async () => {
      const st = this.active.get(userId);
      if (!st?.isRunning) return;
      try {
        const resp: any = await curlGet(this.candlesUrl(st), this.stockityHeaders(st.session), 6);
        const candles: any[] = resp.data?.data;
        if (candles?.length) {
          const sorted = [...candles].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
          const c = parseFloat(sorted[sorted.length - 1].close);
          st.priceCache = { price: isNaN(c) ? st.priceCache.price : c, candles: sorted, ts: Date.now() };
        }
      } catch { /* pertahankan cache lama */ }
      const s2 = this.active.get(userId);
      if (s2?.isRunning && Date.now() - s2.balCache.ts > 4_000) {
        try {
          const b: any = await curlGet(`${BASE_URL}/bank/v1/read?locale=id`, this.stockityHeaders(s2.session), 6);
          const list: any[] = Array.isArray(b.data) ? b.data : b.data?.data ?? [];
          const acc = list.find((d) => d?.account_type === (s2.cfg.isDemoAccount ? 'demo' : 'real'));
          s2.balCache = { bal: acc ? Number(acc.balance ?? 0) / 100 : s2.balCache.bal, ts: Date.now() };
        } catch { /* pertahankan cache lama */ }
      }
    };
    state.pollTimer = setInterval(() => { tick().catch(() => {}); }, 600);
    tick().catch(() => {}); // isi cache segera
  }

  /** Harga terbaru dari cache poller (INSTAN). Fallback fetch bila cache basi. */
  private async currentPrice(state: AlphaState): Promise<number | null> {
    if (state.priceCache.price != null && Date.now() - state.priceCache.ts < 3_000) return state.priceCache.price;
    try {
      const resp: any = await curlGet(this.candlesUrl(state), this.stockityHeaders(state.session), 8);
      const candles: any[] = resp.data?.data;
      if (!candles?.length) return state.priceCache.price;
      const last = [...candles].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))).at(-1);
      const c = parseFloat(last.close);
      return isNaN(c) ? state.priceCache.price : c;
    } catch { return state.priceCache.price; }
  }

  /** Arah candle 1-menit sebelumnya dari cache: naik → call, turun → put. */
  private async prevCandleDirection(state: AlphaState): Promise<Trend | null> {
    let sorted = state.priceCache.candles;
    if (!sorted || sorted.length < 14) {
      try {
        const resp: any = await curlGet(this.candlesUrl(state), this.stockityHeaders(state.session), 8);
        sorted = ((resp.data?.data ?? []) as any[]).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
      } catch { return null; }
    }
    if (!sorted || sorted.length < 14) return null;
    const nowClose = parseFloat(sorted[sorted.length - 1].close);
    const agoClose = parseFloat(sorted[sorted.length - 13].close);
    if (isNaN(nowClose) || isNaN(agoClose)) return null;
    return nowClose >= agoClose ? 'call' : 'put';
  }

  /** Saldo akun aktif dari cache (INSTAN). Fallback fetch bila basi. */
  private async fetchBalance(state: AlphaState): Promise<number | null> {
    if (state.balCache.bal != null && Date.now() - state.balCache.ts < 8_000) return state.balCache.bal;
    try {
      const resp: any = await curlGet(`${BASE_URL}/bank/v1/read?locale=id`, this.stockityHeaders(state.session), 8);
      const list: any[] = Array.isArray(resp.data) ? resp.data : resp.data?.data ?? [];
      const acc = list.find((d) => d?.account_type === (state.cfg.isDemoAccount ? 'demo' : 'real'));
      if (!acc) return state.balCache.bal;
      return Number(acc.balance ?? 0) / 100;
    } catch { return state.balCache.bal; }
  }

  private appendLog(userId: string, log: AlphaLog) {
    const state = this.active.get(userId);
    if (state) {
      state.logs.push(log);
      if (state.logs.length > 500) state.logs.splice(0, state.logs.length - 500);
    }
    // Persist ke mode_logs biar riwayat awet (dibaca getLogs walau bot berhenti).
    this.persistAlphaLog(userId, log).catch((e: any) => this.logger.warn(`[${userId}] persistAlphaLog: ${e?.message}`));
  }

  private async persistAlphaLog(userId: string, log: AlphaLog): Promise<void> {
    await this.supabase.client.from('mode_logs').upsert({
      id: log.id, user_id: userId, mode: 'AGENT_ALPHA', data: log,
      executed_at: this.supabase.timestampFromMillis(log.executedAt),
    }, { onConflict: 'id' });
  }

  private updateLog(userId: string, orderId: string, patch: Partial<AlphaLog>) {
    const state = this.active.get(userId);
    let merged: AlphaLog | undefined;
    if (state) {
      const l = state.logs.find((x) => x.orderId === orderId);
      if (l) { Object.assign(l, patch); merged = l; }
    }
    // Persist hasil (WIN/LOSE, profit) ke mode_logs.
    this.persistAlphaLogUpdate(userId, orderId, patch, merged).catch((e: any) => this.logger.warn(`[${userId}] persistAlphaLogUpdate: ${e?.message}`));
  }

  private async persistAlphaLogUpdate(userId: string, orderId: string, patch: Partial<AlphaLog>, merged?: AlphaLog): Promise<void> {
    let data: any = merged;
    if (!data) {
      const { data: row } = await this.supabase.client.from('mode_logs').select('data').eq('id', orderId).maybeSingle();
      if (!row?.data) return;
      data = { ...(row.data as any), ...patch };
    }
    await this.supabase.client.from('mode_logs').upsert({
      id: orderId, user_id: userId, mode: 'AGENT_ALPHA', data,
      executed_at: this.supabase.timestampFromMillis(data.executedAt),
    }, { onConflict: 'id' });
  }

  private async updateStatus(userId: string, botState: string) {
    const { error } = await this.supabase.client.from('agentalpha_status').upsert({
      user_id: userId, bot_state: botState, updated_at: this.supabase.now(),
    });
    if (error) this.logger.error(`[${userId}] updateStatus: ${error.message}`);
  }
}
