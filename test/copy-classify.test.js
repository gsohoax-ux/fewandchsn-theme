import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyTransaction, fromFeedTrade, programsOf, DEX_PROGRAMS } from '../src/copy/classify.js';

const W = 'TraderWa11et111111111111111111111111111111111';
const OTHER = 'SomeoneE1se11111111111111111111111111111111';
const MINT = 'Fq3s2Yb2wJ8fWz6x5rJ3Rk1v9nQe4XhL7mUuTtPapump';
const MINT2 = 'SecondMint2222222222222222222222222222222pump';
const WSOL = 'So11111111111111111111111111111111111111112';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const PUMP = '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P';
const JUP = 'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4';
const RAY = '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8';
const SYS = '11111111111111111111111111111111';
const TOKEN_PROG = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const BOT = 'TradingB0tRouter111111111111111111111111111';

const tb = (accountIndex, mint, owner, amount, decimals = 6) => ({ accountIndex, mint, owner, uiTokenAmount: { amount: String(Math.round(amount * 10 ** decimals)), decimals } });
/** Build a jsonParsed getTransaction result. sol: [pre, post] lamports for the wallet (index 0, fee payer). */
function tx({ sol = [5e9, 5e9], fee = 5000, pre = [], post = [], programs = [PUMP], inner = [], err = null, logs = [], loaded = null, walletIndex = 0 }) {
  const keys = [OTHER, OTHER, OTHER];
  keys[walletIndex] = W;
  const preBalances = [1e9, 1e9, 1e9], postBalances = [1e9, 1e9, 1e9];
  preBalances[walletIndex] = sol[0]; postBalances[walletIndex] = sol[1];
  return {
    slot: 300_000_123, blockTime: 1_800_000_000,
    transaction: { signatures: ['SIG1'], message: { accountKeys: keys.map((k, i) => ({ pubkey: k, signer: i === 0, writable: true })),
      instructions: programs.map((p) => ({ programId: p })) } },
    meta: { err, fee, preBalances, postBalances, preTokenBalances: pre, postTokenBalances: post, logMessages: logs,
      innerInstructions: inner.length ? [{ index: 0, instructions: inner.map((p) => ({ programId: p })) }] : [], loadedAddresses: loaded },
  };
}

test('first buy on Pump.fun: tokens up, SOL down → BUY', () => {
  const r = classifyTransaction(tx({ sol: [5e9, 5e9 - 1.5e9 - 2_039_280 - 5000], post: [tb(3, MINT, W, 4_000_000)] }), W);
  assert.equal(r.status, 'ok');
  assert.equal(r.venue, 'Pump.fun');
  assert.equal(r.events.length, 1);
  const e = r.events[0];
  assert.equal(e.kind, 'buy');
  assert.equal(e.pre, 0); assert.equal(e.post, 4_000_000);
  assert.ok(Math.abs(e.quote.sol + 1.502) < 0.001, 'fee added back; token-account rent stays in');
});

test('adding to an existing bag → ADD', () => {
  const r = classifyTransaction(tx({ sol: [5e9, 4e9], pre: [tb(3, MINT, W, 4e6)], post: [tb(3, MINT, W, 6e6)] }), W);
  assert.equal(r.events[0].kind, 'add');
  assert.equal(r.events[0].delta, 2e6);
});

test('partial sells use the exact before/after balances; selling everything → EXIT', () => {
  const s25 = classifyTransaction(tx({ sol: [1e9, 1.4e9], pre: [tb(3, MINT, W, 8e6)], post: [tb(3, MINT, W, 6e6)] }), W).events[0];
  assert.equal(s25.kind, 'sell'); assert.equal(s25.soldPct, 25);
  const s50 = classifyTransaction(tx({ sol: [1e9, 1.4e9], pre: [tb(3, MINT, W, 6e6)], post: [tb(3, MINT, W, 3e6)] }), W).events[0];
  assert.equal(s50.soldPct, 50, '50% of what was left, not of the original bag');
  const exit = classifyTransaction(tx({ sol: [1e9, 1.6e9], pre: [tb(3, MINT, W, 3e6)], post: [] }), W).events[0];
  assert.equal(exit.kind, 'exit'); assert.equal(exit.soldPct, 100);
  const exit2 = classifyTransaction(tx({ sol: [1e9, 1.6e9], pre: [tb(3, MINT, W, 3e6)], post: [tb(3, MINT, W, 0)] }), W).events[0];
  assert.equal(exit2.kind, 'exit', 'zero balance left = exit');
});

