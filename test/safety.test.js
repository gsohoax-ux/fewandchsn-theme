import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Coin, curveProgress } from '../src/coin.js';
import { analyzeSafety, launchBlockWallets, findClusters } from '../src/safety.js';
import { summarizeWallet } from '../src/chain.js';
import { analyzeMomentum } from '../src/momentum.js';
import { socialKey, words, TrendTracker, ruleNarrative } from '../src/narrative.js';
import { combine } from '../src/score.js';
import { Store } from '../src/store.js';

const cfg = { maxBundlePct: 15, maxDevPct: 8, maxTop10Pct: 35 };
const T0 = 1_700_000_000_000;

function makeCoin({ devTokens = 10_000_000 } = {}) {
  return new Coin({ mint: 'MINT', name: 'Test', symbol: 'TST', traderPublicKey: 'DEV', signature: 'sigCreate',
    initialBuy: devTokens, solAmount: 0.3, vTokensInBondingCurve: 1_073_000_000 - devTokens, marketCapSol: 28 }, T0);
}
const buy = (coin, trader, tokens, ts, sig = `sig-${trader}-${ts}`) => coin.applyTrade({
  mint: 'MINT', signature: sig, traderPublicKey: trader, txType: 'buy', tokenAmount: tokens, solAmount: 1,
  newTokenBalance: (coin.balances.get(trader) ?? 0) + tokens }, ts);

test('curve progress', () => {
  assert.equal(curveProgress(1_073_000_000), 0);
  assert.equal(Math.round(curveProgress(279_900_000)), 100);
  assert.equal(Math.round(curveProgress(1_073_000_000 - 793_100_000 / 2)), 50);
});

test('detects same-block bundle using slots and links wallets by funder', () => {
  const coin = makeCoin();
  const slots = new Map([['sigCreate', 100]]);
  for (let i = 0; i < 5; i++) { buy(coin, `B${i}`, 40_000_000, T0 + 300, `sb${i}`); slots.set(`sb${i}`, 100); }
  for (let i = 0; i < 20; i++) { buy(coin, `O${i}`, 2_000_000, T0 + 5000 + i * 1000, `so${i}`); slots.set(`so${i}`, 110 + i); }

  const launch = launchBlockWallets(coin, slots);
  assert.equal(launch.size, 5);

  const wallets = new Map([['DEV', { funder: 'X', fresh: false }]]);
  for (let i = 0; i < 5; i++) wallets.set(`B${i}`, { funder: 'FUNDER', fresh: true });
  for (let i = 0; i < 20; i++) wallets.set(`O${i}`, { funder: `F${i}`, fresh: false });
  const clusters = findClusters(coin, wallets);
  assert.equal(clusters.length, 1);
  assert.equal(clusters[0].wallets.length, 5);
  assert.equal(Math.round(clusters[0].heldPct), 20);

  const r = analyzeSafety(coin, { source: 'chain', slots, wallets, services: new Set(), errors: [] },
    { cfg, devLaunches24h: 0, recycledSocials: [] });
  assert.equal(r.verdict, 'AVOID');
  assert.equal(Math.round(r.launchBundle.initialPct), 20);
});

test('exchange funders are not treated as a bundle', () => {
  const coin = makeCoin();
  for (let i = 0; i < 6; i++) buy(coin, `W${i}`, 3_000_000, T0 + 4000 + i * 900);
  const wallets = new Map([...Array(6)].map((_, i) => [`W${i}`, { funder: 'BINANCE', fresh: false }]));
  assert.equal(findClusters(coin, wallets, new Set(['BINANCE'])).length, 0);
  assert.equal(findClusters(coin, wallets).length, 1);
});

test('wallet funded by the dev is linked to the dev', () => {
  const coin = makeCoin();
  buy(coin, 'A', 5_000_000, T0 + 3000);
  buy(coin, 'B', 5_000_000, T0 + 4000);
  const wallets = new Map([['DEV', { funder: 'Z' }], ['A', { funder: 'DEV' }], ['B', { funder: 'Q' }]]);
  const c = findClusters(coin, wallets);
  assert.equal(c.length, 1);
  assert.ok(c[0].includesDev);
});

