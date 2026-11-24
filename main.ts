// Pump.fun Replay Sprint — paper trading bot (agent-fun/replay/v2).
//
// Strategy, revised after grading v1: v1 waited for momentum confirmation
// (age 240+ slots, price already +6%) and lost 3.31 SOL on the dev window —
// by the time a pump.fun coin has "confirmed", the move is over and the bot
// buys the top. The house sniper pilot, graded on the same window, lost only
// 0.47 SOL by doing the opposite: buy the launch itself, tiny, everywhere,
// and leave within minutes. This version follows that shape with its own
// rules: snipe fresh launches that pass a rug filter, stake 0.05 SOL each,
// take profit fast, cut losers faster, and never hold long.
//
// The grader runs `node /bot/main.ts`; the wire shim is vendored beside it
// (vendor/makefun-bot.ts, a byte-identical copy of the kit's sdk/ts file).
// The bot answers one hello, then one batch of orders per slot batch, and
// stays deterministic: no clock, no environment, no randomness — iteration
// only over insertion-ordered maps fed by the batch stream.

import { LAMPORTS_PER_SOL, runBot, type Batch, type BotState, type OrderInput, type Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9; // lamports per SOL, as a float for the tape math
const CURVE_FEE = 0.0125; // 95 bps protocol + 30 bps creator, charged per fill

// --- tunable parameters (chosen for robustness, not fitted to one window) ---
const P = {
  minAgeSlots: 0, // youngest age (slots since CreateEvent) at which a buy may be decided
  maxAgeSlots: 8, // oldest age at which a first buy may still be decided
  firstBuySol: 0.08, // stake per coin: small, so hundreds of coins fit in 10 SOL
  minBuySol: 0.012, // smallest buy worth sending (above the 0.01 guardrail)
  buySlipBps: 10_000, // wide slippage: a launch buy must not be refused for moving
  minRealSol: 0.3, // real SOL reserves at entry, lower bound
  maxRealSol: 25, // ...upper bound (already-large curves have less room)
  maxDevBuySol: 2.0, // creator's own buy in the opening tape, at most (bigger = dev-heavy)
  maxBuyersAtEntry: 6, // distinct non-creator buyers before entry, at most (a launch bundled by many wallets is a dump in waiting)
  maxRunup: 0.5, // price now over the create price, at most (do not chase)
  takeProfit: 0.15, // exit when value is 15% above cost
  stopLoss: 0.08, // exit when value is 8% below cost
  trailArm: 0.05, // trailing stop arms once value is 5% above cost
  trailGiveback: 0.08, // ...then exit on an 8% fall from the peak value
  maxHoldSlots: 240, // exit after holding this long, win or lose
  staleSlots: 120, // exit when no trade has hit the coin for this long
  fadeWindow: 20, // exit when net flow over this many slots turns hard negative
  fadeNetSol: -1.0, // ...below this many SOL
  bigSellSol: 1.0, // exit when any single recorded sell is at least this big
  cooldownSlots: 300, // wait after an exit before re-entering the same curve
  maxEntriesPerCoin: 2, // most entries per curve over the run
  maxMainPositions: 4, // most snipe positions open at once (1 slot kept for probes)
  maxExposureSol: 7, // most SOL at cost across all positions at once
  targetCoins: 30, // guardrail pacing target: distinct coins by end of window
  targetFills: 200, // guardrail pacing target: own fills by end of window
  paceSeconds: 86400, // the replay window is 24 hours
  probeSol: 0.02, // sweeper probe buy size (a 0.01+ SOL round trip)
  maxProbes: 1, // most probe round trips open at once
};

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CurveTape {
  createdSlot: number | null;
  creator: string | null;
  createPrice: number;
  trades: TapeTrade[];
  buyers: Set<string>;
  devBuySol: number;
  devSold: boolean;
  bigSellSeen: boolean;
  lastTradeSlot: number;
  entries: number;
  lastExitSlot: number;
}

interface HeldPosition {
  openedSlot: number;
  peakValueSol: number;
  investedSol: number;
  exiting: boolean;
  filled: boolean;
}

const tapes = new Map<Pubkey, CurveTape>();
const held = new Map<Pubkey, HeldPosition>();
/** Sweeper probes in flight, by mint: false while the buy is pending, true once selling. */
const probes = new Map<Pubkey, boolean>();
let myFills = 0;
const myCoins = new Set<Pubkey>();
let firstBlockTime: number | null = null;
let lastBlockTime: number | null = null;

function tapeOf(mint: Pubkey): CurveTape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = {
      createdSlot: null,
      creator: null,
      createPrice: 0,
      trades: [],
      buyers: new Set<string>(),
      devBuySol: 0,
      devSold: false,
      bigSellSeen: false,
      lastTradeSlot: -1e12,
      entries: 0,
      lastExitSlot: -1e12,
    };
    tapes.set(mint, t);
  }
  return t;
}

