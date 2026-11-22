import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { CopyEngine, normalizeTraderSettings } from '../src/copy/engine.js';
import { Store } from '../src/store.js';

const W = 'TraderWa11et11111111111111111111111111111111';
const W2 = 'SecondTrader2222222222222222222222222222222';
const OTHER = 'SomeoneE1se11111111111111111111111111111111';
const MINT = 'Fq3s2Yb2wJ8fWz6x5rJ3Rk1v9nQe4XhL7mUuTtPapump';
const PUMPSWAP = 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA';
const TOKEN_PROG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const cfg = { paperFeePct: 1.25, paperTerminalFeePct: 1, paperTxFeeSol: 0.0015, paperMevPct: 2 };
const quiet = { warn() {}, info() {} };

const tb = (mint, owner, amount) => ({ accountIndex: 3, mint, owner, uiTokenAmount: { amount: String(Math.round(amount * 1e6)), decimals: 6 } });
function tx({ wallet = W, preTok = 0, postTok = 0, solDelta = 0, programs = [PUMPSWAP], err = null, blockTime }) {
  return { slot: 1, blockTime, transaction: { signatures: ['x'], message: { accountKeys: [{ pubkey: wallet }, { pubkey: OTHER }], instructions: programs.map((p) => ({ programId: p })) } },
    meta: { err, fee: 5000, preBalances: [10e9, 1e9], postBalances: [10e9 + solDelta * 1e9 - 5000, 1e9],
      preTokenBalances: preTok ? [tb(MINT, wallet, preTok)] : [], postTokenBalances: postTok ? [tb(MINT, wallet, postTok)] : [], logMessages: [], innerInstructions: [] } };
}

/** A fake Solana node: transactions by signature + each wallet's signature list (newest first). */
function fakeChain(clock) {
  const txs = new Map(), sigs = new Map();
  return {
    enabled: true, txs, sigs, calls: 0,
    push(wallet, sig, t, { err = null } = {}) { txs.set(sig, t); sigs.set(wallet, [{ signature: sig, blockTime: Math.floor(clock.t / 1000), err }, ...(sigs.get(wallet) ?? [])]); },
    async rpc(method, params) {
      this.calls++;
      if (method === 'getTransaction') return txs.get(params[0]) ?? null;
      if (method === 'getSignaturesForAddress') {
        const all = sigs.get(params[0]) ?? [{ signature: 'GENESIS', blockTime: 1 }];
        const until = params[1]?.until;
        const i = until ? all.findIndex((s) => s.signature === until) : -1;
        return (i >= 0 ? all.slice(0, i) : all).slice(0, params[1]?.limit ?? 1000);
      }
      throw new Error(method);
    },
  };
}
/** DexScreener stand-in with a price you control. */
const dex = (state) => async (url) => ({ ok: true, status: 200, json: async () => ({ pairs: url.includes(MINT) && state.price ? [{ chainId: 'solana', dexId: 'pumpswap', pairAddress: 'P',
  baseToken: { address: MINT, symbol: 'COPY', name: 'Copy Coin' }, priceUsd: String(state.price), marketCap: state.price * 1e9, liquidity: { usd: state.liq } }] : [] }) });

function setup({ chain = null, state = { price: 0.0001, liq: 400_000 }, clock = { t: 1_800_000_000_000 }, settings = {} } = {}) {
  const store = new Store(':memory:');
  const feed = new EventEmitter(); feed.watched = new Set(); feed.watch = (m) => feed.watched.add(m); feed.accounts = new Set();
  feed.watchAccount = (w) => feed.accounts.add(w); feed.unwatchAccount = (w) => feed.accounts.delete(w);
  const engine = { solUsd: 150, coins: new Map(), logEvent() {} };
  const ce = new CopyEngine({ cfg, store, engine, feed, chain, fetchFn: dex(state), log: quiet, now: () => clock.t });
  return { ce, store, feed, engine, state, clock, chain };
}
const ev = (ce, kind) => ce.store.copyEvents(500).filter((e) => !kind || e.kind === kind);
const run = async (ce) => { await ce.pollTick(); await ce.verifyTick(); await ce.queue; };

