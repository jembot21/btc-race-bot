// Deep-dip snapback bot for the make.fun BTC race (agent-fun/bars-replay/v1).
//
// Strategy, in one paragraph: cbBTC spends most of a day drifting, and its
// sharp drops tend to snap back. This bot waits flat until the latest close
// falls at least DIP_BPS below the trailing MEAN_BARS mean *and* the fall
// has paused (the newest bar no longer closes lower), then buys with most
// of the equity. It sells when the price recovers to its mean or to a
// take-profit band above the entry, trails a stop once the trade is
// comfortably green, cuts the loss at STOP_BPS below the entry, and
// time-stops a trade that goes nowhere. All arithmetic is bigint, no
// clock, no randomness: the same bars always produce the same orders,
// byte for byte.
//
// The wire protocol (hello, one batch per bar, one reply of orders per
// batch) is spoken by the kit's TypeScript shim, vendored unchanged under
// vendor/. This file is only the strategy.

import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';

// Strategy parameters (bps are 1/100 of a percent; bars are one minute).
const MEAN_BARS = 150;       // trailing window of closes the dip is measured against
const DIP_BPS = 160n;        // buy only at least 1.60% below that mean
const LATE_SEQ = 720;        // halfway through the window...
const LATE_DIP_BPS = 90n;    // ...a shallower dip may enter, if none has yet
const SPEND_BPS = 10000n;    // spend all of the equity on an entry
const MAX_IMPACT_BPS = 25n;  // shrink the order if its own price impact is worse
const BUY_SLIP_BPS = 200;    // max_slippage_bps sent with a buy order
const SELL_SLIP_BPS = 200;   // max_slippage_bps sent with a sell order
const TAKE_PROFIT_BPS = 70n; // sell at +0.70% over the entry price
const MEAN_EXIT_MIN_BPS = 100n; // a recovery to the mean sells only if +1.00% or better
const TRAIL_ARM_BPS = 60n;   // the trailing stop arms at +0.60%
const TRAIL_GIVE_BPS = 30n;  // ...and sells 0.30% under the peak since entry
const STOP_BPS = 200n;       // cut the trade at -2.00% under the entry price
const MAX_HOLD_BARS = 300;   // time stop: five hours is long enough
const COOLDOWN_BARS = 20;    // bars to stay flat after a sell before re-entering

/** The strategy's memory: every close seen, and the open trade's marks. */
class Snapback {
  closes: bigint[] = [];        // raw integer closes, oldest first
  entryPx: bigint | null = null; // raw entry price of the open trade
  entrySeq = -1;                 // batch seq at which the position appeared
  peakPx = 0n;                   // highest close since entry
  lastSellSeq = -1_000_000_000;  // seq of the batch the last trade closed on
  enteredOnce = false;           // whether any position has been taken yet

  /** Append this batch's CBBTC close, when the batch carries one. */
  noteBar(batch: { bars: { symbol: string; c: string }[] }): void {
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) this.closes.push(BigInt(bar.c));
    }
  }

  /** Sum of the last MEAN_BARS closes, or null without the history. */
  meanSum(): bigint | null {
    if (this.closes.length < MEAN_BARS) return null;
    let total = 0n;
    for (let i = this.closes.length - MEAN_BARS; i < this.closes.length; i++) {
      total += this.closes[i];
    }
    return total;
  }

  /** How far the latest close sits below the trailing mean, in bps. */
  dipBps(total: bigint): bigint {
    const close = this.closes[this.closes.length - 1];
    return ((total - BigInt(MEAN_BARS) * close) * 10000n) / total;
  }

  /**
   * Recover the trade's average entry price (raw) from its cost.
   * Holding.cost is the quote units actually spent, fees included, and
   * value() prices qty at raw price p as qty * p * 10^quote_scale /
   * 10^(qty_scale + price_scale); invert it in bigints.
   */
  entryPrice(state: BarsState, qty: bigint, cost: bigint): bigint {
    const sym = state.hello.symbols.find((s) => s.symbol === SYMBOL)!;
    const num = cost * 10n ** BigInt(sym.qty_scale + sym.price_scale);
    return num / (qty * 10n ** BigInt(state.hello.capital.quote_scale));
  }
}