test('failed transactions are never copied', () => {
  const r = classifyTransaction(tx({ err: { InstructionError: [0, { Custom: 6001 }] }, sol: [1e9, 1e9 - 5000], post: [tb(3, MINT, W, 4e6)] }), W);
  assert.equal(r.status, 'failed');
  assert.equal(r.events.length, 0);
  assert.equal(r.ignored[0].kind, 'failed');
});

test('a transaction the node has not returned yet is "pending", to be retried', () => {
  assert.equal(classifyTransaction(null, W).status, 'pending');
  assert.equal(classifyTransaction({ slot: 1 }, W).status, 'pending');
});

test('token transfers in/out without a DEX are not trades', () => {
  const tin = classifyTransaction(tx({ programs: [TOKEN_PROG], sol: [1e9, 1e9 - 5000], post: [tb(3, MINT, W, 1e6)] }), W);
  assert.equal(tin.events.length, 0);
  assert.equal(tin.ignored[0].kind, 'transfer_in');
  // sender pays token-account rent for the recipient: SOL down + tokens down, still not a sale
  const tout = classifyTransaction(tx({ programs: [TOKEN_PROG], sol: [1e9, 1e9 - 2_039_280 - 5000], pre: [tb(3, MINT, W, 5e6)], post: [tb(3, MINT, W, 2e6)] }), W);
  assert.equal(tout.events.length, 0);
  assert.equal(tout.ignored[0].kind, 'transfer_out');
});

test('wallet funding (only SOL moves) is not a trade', () => {
  const r = classifyTransaction(tx({ programs: [SYS], sol: [1e9, 6e9] }), W);
  assert.equal(r.events.length, 0);
  assert.equal(r.ignored[0].kind, 'funding');
});

test('liquidity deposits and withdrawals are ignored', () => {
  const dep = classifyTransaction(tx({ programs: [RAY], sol: [10e9, 5e9], pre: [tb(3, MINT, W, 9e6)], post: [tb(3, MINT, W, 1e6), tb(4, 'LPmint1111111111111111111111111111111111111', W, 50)] }), W);
  assert.equal(dep.events.length, 0, 'the LP token received is not a buy either');
  assert.ok(dep.ignored.every((i) => i.kind === 'liquidity'));
  const wd = classifyTransaction(tx({ programs: [RAY], sol: [5e9, 10e9], pre: [tb(3, MINT, W, 1e6)], post: [tb(3, MINT, W, 9e6)] }), W);
  assert.equal(wd.events.length, 0);
  assert.equal(wd.ignored[0].kind, 'liquidity');
});

test('trading bots: DEX found through inner instructions or logs', () => {
  const viaInner = classifyTransaction(tx({ programs: [BOT], inner: [PUMP], sol: [5e9, 4e9], post: [tb(3, MINT, W, 1e6)] }), W);
  assert.equal(viaInner.events[0].kind, 'buy');
  const logTx = tx({ programs: [BOT], logs: [`Program ${BOT} invoke [1]`, `Program pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA invoke [2]`], sol: [5e9, 4e9], post: [tb(3, MINT, W, 1e6)] });
  const viaLogs = classifyTransaction(logTx, W);
  assert.equal(viaLogs.venue, 'PumpSwap');
  assert.ok(programsOf(logTx).has(BOT));
  const noDex = classifyTransaction(tx({ programs: [BOT], sol: [5e9, 4e9], post: [tb(3, MINT, W, 1e6)] }), W);
  assert.equal(noDex.events.length, 0, 'tokens + SOL moving through an unknown program alone is not treated as a buy');
});