test('full mirroring with on-chain confirmation: buy, add, 25% sell, 50% sell, transfer ignored, exit, re-entry', async () => {
  const clock = { t: 1_800_000_000_000 };
  const chain = fakeChain(clock);
  const { ce, store, feed } = setup({ chain, clock });
  ce.addTrader(W, { label: 'Whale', settings: { buyUsd: 25, maxPositionUsd: 100 } });
  await new Promise((r) => setImmediate(r));
  assert.ok(feed.accounts.has(W), 'subscribed to the wallet on the live feed');
  assert.equal(ce.traders.get(W).lastSig, 'GENESIS', 'history before following is never copied');
  const bt = () => Math.floor(clock.t / 1000);

  chain.push(W, 'BUY1', tx({ postTok: 8e6, solDelta: -3.3, blockTime: bt() }));            // trader buys ~$500
  await run(ce);
  let open = ce.view().open;
  assert.equal(open.length, 1);
  assert.equal(open[0].budgetUsd, 25, 'fixed copy amount, not the trader\'s size');
  assert.equal(open[0].origin, 'copy');
  assert.match(open[0].fills[0].reason, /Mirrored buy/);
  const tokens1 = open[0].tokens;

  chain.push(W, 'ADD1', tx({ preTok: 8e6, postTok: 12e6, solDelta: -1.3, blockTime: bt() })); // trader adds $200
  await run(ce);
  open = ce.view().open;
  assert.equal(open[0].budgetUsd, 50, 'another fixed $25 on the add');
  const total = open[0].tokens;
  assert.ok(total > tokens1 * 1.9);

  chain.push(W, 'SELL1', tx({ preTok: 12e6, postTok: 9e6, solDelta: 1, blockTime: bt() }));  // trader sells 25%
  await run(ce);
  assert.ok(Math.abs(ce.view().open[0].tokens - total * 0.75) / total < 1e-9, 'sold 25% of the copy');

  chain.push(W, 'SELL2', tx({ preTok: 9e6, postTok: 4.5e6, solDelta: 1, blockTime: bt() })); // trader sells 50% of what's left
  await run(ce);
  assert.ok(Math.abs(ce.view().open[0].tokens - total * 0.375) / total < 1e-9, 'then 50% of the remainder');

  chain.push(W, 'XFER', tx({ preTok: 4.5e6, postTok: 4e6, programs: [TOKEN_PROG], blockTime: bt() })); // moves tokens to another wallet
  chain.push(W, 'FAIL', tx({ preTok: 4e6, postTok: 0, solDelta: 1, blockTime: bt() }), { err: { InstructionError: [0, 'x'] } });
  await run(ce);
  assert.ok(Math.abs(ce.view().open[0].tokens - total * 0.375) / total < 1e-9, 'transfers and failed transactions change nothing');
  assert.equal(ev(ce, 'transfer_out')[0].action, 'ignored');
  assert.equal(ev(ce, 'failed')[0].action, 'ignored');

  chain.push(W, 'EXIT', tx({ preTok: 4e6, postTok: 0, solDelta: 1, blockTime: bt() }));     // trader exits
  await run(ce);
  let v = ce.view();
  assert.equal(v.open.length, 0);
  assert.match(v.closed[0].exitReason, /Mirrored full exit/);
  assert.equal(v.closed[0].fills.filter((f) => f.kind === 'sell').length, 3);

  chain.push(W, 'REBUY', tx({ postTok: 2e6, solDelta: -0.5, blockTime: bt() }));            // re-entry
  await run(ce);
  v = ce.view();
  assert.equal(v.open.length, 1);
  assert.match(v.open[0].fills[0].reason, /re-entry/);
  const kinds = ev(ce).filter((e) => e.action === 'copied' || e.action === 'mirrored').map((e) => `${e.kind}:${e.action}`).reverse();
  assert.deepEqual(kinds, ['buy:copied', 'add:copied', 'sell:mirrored', 'sell:mirrored', 'exit:mirrored', 'buy:copied']);
  assert.ok(v.events.every((e) => e.verified !== false || e.kind === 'failed'));

  // the same transaction arriving again (live feed after polling, or a re-poll) is never executed twice
  feed.emit('trade', { signature: 'REBUY', traderPublicKey: W, mint: MINT, txType: 'buy', tokenAmount: 2e6, solAmount: 0.5, newTokenBalance: 2e6 });
  chain.sigs.set(W, [...chain.sigs.get(W)]); ce.traders.get(W).lastSig = 'EXIT';
  await run(ce);
  assert.equal(ce.view().open[0].budgetUsd, 25, 'no duplicate buy');
  assert.equal(store.simPositions('manual', 'open').length + store.simPositions('strategy', 'open').length, 0, 'other books untouched');
});