/** The entry: a deep dip below the mean whose fall has paused. */
function maybeBuy(st: Snapback, state: BarsState): BuyInput[] {
  if (state.warmingUp) return [];
  if (state.seq - st.lastSellSeq < COOLDOWN_BARS) return [];
  const total = st.meanSum();
  if (total === null || st.closes.length < 2) return [];
  // The dip that counts: the full one, or the shallower late one when the
  // window is half gone and no trade has happened yet (a bot that never
  // trades scores exactly 0 and misses the guardrails however it ends).
  const dipNeeded = !st.enteredOnce && state.seq >= LATE_SEQ ? LATE_DIP_BPS : DIP_BPS;
  if (st.dipBps(total) < dipNeeded) return [];
  const n = st.closes.length;
  if (st.closes[n - 1] < st.closes[n - 2]) return []; // still falling: wait for the pause
  let spend = (state.equity * SPEND_BPS) / 10000n;
  if (spend > state.cash) spend = state.cash;
  const room = state.weightRoom(SYMBOL);
  if (spend > room) spend = room;
  const impact = state.impactBps(SYMBOL, spend);
  if (impact !== null && impact > MAX_IMPACT_BPS) {
    spend = (spend * MAX_IMPACT_BPS) / impact;
  }
  if (spend < 1_000_000n) return []; // under the 1 USDC minimum a buy is rejected anyway
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: spend, max_slippage_bps: BUY_SLIP_BPS }];
}

/** The exits, in the order they are checked: stop, target, trail, mean, time. */
function maybeSell(st: Snapback, state: BarsState, qty: bigint, close: bigint): SellInput[] {
  const entry = st.entryPx!;
  const sell: SellInput = { side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: SELL_SLIP_BPS };
  if (close * 10000n <= entry * (10000n - STOP_BPS)) return [sell];        // stop loss
  if (close * 10000n >= entry * (10000n + TAKE_PROFIT_BPS)) return [sell]; // take profit
  if (st.peakPx * 10000n >= entry * (10000n + TRAIL_ARM_BPS)
    && close * 10000n <= st.peakPx * (10000n - TRAIL_GIVE_BPS)) {
    return [sell]; // trailing stop, armed and given back
  }
  const total = st.meanSum();
  if (total !== null && close * BigInt(MEAN_BARS) >= total
    && close * 10000n >= entry * (10000n + MEAN_EXIT_MIN_BPS)) {
    return [sell]; // recovered to the mean with a real profit
  }
  if (state.seq - st.entrySeq >= MAX_HOLD_BARS) return [sell]; // time stop
  return [];
}

const strategy = new Snapback();

await runBars({
  onBatch(state, batch) {
    strategy.noteBar(batch);
    if (strategy.closes.length === 0) return [];
    const close = strategy.closes[strategy.closes.length - 1];
    const held = state.positions.get(SYMBOL);
    if (held === undefined) {
      if (strategy.entryPx !== null) {
        // The trade is over (sold, or flattened at the window's end).
        strategy.entryPx = null;
        strategy.peakPx = 0n;
        strategy.lastSellSeq = state.seq;
      }
      return maybeBuy(strategy, state);
    }
    if (strategy.entryPx === null) {
      strategy.entryPx = strategy.entryPrice(state, held.qty, held.cost);
      strategy.entrySeq = state.seq;
      strategy.peakPx = close;
      strategy.enteredOnce = true;
    } else if (close > strategy.peakPx) {
      strategy.peakPx = close;
    }
    return maybeSell(strategy, state, held.qty, close);
  },
});