test('clean coin without Helius uses the timing fallback and passes', () => {
  const coin = makeCoin();
  for (let i = 0; i < 30; i++) buy(coin, `O${i}`, 1_500_000, T0 + 3000 + i * 1500);
  const r = analyzeSafety(coin, { source: 'timing', slots: null, wallets: new Map(), services: new Set(), errors: [] },
    { cfg, devLaunches24h: 0, recycledSocials: [] });
  assert.equal(r.verdict, 'SAFE');
  assert.equal(r.launchBundle.wallets, 0);
});

test('timing fallback flags buys within 1.5s of launch', () => {
  const coin = makeCoin();
  buy(coin, 'S1', 60_000_000, T0 + 200);
  buy(coin, 'S2', 60_000_000, T0 + 400);
  buy(coin, 'L', 1_000_000, T0 + 9000);
  const launch = launchBlockWallets(coin, null);
  assert.deepEqual([...launch].sort(), ['S1', 'S2']);
});

test('serial launcher and big dev bag are red flags', () => {
  const coin = makeCoin({ devTokens: 120_000_000 });
  const r = analyzeSafety(coin, { source: 'timing', slots: null, wallets: new Map(), services: new Set(), errors: [] },
    { cfg, devLaunches24h: 6, recycledSocials: [] });
  assert.equal(r.verdict, 'AVOID');
  assert.ok(r.flags.some((f) => f.text.includes('Serial launcher')));
  assert.ok(r.flags.some((f) => f.text.startsWith('Dev holds 12')));
});

test('summarizeWallet finds the funder before the buy and freshness', () => {
  const now = 1_700_000_000;
  const txs = [
    { timestamp: now + 10, nativeTransfers: [{ fromUserAccount: 'LATER', toUserAccount: 'W', amount: 5e9 }] },
    { timestamp: now - 60, nativeTransfers: [{ fromUserAccount: 'FUNDER', toUserAccount: 'W', amount: 2e9 }] },
    { timestamp: now - 120, nativeTransfers: [{ fromUserAccount: 'DUST', toUserAccount: 'W', amount: 1e6 }] },
  ];
  const info = summarizeWallet('W', txs, now);
  assert.equal(info.funder, 'FUNDER');
  assert.equal(info.fresh, true);
});

test('momentum rewards organic buying and punishes dumps', () => {
  const coin = makeCoin();
  let v = 1_063_000_000;
  for (let i = 0; i < 40; i++) {
    v -= 6_000_000;
    coin.applyTrade({ signature: `s${i}`, traderPublicKey: `U${i}`, txType: 'buy', tokenAmount: 6e6, solAmount: 0.5,
      newTokenBalance: 6e6, vTokensInBondingCurve: v, marketCapSol: 30 + i }, T0 + 60_000 + i * 2000);
  }
  const good = analyzeMomentum(coin, T0 + 140_000);
  assert.ok(good.score >= 60, `score ${good.score}`);
  for (let i = 0; i < 40; i++) {
    v += 6_000_000;
    coin.applyTrade({ signature: `x${i}`, traderPublicKey: `U${i}`, txType: 'sell', tokenAmount: 6e6, solAmount: 0.6,
      newTokenBalance: 0, vTokensInBondingCurve: v, marketCapSol: 70 - i }, T0 + 141_000 + i * 1000);
  }
  const bad = analyzeMomentum(coin, T0 + 182_000);
  assert.ok(bad.score < good.score - 30, `${bad.score} vs ${good.score}`);
});

test('dev sell is tracked', () => {
  const coin = makeCoin();
  coin.applyTrade({ signature: 'd', traderPublicKey: 'DEV', txType: 'sell', tokenAmount: 10_000_000, solAmount: 0.3, newTokenBalance: 0 }, T0 + 5000);
  assert.ok(coin.devSold);
  assert.equal(Math.round(coin.devSoldPct), 100);
});