test('wrapped SOL and USDC count as payment', () => {
  const wsolBuy = classifyTransaction(tx({ programs: [RAY], sol: [1e9, 1e9 - 5000], pre: [tb(4, WSOL, W, 2, 9)], post: [tb(4, WSOL, W, 0.5, 9), tb(3, MINT, W, 1e6)] }), W);
  assert.equal(wsolBuy.events[0].kind, 'buy');
  assert.ok(Math.abs(wsolBuy.events[0].quote.sol + 1.5) < 1e-9);
  const usdcSell = classifyTransaction(tx({ programs: [JUP], sol: [1e9, 1e9 - 5000], pre: [tb(3, MINT, W, 2e6), tb(4, USDC, W, 10)], post: [tb(3, MINT, W, 1e6), tb(4, USDC, W, 210)] }), W);
  assert.equal(usdcSell.events[0].kind, 'sell');
  assert.equal(usdcSell.events[0].soldPct, 50);
  assert.equal(usdcSell.events[0].priceStable, 200 / 1e6);
});

test('token-to-token route: sell of one, buy of the other', () => {
  const r = classifyTransaction(tx({ programs: [JUP], sol: [1e9, 1e9 - 5000], pre: [tb(3, MINT, W, 4e6)], post: [tb(3, MINT, W, 0), tb(4, MINT2, W, 7e6)] }), W);
  const kinds = Object.fromEntries(r.events.map((e) => [e.mint, e.kind]));
  assert.equal(kinds[MINT], 'exit');
  assert.equal(kinds[MINT2], 'buy');
});

test('only the followed wallet\'s balances count; versioned tx with loaded addresses', () => {
  const r = classifyTransaction(tx({ sol: [5e9, 4e9], pre: [tb(5, MINT, OTHER, 9e6)], post: [tb(5, MINT, OTHER, 1e6), tb(3, MINT, W, 8e6)] }), W);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].post, 8e6);
  // wallet only present in loaded addresses (not the fee payer): fee not added back
  const t = tx({ sol: [5e9, 4e9], post: [tb(3, MINT, W, 1e6)], walletIndex: 1 });
  t.transaction.message.accountKeys = t.transaction.message.accountKeys.filter((k) => k.pubkey !== W);
  t.meta.loadedAddresses = { writable: [W], readonly: [] };
  t.meta.preBalances = [1e9, 1e9, 5e9]; t.meta.postBalances = [1e9, 1e9, 4e9];
  const v = classifyTransaction(t, W);
  assert.equal(v.events[0].kind, 'buy');
  assert.ok(Math.abs(v.events[0].quote.sol + 1) < 1e-9);
});

test('PumpPortal trade messages convert to the same events', () => {
  const buy = fromFeedTrade({ signature: 'S', mint: MINT, txType: 'buy', tokenAmount: 1e6, solAmount: 0.5, newTokenBalance: 1e6, marketCapSol: 40 });
  assert.equal(buy.events[0].kind, 'buy');
  assert.equal(buy.feed.marketCapSol, 40);
  const add = fromFeedTrade({ signature: 'S', mint: MINT, txType: 'buy', tokenAmount: 1e6, solAmount: 0.5, newTokenBalance: 3e6 });
  assert.equal(add.events[0].kind, 'add');
  const sell = fromFeedTrade({ signature: 'S', mint: MINT, txType: 'sell', tokenAmount: 1e6, solAmount: 0.5, newTokenBalance: 3e6 });
  assert.equal(sell.events[0].kind, 'sell');
  assert.equal(sell.events[0].soldPct, 25);
  const exit = fromFeedTrade({ signature: 'S', mint: MINT, txType: 'sell', tokenAmount: 3e6, solAmount: 1, newTokenBalance: 0 });
  assert.equal(exit.events[0].kind, 'exit');
  assert.ok(Object.keys(DEX_PROGRAMS).length >= 10);
});