test('feed-only mode (no Helius): mirrors PumpPortal trades for the wallet, priced at the curve after the trade', async () => {
  const { ce, feed } = setup({ state: { price: 0 } });
  ce.addTrader(W2, { settings: { buyUsd: 30 } });
  const msg = (txType, tokenAmount, newTokenBalance, sig) => ({ signature: sig, traderPublicKey: W2, mint: MINT, txType, tokenAmount, solAmount: 1, newTokenBalance, marketCapSol: 60, vSolInBondingCurve: 45 });
  feed.emit('trade', msg('buy', 5e6, 5e6, 'a')); await ce.queue;
  assert.equal(ce.view().open.length, 1);
  assert.match(ce.view().events[0].source, /not confirmed on-chain/);
  assert.match(ce.view().events[0].copy.priceSource, /right after the trader/);
  feed.emit('trade', msg('sell', 2.5e6, 2.5e6, 'b')); await ce.queue;
  assert.ok(Math.abs(ce.view().open[0].soldPct - 50) < 1e-6);
  feed.emit('trade', msg('sell', 2.5e6, 0, 'c')); await ce.queue;
  assert.equal(ce.view().open.length, 0);
  feed.emit('trade', { ...msg('buy', 1e6, 1e6, 'd'), traderPublicKey: OTHER }); await ce.queue;
  assert.equal(ce.view().open.length, 0, 'wallets you don\'t follow are ignored');
});

test('position size and exposure limits shrink or refuse buys, with the reason', async () => {
  const { ce, feed } = setup({ state: { price: 0 } });
  ce.updateSettings({ maxTotalExposureUsd: 1000 });
  ce.addTrader(W2, { settings: { buyUsd: 25, maxPositionUsd: 40, maxExposureUsd: 60 } });
  let n = 0;
  const buy = (mint = MINT) => { feed.emit('trade', { signature: `s${n++}`, traderPublicKey: W2, mint, txType: 'buy', tokenAmount: 1e6, solAmount: 1, newTokenBalance: 1e6 * n, marketCapSol: 60, vSolInBondingCurve: 45 }); return ce.queue; };
  await buy(); await buy(); await buy();
  const evs = ce.view().events;
  assert.equal(ce.view().open[0].budgetUsd, 40);
  assert.match(evs.find((e) => e.action === 'copied' && e.copy.usd === 15).reason, /reduced from \$25 by your maximum position size/);
  assert.match(evs.find((e) => e.action === 'rejected').reason, /maximum position size is reached/);
  await buy('Other1Mint111111111111111111111111111111pump');
  assert.equal(ce.view().open.find((p) => p.mint !== MINT).budgetUsd, 20, 'trader exposure cap: only $20 left of $60');
  assert.throws(() => normalizeTraderSettings({ buyUsd: 50, maxPositionUsd: 40 }), /cannot exceed/);
  assert.throws(() => normalizeTraderSettings({ hack: 1 }), /Unknown setting/);
  assert.throws(() => normalizeTraderSettings({ stopPct: 200 }), /between/);
});

test('late, paused and unsafe buys are rejected or skipped; sells are still mirrored', async () => {
  const clock = { t: 1_800_000_000_000 };
  const chain = fakeChain(clock);
  const { ce, state } = setup({ chain, clock });
  ce.addTrader(W, { settings: { buyUsd: 25, maxBuyDelaySec: 60, minLiqUsd: 3000 } });
  await new Promise((r) => setImmediate(r));
  chain.push(W, 'OLD', tx({ postTok: 1e6, solDelta: -1, blockTime: Math.floor(clock.t / 1000) - 600 }));
  await run(ce);
  assert.match(ev(ce)[0].reason, /Detected 600s after the trade/);
  chain.push(W, 'B', tx({ preTok: 1e6, postTok: 2e6, solDelta: -1, blockTime: Math.floor(clock.t / 1000) }));
  await run(ce);
  assert.equal(ce.view().open.length, 1, 'a fresh add with no copy yet opens one');
  ce.updateTrader(W, { paused: true });
  chain.push(W, 'P', tx({ preTok: 2e6, postTok: 3e6, solDelta: -1, blockTime: Math.floor(clock.t / 1000) }));
  await run(ce);
  assert.match(ev(ce)[0].reason, /paused/);
  chain.push(W, 'S', tx({ preTok: 3e6, postTok: 1.5e6, solDelta: 1, blockTime: Math.floor(clock.t / 1000) - 900 }));
  await run(ce);
  assert.equal(ev(ce)[0].action, 'mirrored', 'sells are mirrored while paused, even late');
  ce.updateTrader(W, { paused: false });
  state.liq = 1500;
  chain.push(W2, 'x', tx({ wallet: W2, postTok: 1, blockTime: 1 }));
  ce.addTrader(W2, { settings: { minLiqUsd: 3000 } });
  await new Promise((r) => setImmediate(r));
  chain.push(W2, 'THIN', tx({ wallet: W2, postTok: 1e6, solDelta: -1, blockTime: Math.floor(clock.t / 1000) }));
  await run(ce);
  assert.match(ev(ce).find((e) => e.signature === 'THIN').reason, /Liquidity \$1,500 is below your minimum \$3,000/);
  state.price = 0;
  chain.push(W2, 'NOPRICE', tx({ wallet: W2, postTok: 2e6, preTok: 1e6, solDelta: -1, blockTime: Math.floor(clock.t / 1000) }));
  await run(ce);
  assert.match(ev(ce).find((e) => e.signature === 'NOPRICE').reason, /No live price/);
});