test('social links parse', () => {
  assert.deepEqual(socialKey('https://x.com/elonmusk/status/123'), { kind: 'tweet', key: 'tweet:123', author: 'elonmusk' });
  assert.equal(socialKey('https://twitter.com/i/communities/999').key, 'xc:999');
  assert.equal(socialKey('https://x.com/SomeCoin').key, 'x:somecoin');
  assert.equal(socialKey('https://t.me/somecoin').key, 'tg:somecoin');
  assert.equal(socialKey(''), null);
});

test('trend tracker learns the running meta and boosts matching coins', () => {
  const t = new TrendTracker();
  for (const name of ['Robot Hamster', 'Hamster King', 'Space Hamster']) t.recordRunner({ mint: name, name, symbol: 'X', meta: {} }, T0);
  assert.equal(t.hotThemes(T0)[0].word, 'hamster');
  const coin = { name: 'Baby Hamster', symbol: 'BHAM', meta: { twitter: 'https://x.com/a/status/1', description: '' } };
  const r = ruleNarrative(coin, { hotThemes: t.hotThemes(T0), copies: 0, sameTweetCoins: 0, recycledSocials: [] });
  const r2 = ruleNarrative({ ...coin, name: 'Random Thing' }, { hotThemes: t.hotThemes(T0), copies: 0, sameTweetCoins: 0, recycledSocials: [] });
  assert.ok(r.score > r2.score);
  assert.deepEqual(words('The HAMSTER coin!!'), ['hamster']);
});

test('AVOID caps the total score', () => {
  const s = combine({ verdict: 'AVOID', score: 20 }, { score: 100 }, { score: 100 });
  assert.ok(s.score <= 30);
  assert.equal(s.light, '🔴');
});

test('store tracks dev launches, social reuse and alert outcomes', () => {
  const st = new Store(':memory:');
  for (let i = 0; i < 3; i++) st.addLaunch({ mint: `M${i}`, creator: 'DEV', symbol: 'A', name: 'a', createdAt: Date.now() });
  assert.equal(st.devLaunches('DEV', Date.now() - 1000), 3);
  st.setSocials('M0', 'x:foo', null);
  st.setSocials('M1', 'x:foo', null);
  assert.deepEqual(st.socialReuse('x:foo', 'M1'), ['M0']);
  const coin = makeCoin(); coin.mcSol = 40;
  st.addAlert(coin, 'fresh', { score: 70, safety: { verdict: 'SAFE' }, narrative: { score: 60 }, momentum: { score: 70 } });
  st.updatePeak('MINT', 100, false);
  const s = st.stats();
  assert.equal(s.alerts, 1);
  assert.equal(s.hit2x, 100);
});

test('ntfy alert payload has title, CA, tap link and buttons', async () => {
  const { Ntfy } = await import('../src/notify.js');
  const { alertNotification } = await import('../src/score.js');
  const coin = makeCoin();
  const r = { score: 78, light: '🟢',
    safety: { verdict: 'SAFE', score: 90, flags: [{ level: 'ok', text: 'No bundle at launch' }] },
    narrative: { score: 70, theme: 'hamster', summary: 'fits meta', redFlags: [] },
    momentum: { score: 75, holders: 40, progressPerMin: 5, buySellRatio: 2, uniqueBuyers2m: 20 } };
  const n = alertNotification(coin, r, 'fresh', { padreTemplate: 'https://padre.example/{mint}', dashboardUrl: 'http://d' });
  assert.equal(n.title, '🟢 $TST 78/100 · NEW PAIR');
  assert.ok(n.message.endsWith('CA: MINT'));
  assert.equal(n.click, 'https://padre.example/MINT');
  assert.equal(n.priority, 5);
  const p = new Ntfy({ topic: 'secret' }).payload(n);
  assert.equal(p.topic, 'secret');
  assert.deepEqual(p.actions.map((a) => a.label), ['Padre', 'pump.fun', 'Dashboard']);
  assert.ok(p.actions.every((a) => a.action === 'view'));
});