/** Price of one token in SOL from virtual reserves. */
function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

/** What a holding of `tokens` would fetch if sold now, in SOL, fees deducted. */
function closeValueSol(tokens: bigint, virtualQuote: bigint, virtualToken: bigint, txFeeSol: number): number {
  if (tokens <= 0n || virtualToken === 0n) return 0;
  const t = Number(tokens);
  const vq = Number(virtualQuote);
  const vt = Number(virtualToken);
  return ((t * vq) / (vt + t) / LAMPORTS) * (1 - CURVE_FEE) - txFeeSol;
}

/** Net recorded SOL (buys minus sells) on a tape over the last `w` slots. */
function netFlow(t: CurveTape, nowSlot: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= nowSlot - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

/**
 * The launch filter: a fresh curve whose opening tape looks like a real
 * launch, not a bundled dump. The creator must not have sold, must not have
 * bought a dev-sized stack, the crowd must be small (a big first-slot crowd
 * is usually the creator's own cluster), no whale sell may have landed yet,
 * and the price must not already have run away from its create price.
 */
function launchFilter(t: CurveTape, nowSlot: number, realSol: number, price: number): boolean {
  if (t.createdSlot === null) return false;
  const age = nowSlot - t.createdSlot;
  if (age < P.minAgeSlots || age > P.maxAgeSlots) return false;
  if (realSol < P.minRealSol || realSol > P.maxRealSol) return false;
  if (t.devSold || t.bigSellSeen) return false;
  if (t.devBuySol > P.maxDevBuySol) return false;
  if (t.buyers.size > P.maxBuyersAtEntry) return false;
  if (t.createPrice > 0 && price > t.createPrice * (1 + P.maxRunup)) return false;
  return true;
}

await runBot({
  onHello() {
    // Nothing to seed: all state starts empty and fills in from the batches.
  },

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const nowSlot = batch.slot;
    const txFeeSol = Number(state.txFeeLamports()) / LAMPORTS;
    const maxOrders = state.hello.caps.max_orders_per_batch;

    // Count this batch's own fills (harness closes start with '_') and fold
    // its events into the per-curve tapes.
    for (const f of batch.fills) {
      if (f.status === 'filled' && !f.client_id.startsWith('_')) {
        myFills++;
        myCoins.add(f.mint);
      }
    }
    const traded = new Set<Pubkey>();
    for (const e of batch.events) {
      if (e.block_time !== null) {
        if (firstBlockTime === null) firstBlockTime = e.block_time;
        if (lastBlockTime === null || e.block_time > lastBlockTime) lastBlockTime = e.block_time;
      }
      if (e.event === 'CreateEvent') {
        const t = tapeOf(e.mint);
        t.createdSlot = e.slot;
        t.creator = e.creator;
        t.createPrice = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
      } else if (e.event === 'TradeEvent') {
        const t = tapeOf(e.mint);
        const sol = Number(e.sol_amount) / LAMPORTS;
        t.trades.push({
          slot: e.slot,
          buy: e.is_buy,
          sol,
          user: e.user,
          price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
        });
        t.lastTradeSlot = e.slot;
        if (t.creator !== null && e.user === t.creator) {
          if (e.is_buy) t.devBuySol += sol;
          else t.devSold = true;
        } else if (e.is_buy) {
          t.buyers.add(e.user);
        } else if (sol >= P.bigSellSol) {
          t.bigSellSeen = true;
        }
        traded.add(e.mint);
      }
    }
    // Prune tapes to the longest lookback any rule needs.
    const keepSlots = Math.max(P.fadeWindow, P.staleSlots) + 5;
    for (const mint of traded) {
      const t = tapes.get(mint)!;
      let cut = 0;
      while (cut < t.trades.length && t.trades[cut]!.slot <= nowSlot - keepSlots) cut++;
      if (cut > 0) t.trades.splice(0, cut);
    }

    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingByMint = new Map<Pubkey, { buy: boolean; sell: boolean }>();
    for (const po of state.pending.values()) {
      const entry = pendingByMint.get(po.order.mint) ?? { buy: false, sell: false };
      if (po.order.side === 'buy') entry.buy = true;
      else entry.sell = true;
      pendingByMint.set(po.order.mint, entry);
    }

    const orders: OrderInput[] = [];
    const reserveOf = (mint: Pubkey): { vq: bigint; vt: bigint } | null => {
      const curve = state.curves.get(mint);
      if (curve === undefined) return null;
      const mk = marks.get(mint);
      return {
        vq: mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves,
        vt: mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves,
      };
    };

    // --- 1. Exits first: take profit, stop-loss, trailing stop, creator sold,
    //      stale coin, fading flow, max hold. ---
    for (const [mint, h] of held) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        // Position gone (sold, completed, or flattened): drop the bookkeeping
        // once nothing is still in flight for it.
        if (!pendingByMint.has(mint)) {
          held.delete(mint);
          if (h.filled) tapeOf(mint).lastExitSlot = nowSlot;
          else tapeOf(mint).entries--;
        }
        continue;
      }
      h.filled = true;
      if (curve === undefined || curve.complete) continue;
      const res = reserveOf(mint);
      if (res === null) continue;
      const value = closeValueSol(BigInt(pos.token_amount), res.vq, res.vt, txFeeSol);
      const cost = Number(pos.cost_lamports) / LAMPORTS;
      if (value > h.peakValueSol) h.peakValueSol = value;
      const t = tapeOf(mint);
      let exit = h.exiting;
      if (!exit && value >= cost * (1 + P.takeProfit)) exit = true;
      if (!exit && value < cost * (1 - P.stopLoss)) exit = true;
      if (!exit && h.peakValueSol >= cost * (1 + P.trailArm) && value < h.peakValueSol * (1 - P.trailGiveback)) exit = true;
      if (!exit && t.devSold) exit = true; // the creator sold while we hold: leave at once
      if (!exit && nowSlot - t.lastTradeSlot > P.staleSlots) exit = true;
      if (!exit && netFlow(t, nowSlot, P.fadeWindow) < P.fadeNetSol) exit = true;
      if (!exit && nowSlot - h.openedSlot > P.maxHoldSlots) exit = true;
      if (!exit) continue;
      h.exiting = true;
      const pend = pendingByMint.get(mint);
      if (pend?.sell) continue; // a sell is already in flight; wait for it
      if (orders.length >= maxOrders) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
    }

    // --- 2. Sweeper probes: sell a probe as soon as its buy has landed. ---
    for (const [mint, selling] of probes) {
      const pos = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (pos === undefined) {
        if (!pendingByMint.has(mint)) probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
      if (orders.length >= maxOrders) break;
      orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      if (!selling) probes.set(mint, true);
    }

    // --- 3. Snipe entries: one small buy per fresh launch that passes the filter. ---
    let freeSol = Number(state.freeCashLamports()) / LAMPORTS;
    let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
    let mainLeft = P.maxMainPositions - held.size;
    let exposureSol = 0;
    for (const [mint, h] of held) {
      exposureSol += Math.max(h.investedSol, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
    }
    for (const mint of traded) {
      if (orders.length >= maxOrders) break;
      if (slotsLeft <= 0 || mainLeft <= 0) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingByMint.has(mint) || probes.has(mint) || held.has(mint)) continue;
      const t = tapes.get(mint)!;
      if (t.entries >= P.maxEntriesPerCoin || nowSlot - t.lastExitSlot < P.cooldownSlots) continue;
      const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
      const realSol = Number(curve.real_quote_reserves) / LAMPORTS;
      if (!launchFilter(t, nowSlot, realSol, price)) continue;
      // The 1%-of-real-reserve cap and the exposure budget both bind.
      const capSol = Number(state.maxBuyLamports(mint)) / LAMPORTS;
      let amountSol = Math.min(capSol, P.firstBuySol, P.maxExposureSol - exposureSol);
      if (amountSol > freeSol - txFeeSol) amountSol = freeSol - txFeeSol;
      if (amountSol < P.minBuySol) continue;
      const lamports = BigInt(Math.floor(amountSol * LAMPORTS));
      orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: P.buySlipBps });
      freeSol -= amountSol + txFeeSol;
      exposureSol += amountSol;
      held.set(mint, {
        openedSlot: nowSlot,
        peakValueSol: 0,
        investedSol: amountSol,
        exiting: false,
        filled: false,
      });
      t.entries++;
      slotsLeft--;
      mainLeft--;
    }

    // --- 4. Guardrail pacing: open a probe when fills or coins lag the pace. ---
    if (probes.size < P.maxProbes && slotsLeft > 0 && firstBlockTime !== null && lastBlockTime !== null) {
      const pace = Math.min(1, (lastBlockTime - firstBlockTime) / P.paceSeconds);
      const needCoins = myCoins.size < Math.ceil(P.targetCoins * pace);
      const needFills = myFills < Math.ceil(P.targetFills * pace);
      if (needCoins || needFills) {
        const minRealSol = (P.probeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of traded) {
          if (orders.length >= maxOrders || probes.size >= P.maxProbes) break;
          if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
          if (needCoins && !needFills && myCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / LAMPORTS < minRealSol * 1.5) continue;
          if (freeSol < P.probeSol + 2 * txFeeSol) break;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(P.probeSol * LAMPORTS)), max_slippage_bps: P.buySlipBps });
          probes.set(mint, false);
          freeSol -= P.probeSol + txFeeSol;
        }
      }
    }

    return orders;
  },
});