test('your own stop-loss exits first and is recorded; later trader sells and adds are handled', async () => {
  const clock = { t: 1_800_000_000_000 };
  const chain = fakeChain(clock);
  const { ce, state } = setup({ chain, clock });
  ce.addTrader(W, { settings: { buyUsd: 25, stopPct: 20 } });
  await new Promise((r) => setImmediate(r));
  chain.push(W, 'B', tx({ postTok: 1e6, solDelta: -1, blockTime: Math.floor(clock.t / 1000) }));
  await run(ce);
  state.price = 0.00007; // −30%
  await ce.pollPrices();
  let v = ce.view();
  assert.equal(v.open.length, 0);
  assert.match(v.closed[0].exitReason, /Stop-loss/);
  assert.match(v.events.find((e) => e.kind === 'own-rule').reason, /Stop-loss.*before the trader/);
  chain.push(W, 'S', tx({ preTok: 1e6, postTok: 0.5e6, solDelta: 1, blockTime: Math.floor(clock.t / 1000) }));
  chain.push(W, 'A', tx({ preTok: 0.5e6, postTok: 2e6, solDelta: -1, blockTime: Math.floor(clock.t / 1000) }));
  await run(ce); await run(ce);
  v = ce.view();
  assert.match(v.events.find((e) => e.signature === 'S').reason, /already closed \(Stop-loss/);
  assert.match(v.events.find((e) => e.signature === 'A').reason, /closed by your own rule/);
  assert.equal(v.open.length, 0);
  assert.equal(v.traders[0].stats.trades, 1);
  assert.equal(v.traders[0].stats.losses, 1);
});

test('transactions the node never returns are rejected (not copied) when confirmation is required', async () => {
  const clock = { t: 1_800_000_000_000 };
  const chain = fakeChain(clock);
  const { ce, feed } = setup({ chain, clock });
  ce.addTrader(W, {});
  await new Promise((r) => setImmediate(r));
  feed.emit('trade', { signature: 'GHOST', traderPublicKey: W, mint: MINT, txType: 'buy', tokenAmount: 1e6, solAmount: 1, newTokenBalance: 1e6 });
  for (let i = 0; i < 10; i++) { await ce.verifyTick(); clock.t += 60_000; }
  await ce.queue;
  assert.equal(ce.view().open.length, 0);
  assert.match(ev(ce)[0].reason, /Could not confirm this transaction on-chain/);
});

test('controls: off, unfollow protection, portfolio and per-trader performance', async () => {
  const { ce, feed } = setup({ state: { price: 0 } });
  ce.addTrader(W2, { label: 'A' });
  assert.throws(() => ce.addTrader(W2), /Already following/);
  assert.throws(() => ce.addTrader('nope'), /Solana wallet/);
  feed.emit('trade', { signature: 'z1', traderPublicKey: W2, mint: MINT, txType: 'buy', tokenAmount: 1e6, solAmount: 1, newTokenBalance: 1e6, marketCapSol: 60 }); await ce.queue;
  assert.throws(() => ce.removeTrader(W2), /still has 1 open copied position/);
  ce.updateTrader(W2, { enabled: false });
  assert.ok(feed.accounts.has(W2), 'OFF still watches until its open copies are closed');
  feed.emit('trade', { signature: 'z2', traderPublicKey: W2, mint: MINT, txType: 'buy', tokenAmount: 1e6, solAmount: 1, newTokenBalance: 2e6, marketCapSol: 60 }); await ce.queue;
  assert.match(ce.view().events[0].reason, /Copy is OFF/);
  feed.emit('trade', { signature: 'z3', traderPublicKey: W2, mint: MINT, txType: 'sell', tokenAmount: 2e6, solAmount: 1, newTokenBalance: 0, marketCapSol: 70 }); await ce.queue;
  const v = ce.view();
  assert.equal(v.open.length, 0, 'the exit was still mirrored while OFF');
  assert.equal(v.traders[0].stats.trades, 1);
  assert.equal(v.portfolio.trades, 1);
  assert.ok(v.traders[0].status.state.startsWith('OFF'));
  ce.removeTrader(W2);
  assert.equal(feed.accounts.has(W2), false);
  assert.throws(() => ce.updateSettings({ pollSec: 1 }), /Poll interval/);
});
