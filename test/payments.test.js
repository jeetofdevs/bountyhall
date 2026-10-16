// Token payments on NEAR, end to end: the real app and the real RPC adapter
// (src/chain.js) against the scripted node in test/support/fake-near.js.
// Wallet signatures are real NEP-413 signatures; transactions are real signed
// NEAR transactions that the fake node decodes and checks.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.js';
import { createChain } from '../src/chain.js';
import { b58encode } from '../src/near.js';
import { advanceClock, resetClock, MINUTE } from '../src/util.js';
import { createFakeNear, signChallenge } from './support/fake-near.js';

const TREASURY = 'bountyhall.near';
const TOKEN = 'musebook.near';
const SEED = Buffer.alloc(32, 7);

let app, base, node;
before(async () => {
  process.env.ADMIN_TOKEN = 'admin-secret';
  process.env.SIGNUP_PER_HOUR = '1000';
  node = createFakeNear({ token: TOKEN });
  const { keyPairFromString } = await import('../src/near.js');
  node.addAccount(TREASURY, { keyPair: keyPairFromString(`ed25519:${b58encode(SEED)}`) });
  node.mint(TREASURY, 0);
  const config = {
    mode: 'token', networkId: 'mainnet', networkName: 'NEAR Protocol', rpcUrl: 'https://rpc.test', token: TOKEN, symbol: 'MUSEBOOK',
    explorer: 'https://explorer.test', indexerUrl: 'https://indexer.test', accountId: TREASURY, privateKey: `ed25519:${b58encode(SEED)}`,
    minWithdrawal: 100, maxWithdrawalPerDay: 0, recipient: 'bountyhall.lol',
  };
  app = createApp({ dbFile: ':memory:', sweepMs: 0, judge: async () => null, payments: { config, chain: createChain({ ...config, fetch: node.fetch }), pollMs: 0 } });
  await new Promise((r) => app.server.listen(0, r));
  base = `http://127.0.0.1:${app.server.address().port}`;
  await app.payments.poll();
});
after(() => { resetClock(); app.server.closeAllConnections(); app.server.close(); });

async function call(method, path, { key, body } = {}) {
  const res = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}
const ok = async (p) => { const r = await p; assert.ok(r.status < 300, `got ${r.status}: ${JSON.stringify(r.data)}`); return r.data; };
const fails = async (p, status, code) => { const r = await p; assert.equal(r.status, status, JSON.stringify(r.data)); if (code) assert.equal(r.data.code, code); return r.data; };
const adminCall = (method, path, body) => call(method, path, { key: 'admin-secret', body });
let n = 0;
async function signup(kind = 'agent', { fund = 0 } = {}) {
  const o = await ok(call('POST', '/api/accounts', { body: { name: `p${kind}${++n}`, kind } }));
  const near = `user${n}.near`;
  const keyPair = node.addAccount(near);
  if (fund) node.mint(near, fund);
  return { ...o.account, key: o.api_key, near, keyPair };
}
async function link(user, { near = user.near, keyPair = user.keyPair } = {}) {
  const ch = await ok(call('GET', `/api/wallet/challenge?account_id=${near}`, { key: user.key }));
  return ok(call('POST', '/api/wallet/link', { key: user.key, body: signChallenge(keyPair, ch) }));
}
const balance = async (u) => (await ok(call('GET', '/api/me', { key: u.key }))).balance;
// a user sends tokens and reports the hash, as the wallet page does
async function deposit(u, whole, opts = {}) {
  const hash = node.userTransfer(u.near, TREASURY, whole, opts);
  const report = await ok(call('POST', '/api/wallet/deposits', { key: u.key, body: { tx_hash: hash } }));
  return { hash, report };
}
const settle = async () => { node.include(); node.finalize(); await app.payments.poll(); };
const solvent = async () => { const t = await ok(adminCall('GET', '/api/admin/treasury')); assert.equal(t.solvent, true, JSON.stringify(t)); assert.equal(app.market.ledgerTotal(), 0); return t; };

test('token mode on NEAR: public config, no free credits, labels on the site', async () => {
  const cfg = await ok(call('GET', '/api/payments'));
  assert.equal(cfg.mode, 'token');
  assert.equal(cfg.symbol, 'MUSEBOOK');
  assert.equal(cfg.network, 'NEAR Protocol');
  assert.equal(cfg.token_contract, TOKEN);
  assert.equal(cfg.deposit_account, TREASURY);
  assert.equal(cfg.decimals, 18);
  assert.equal(cfg.ready, true);
  const u = await signup('human');
  assert.equal(u.balance, 0, 'no unbacked signup credits in token mode');
  await fails(call('POST', '/api/intents', { key: u.key, body: { title: 'Needs money', body: 'This should fail without a deposit.', budget: 10 } }), 402);
  const html = await (await fetch(base + '/')).text();
  assert.match(html, /MUSEBOOK in escrow/);
  assert.match(html, /href="\/wallet"/);
  const wallet = await (await fetch(base + '/wallet')).text();
  assert.match(wallet, /NEAR Protocol/);
  assert.match(wallet, new RegExp(TREASURY));
  assert.match(wallet, new RegExp(TOKEN));
  assert.doesNotMatch(wallet, /Robinhood|0x[0-9a-fA-F]{40}/);
  const wk = await ok(call('GET', '/.well-known/bountyhall.json'));
  assert.equal(wk.payments.token_contract, TOKEN);
  const status = await ok(call('GET', '/api/status'));
  assert.equal(status.payments.network, 'NEAR Protocol');
});

test('wallet linking with NEP-413: real signatures, full-access keys, single-use challenges', async () => {
  const a = await signup('human'); const b = await signup('human');
  await fails(call('GET', '/api/wallet/challenge?account_id=Not_Valid!', { key: a.key }), 400);
  await fails(call('GET', '/api/wallet/challenge?account_id=alice..near', { key: a.key }), 400);
  await fails(call('POST', '/api/wallet/link', { key: a.key, body: { account_id: a.near, public_key: a.keyPair.publicKey, signature: Buffer.alloc(64).toString('base64') } }), 400, 'no_challenge');
  const ch = await ok(call('GET', `/api/wallet/challenge?account_id=${a.near}`, { key: a.key }));
  assert.match(ch.message, /Bountyhall wallet link/);
  assert.match(ch.message, new RegExp(a.near));
  assert.equal(ch.recipient, 'bountyhall.lol');
  assert.equal(Buffer.from(ch.nonce, 'base64').length, 32);
  // malformed input
  await fails(call('POST', '/api/wallet/link', { key: a.key, body: { account_id: a.near, public_key: 'nope', signature: 'x' } }), 400, 'invalid_input');
  // signed by b's key: rejected, and the challenge is spent
  await fails(call('POST', '/api/wallet/link', { key: a.key, body: { ...signChallenge(b.keyPair, ch), account_id: a.near } }), 400, 'bad_signature');
  await fails(call('POST', '/api/wallet/link', { key: a.key, body: signChallenge(a.keyPair, ch) }), 400, 'no_challenge');
  // a valid signature for a different recipient (phishing site) does not work
  const ch1 = await ok(call('GET', `/api/wallet/challenge?account_id=${a.near}`, { key: a.key }));
  await fails(call('POST', '/api/wallet/link', { key: a.key, body: signChallenge(a.keyPair, { ...ch1, recipient: 'evil.example' }) }), 400, 'bad_signature');
  // a function-call key cannot link the account
  const fnKey = node.addAccount(a.near, { keyPair: node.newKeyPair(), permission: 'FunctionCall' });
  const ch2 = await ok(call('GET', `/api/wallet/challenge?account_id=${a.near}`, { key: a.key }));
  await fails(call('POST', '/api/wallet/link', { key: a.key, body: signChallenge(fnKey, ch2) }), 400, 'bad_signature');
  // expired
  const ch3 = await ok(call('GET', `/api/wallet/challenge?account_id=${a.near}`, { key: a.key }));
  advanceClock(11 * MINUTE);
  await fails(call('POST', '/api/wallet/link', { key: a.key, body: signChallenge(a.keyPair, ch3) }), 400, 'challenge_expired');
  resetClock();
  const linked = await link(a);
  assert.equal(linked.account_id, a.near);
  // upper-case input is normalised to the account id
  const w = await ok(call('GET', '/api/wallet', { key: a.key }));
  assert.equal(w.wallet.account_id, a.near);
  assert.equal(w.deposit_account, TREASURY);
  // b cannot take a's account, even with a valid signature from it
  const ch4 = await ok(call('GET', `/api/wallet/challenge?account_id=${a.near.toUpperCase()}`, { key: b.key }));
  assert.equal(ch4.account_id, a.near);
  await fails(call('POST', '/api/wallet/link', { key: b.key, body: signChallenge(a.keyPair, ch4) }), 409, 'wallet_taken');
  // a brand-new implicit account links with the key it is named after
  const fresh = node.newKeyPair();
  const implicit = Buffer.from((await import('../src/near.js')).b58decode(fresh.publicKey.slice(8))).toString('hex');
  const ch5 = await ok(call('GET', `/api/wallet/challenge?account_id=${implicit}`, { key: b.key }));
  assert.equal((await ok(call('POST', '/api/wallet/link', { key: b.key, body: signChallenge(fresh, ch5) }))).account_id, implicit);
  await fails(call('GET', '/api/wallet'), 401);
});

test('deposits: verified on-chain, credited only when final, never twice, unclaimed until linked', async () => {
  const u = await signup('human', { fund: 100_000 });
  await link(u);
  // not final yet: reported, pending
  const { hash, report } = await deposit(u, 50_000, { final: false });
  assert.equal(report.status, 'pending');
  assert.match(report.error, /finality/);
  assert.equal(await balance(u), 0);
  node.finalize();
  await app.payments.poll();
  assert.equal(await balance(u), 50_000);
  const seen = await ok(call('GET', `/api/wallet/deposits/${hash}`, { key: u.key }));
  assert.equal(seen.status, 'done');
  assert.equal(seen.deposits[0].credited, 50_000);
  assert.equal(seen.explorer_url, `https://explorer.test/txns/${hash}`);
  // reporting the same hash again changes nothing
  await ok(call('POST', '/api/wallet/deposits', { key: u.key, body: { tx_hash: hash } }));
  app.db.prepare("UPDATE deposit_reports SET status = 'pending' WHERE tx_hash = ?").run(hash); // even a re-check
  await app.payments.poll();
  assert.equal(await balance(u), 50_000);
  // fractions of a token are not credited; pure dust is recorded as dust
  await deposit(u, 0, { raw: 7n * node.unit + node.unit / 2n });
  await deposit(u, 0, { raw: 12345n });
  assert.equal(await balance(u), 50_007);
  const w = await ok(call('GET', '/api/wallet', { key: u.key }));
  assert.equal(w.deposits.length, 2, 'dust is not attributed to the account');
  // ft_transfer_call to a plain account refunds itself: nothing to credit
  const { report: back } = await deposit(u, 1_000, { call: true });
  assert.equal(back.status, 'no_deposit');
  assert.equal(await balance(u), 50_007);
  // a failed transfer, and a transfer to someone else
  assert.equal((await deposit(u, 10_000_000)).report.status, 'no_deposit');
  const other = node.userTransfer(u.near, 'user1.near', 1);
  assert.equal((await ok(call('POST', '/api/wallet/deposits', { key: u.key, body: { tx_hash: other } }))).status, 'no_deposit');
  // bad input and unknown hashes
  await fails(call('POST', '/api/wallet/deposits', { key: u.key, body: { tx_hash: '0xabc' } }), 400);
  const ghost = b58encode(Buffer.alloc(32, 1));
  assert.equal((await ok(call('POST', '/api/wallet/deposits', { key: u.key, body: { tx_hash: ghost } }))).status, 'pending');
  advanceClock(61 * MINUTE);
  await app.payments.poll();
  resetClock();
  assert.equal((await ok(call('GET', `/api/wallet/deposits/${ghost}`, { key: u.key }))).status, 'not_found');
  // a stranger sends tokens before linking (another user reports it): held, then claimed on link
  const late = await signup('human', { fund: 900 });
  const lateHash = node.userTransfer(late.near, TREASURY, 900);
  await ok(call('POST', '/api/wallet/deposits', { key: u.key, body: { tx_hash: lateHash, sender: late.near } }));
  assert.equal(await balance(u), 50_007, 'reporting someone else’s deposit credits them, not you');
  assert.equal((await ok(adminCall('GET', '/api/admin/treasury'))).unclaimed_deposits, 900);
  const linked = await link(late);
  assert.equal(linked.claimed_deposits, 1);
  assert.equal(linked.claimed_amount, 900);
  assert.equal(await balance(late), 900);
  await solvent();
});

test('deposits nobody reported are found through the indexer and verified on-chain', async () => {
  const u = await signup('human', { fund: 5_000 }); await link(u);
  const hash = node.userTransfer(u.near, TREASURY, 4_000);
  node.state.indexer = [
    { transaction_hash: hash, involved_account_id: u.near, delta_amount: '4000', ft: { contract: TOKEN } },
    // a lying indexer row: the chain says this transaction moved nothing to the treasury
    { transaction_hash: node.userTransfer(u.near, 'user1.near', 1), involved_account_id: u.near, delta_amount: '999999', ft: { contract: TOKEN } },
  ];
  app.payments.lastIndexScan = 0;
  await app.payments.poll();
  assert.equal(await balance(u), 4_000);
  // an indexer outage is reported but never blocks payments
  node.state.indexerDown = true; app.payments.lastIndexScan = 0;
  const p = await app.payments.poll();
  assert.equal(p.error, undefined);
  assert.match((await ok(adminCall('GET', '/api/admin/treasury'))).indexer, /error: indexer returned 503/);
  node.state.indexerDown = false; node.state.indexer = []; app.payments.lastIndexScan = 0;
  await app.payments.poll();
  assert.equal((await ok(adminCall('GET', '/api/admin/treasury'))).indexer, 'ok', 'recovers on the next scan');
  await solvent();
});

test('a job paid in MUSEBOOK, withdrawn on NEAR after admin approval', async () => {
  const poster = await signup('human', { fund: 10_000 }); const solver = await signup();
  await link(poster); await link(solver);
  await deposit(poster, 10_000);
  const i = await ok(call('POST', '/api/intents', { key: poster.key, body: { title: 'Logo in MUSEBOOK', body: 'A clean SVG logo, paid on NEAR.', budget: 8_000 } }));
  const bid = await ok(call('POST', `/api/intents/${i.id}/bids`, { key: solver.key, body: { price: 6_000, eta_hours: 2, pitch: 'Clean SVG logo, two variants.' } }));
  await ok(call('POST', `/api/intents/${i.id}/award`, { key: poster.key, body: { bid_id: bid.id } }));
  await ok(call('POST', `/api/intents/${i.id}/deliver`, { key: solver.key, body: { content: '<svg/>' } }));
  await ok(call('POST', `/api/intents/${i.id}/accept`, { key: poster.key, body: { rating: 5 } }));
  assert.equal(await balance(solver), 5_850, '6000 minus the 2.5% fee');
  assert.equal(await balance(poster), 4_000);
  await solvent();

  // withdrawal rules
  const nobody = await signup();
  await fails(call('POST', '/api/wallet/withdraw', { key: nobody.key, body: { amount: 100 } }), 409, 'no_wallet');
  await fails(call('POST', '/api/wallet/withdraw', { key: solver.key, body: { amount: 50 } }), 400);
  await fails(call('POST', '/api/wallet/withdraw', { key: solver.key, body: { amount: 999_999 } }), 402);
  const w = await ok(call('POST', '/api/wallet/withdraw', { key: solver.key, body: { amount: 5_000 } }));
  assert.equal(w.status, 'pending');
  assert.equal(w.to_account, solver.near);
  assert.equal(await balance(solver), 850, 'held while pending');
  // cannot change wallets while a withdrawal is open
  const otherKey = node.addAccount('switch.near');
  const ch = await ok(call('GET', '/api/wallet/challenge?account_id=switch.near', { key: solver.key }));
  await fails(call('POST', '/api/wallet/link', { key: solver.key, body: signChallenge(otherKey, ch) }), 409, 'withdrawal_open');

  // admin only
  await fails(call('POST', `/api/admin/withdrawals/${w.id}/approve`, { key: solver.key }), 401);
  const queue = await ok(adminCall('GET', '/api/admin/withdrawals?status=pending'));
  assert.ok(queue.withdrawals.some((x) => x.id === w.id && x.account_balance === 850 && x.wallet_linked_at));
  const [first, second] = await Promise.all([adminCall('POST', `/api/admin/withdrawals/${w.id}/approve`), adminCall('POST', `/api/admin/withdrawals/${w.id}/approve`)]);
  assert.deepEqual([first.status, second.status].sort(), [200, 409], 'double approval sends once');
  const sending = (first.status === 200 ? first : second).data;
  assert.equal(sending.status, 'sending');
  assert.match(sending.tx_hash, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  assert.equal(node.state.pool.length, 1);
  const [t] = node.state.pool;
  assert.equal(t.signerId, TREASURY);
  assert.equal(t.receiverId, TOKEN);
  const ft = t.actions.find((a) => a.methodName === 'ft_transfer');
  assert.equal(ft.args.receiver_id, solver.near);
  assert.equal(BigInt(ft.args.amount), 5_000n * node.unit, 'sends whole tokens scaled by decimals');
  assert.equal(ft.deposit, 1n, 'ft_transfer carries exactly 1 yoctoNEAR');
  assert.equal(ft.args.memo, `Bountyhall withdrawal ${w.id}`);
  node.include();
  await app.payments.poll();
  assert.equal((await ok(call('GET', '/api/wallet', { key: solver.key }))).withdrawals[0].status, 'sending', 'waits for finality');
  node.finalize();
  await app.payments.poll();
  const done = (await ok(call('GET', '/api/wallet', { key: solver.key }))).withdrawals[0];
  assert.equal(done.status, 'confirmed');
  assert.equal(done.explorer_url, `https://explorer.test/txns/${sending.tx_hash}`);
  assert.equal(node.balance(solver.near), 5_000n * node.unit, 'the tokens arrived on NEAR');
  assert.equal(await balance(solver), 850);
  await solvent();
});

test('withdrawals to an unregistered account pay its storage first', async () => {
  const u = await signup('agent', { fund: 2_000 });
  await link(u);
  await deposit(u, 2_000);
  node.state.registered.delete(u.near); // e.g. the user unregistered after depositing
  const w = await ok(call('POST', '/api/wallet/withdraw', { key: u.key, body: { amount: 1_000 } }));
  await ok(adminCall('POST', `/api/admin/withdrawals/${w.id}/approve`));
  assert.deepEqual(node.state.pool[0].actions.map((a) => a.methodName), ['storage_deposit', 'ft_transfer']);
  await settle();
  assert.equal((await ok(call('GET', '/api/wallet', { key: u.key }))).withdrawals[0].status, 'confirmed');
  assert.equal(node.balance(u.near), 1_000n * node.unit);
  await solvent();
});

test('withdrawals: rejection, failed transfers, dropped transfers and an empty treasury', async () => {
  const u = await signup('agent', { fund: 3_000 }); await link(u);
  await deposit(u, 3_000);

  // rejected: money comes back
  const r = await ok(call('POST', '/api/wallet/withdraw', { key: u.key, body: { amount: 1_000 } }));
  await fails(adminCall('POST', `/api/admin/withdrawals/${r.id}/reject`, {}), 400);
  const rej = await ok(adminCall('POST', `/api/admin/withdrawals/${r.id}/reject`, { reason: 'Please verify first.' }));
  assert.equal(rej.status, 'rejected');
  assert.equal(await balance(u), 3_000);
  await fails(adminCall('POST', `/api/admin/withdrawals/${r.id}/approve`), 409);

  // fails on-chain: refunded automatically
  const rv = await ok(call('POST', '/api/wallet/withdraw', { key: u.key, body: { amount: 500 } }));
  await ok(adminCall('POST', `/api/admin/withdrawals/${rv.id}/approve`));
  node.state.failNextReceipt = true;
  await settle();
  assert.equal((await ok(adminCall('GET', '/api/admin/withdrawals'))).withdrawals.find((x) => x.id === rv.id).status, 'failed');
  assert.equal(await balance(u), 3_000);

  // broadcast fails: stays "sending"; refund refused while it could still land
  node.state.failSend = true;
  const dr = await ok(call('POST', '/api/wallet/withdraw', { key: u.key, body: { amount: 700 } }));
  const s = await ok(adminCall('POST', `/api/admin/withdrawals/${dr.id}/approve`));
  assert.equal(s.status, 'sending');
  assert.match(s.error, /broadcast failed/);
  await fails(adminCall('POST', `/api/admin/withdrawals/${dr.id}/refund`), 409, 'not_dropped');
  // rebroadcast works once the RPC is back; then it is on-chain and cannot be refunded
  node.state.failSend = false;
  const rb = await ok(adminCall('POST', `/api/admin/withdrawals/${dr.id}/rebroadcast`));
  assert.equal(rb.error, null);
  node.include();
  await fails(adminCall('POST', `/api/admin/withdrawals/${dr.id}/refund`), 409, 'mined');
  node.finalize(); await app.payments.poll();
  assert.equal((await ok(adminCall('GET', '/api/admin/withdrawals'))).withdrawals.find((x) => x.id === dr.id).status, 'confirmed');

  // a transfer that never reaches the chain and whose block hash expires: refundable
  node.state.failSend = true;
  const lost = await ok(call('POST', '/api/wallet/withdraw', { key: u.key, body: { amount: 300 } }));
  await ok(adminCall('POST', `/api/admin/withdrawals/${lost.id}/approve`));
  node.state.failSend = false;
  await fails(adminCall('POST', `/api/admin/withdrawals/${lost.id}/refund`), 409, 'not_dropped');
  node.advance(86_401);
  const refunded = await ok(adminCall('POST', `/api/admin/withdrawals/${lost.id}/refund`));
  assert.equal(refunded.status, 'refunded');
  assert.equal(await balance(u), 3_000 - 700);

  // treasury cannot cover it: nothing is signed, request goes back to pending
  const big = await signup('agent', { fund: 1_000 }); await link(big);
  await deposit(big, 1_000);
  const saved = node.state.balances.get(TREASURY);
  node.state.balances.set(TREASURY, 10n * node.unit);
  const b = await ok(call('POST', '/api/wallet/withdraw', { key: big.key, body: { amount: 1_000 } }));
  await fails(adminCall('POST', `/api/admin/withdrawals/${b.id}/approve`), 502, 'send_failed');
  const back = (await ok(adminCall('GET', '/api/admin/withdrawals?status=pending'))).withdrawals.find((x) => x.id === b.id);
  assert.match(back.error, /treasury holds 10 MUSEBOOK/);
  node.state.balances.set(TREASURY, saved);
  await ok(adminCall('POST', `/api/admin/withdrawals/${b.id}/reject`, { reason: 'test cleanup' }));
  await solvent();
});

test('a pruned RPC never refunds an old transfer it cannot see', async () => {
  const u = await signup('agent', { fund: 1_000 }); await link(u);
  await deposit(u, 1_000);
  node.state.failSend = true;
  const w = await ok(call('POST', '/api/wallet/withdraw', { key: u.key, body: { amount: 1_000 } }));
  await ok(adminCall('POST', `/api/admin/withdrawals/${w.id}/approve`));
  node.state.failSend = false;
  node.advance(10); node.forgetBlocks();
  await fails(adminCall('POST', `/api/admin/withdrawals/${w.id}/refund`), 409, 'too_old');
  // clean up: mark it as refunded the slow way an operator would after checking the explorer
  app.db.prepare("UPDATE withdrawals SET status = 'pending' WHERE id = ?").run(w.id);
  await ok(adminCall('POST', `/api/admin/withdrawals/${w.id}/reject`, { reason: 'cleanup' }));
  await solvent();
});

test('treasury report, NEAR outages and the admin desk page', async () => {
  const t = await ok(adminCall('GET', '/api/admin/treasury'));
  assert.equal(t.owed_total, t.held_by_users + t.in_escrow + t.fees + t.pending_withdrawals);
  assert.equal(t.surplus, t.onchain_balance - t.owed_total);
  assert.equal(t.unbacked_signup_credits, 0);
  assert.equal(t.account, TREASURY);
  assert.equal(t.near_balance, '1.0000');
  await fails(call('GET', '/api/admin/treasury'), 401);
  // missing tokens show up as insolvency
  const saved = node.state.balances.get(TREASURY);
  node.state.balances.set(TREASURY, 0n);
  assert.equal((await ok(adminCall('GET', '/api/admin/treasury'))).solvent, false);
  node.state.balances.set(TREASURY, saved);
  // RPC outage: reporting a deposit says so, polling reports the error and keeps state
  const u = await signup('human', { fund: 10 }); await link(u);
  const hash = node.userTransfer(u.near, TREASURY, 10);
  node.state.down = true;
  const rep = await ok(call('POST', '/api/wallet/deposits', { key: u.key, body: { tx_hash: hash } }));
  assert.equal(rep.status, 'pending');
  const p = await app.payments.poll();
  assert.match(p.error, /RPC unreachable/);
  node.state.down = false;
  assert.equal((await app.payments.poll()).error, undefined);
  assert.equal(await balance(u), 10, 'credited once NEAR is reachable again');
  const html = await (await fetch(base + '/admin')).text();
  assert.match(html, /Admin token/);
  await solvent();
});

test('credits mode keeps payments off; a half-configured token mode explains itself', async () => {
  const plain = createApp({ dbFile: ':memory:', sweepMs: 0, payments: { config: { mode: 'credits' } } });
  await new Promise((r) => plain.server.listen(0, r));
  const b = `http://127.0.0.1:${plain.server.address().port}`;
  try {
    assert.equal((await (await fetch(b + '/api/payments')).json()).mode, 'credits');
    assert.equal((await fetch(b + '/api/wallet/challenge?account_id=a.near')).status, 404);
  } finally { plain.server.closeAllConnections(); plain.server.close(); }

  const half = createApp({ dbFile: ':memory:', sweepMs: 0, payments: { pollMs: 0, config: { mode: 'token', networkId: 'mainnet', networkName: 'NEAR Protocol', rpcUrl: 'https://rpc.test', token: null, symbol: 'MUSEBOOK', explorer: 'https://x', indexerUrl: null, accountId: 'bountyhall.near', minWithdrawal: 1, recipient: 'bountyhall.lol' } } });
  await new Promise((r) => half.server.listen(0, r));
  const h = `http://127.0.0.1:${half.server.address().port}`;
  try {
    await half.payments.poll();
    const cfg = await (await fetch(h + '/api/payments')).json();
    assert.equal(cfg.ready, false);
    const health = await (await fetch(h + '/api/admin/health', { headers: { Authorization: 'Bearer admin-secret' } })).json();
    const conn = health.checks.find((c) => c.item === 'NEAR connection');
    assert.equal(conn.level, 'error');
    assert.match(conn.detail, /TOKEN_CONTRACT is not set/);
    assert.equal((await fetch(h + '/wallet')).status, 200, 'the site stays up');
  } finally {
    half.server.closeAllConnections(); half.server.close();
    (await import('../src/views.js')).setUnit('MUSEBOOK');
  }
});

test('agents: solver.md explains NEAR payments, MCP exposes the wallet and deposit reports', async () => {
  const md = await (await fetch(base + '/solver.md')).text();
  assert.match(md, /## Payments in MUSEBOOK/);
  assert.match(md, new RegExp(TREASURY));
  assert.match(md, new RegExp(TOKEN));
  assert.match(md, /NEP-413/);
  assert.match(md, /ft_transfer/);
  assert.doesNotMatch(md, /free test credits|viem|0x/);
  const u = await signup('agent', { fund: 2_000 }); await link(u);
  const hash = node.userTransfer(u.near, TREASURY, 2_000);
  const rpc = async (name, args) => {
    const res = await fetch(base + '/mcp', { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${u.key}` }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    return (await res.json()).result;
  };
  const rep = JSON.parse((await rpc('report_deposit', { tx_hash: hash })).content[0].text);
  assert.equal(rep.status, 'done');
  const w = JSON.parse((await rpc('my_wallet', {})).content[0].text);
  assert.equal(w.balance, 2_000);
  assert.equal(w.wallet.account_id, u.near);
  assert.equal(w.deposit_account, TREASURY);
  assert.equal(w.config.symbol, 'MUSEBOOK');
  const req = await rpc('request_withdrawal', { amount: 1_500 });
  assert.equal(req.isError, false);
  assert.equal(JSON.parse(req.content[0].text).status, 'pending');
  const tooMuch = await rpc('request_withdrawal', { amount: 1_000 });
  assert.equal(tooMuch.isError, true);
  assert.match(tooMuch.content[0].text, /insufficient/);
  await ok(adminCall('POST', `/api/admin/withdrawals/${JSON.parse(req.content[0].text).id}/reject`, { reason: 'cleanup' }));
  await solvent();
});

test('a withdrawal interrupted mid-signing goes back to the queue on restart', async () => {
  const u = await signup('agent', { fund: 1_000 }); await link(u);
  await deposit(u, 1_000);
  const w = await ok(call('POST', '/api/wallet/withdraw', { key: u.key, body: { amount: 1_000 } }));
  app.db.prepare("UPDATE withdrawals SET status = 'signing' WHERE id = ?").run(w.id); // simulate a crash
  await app.payments.init();
  const back = (await ok(adminCall('GET', '/api/admin/withdrawals?status=pending'))).withdrawals.find((x) => x.id === w.id);
  assert.match(back.error, /interrupted/);
  await ok(adminCall('POST', `/api/admin/withdrawals/${w.id}/reject`, { reason: 'cleanup' }));
  await solvent();
});

test('EVM wallets left from before the move to NEAR are unlinked; their queued withdrawals come back', async () => {
  const u = await signup('agent', { fund: 500 }); await link(u);
  await deposit(u, 500);
  const evm = '0x91A2DAe9699f0B82540B5886b0d8759C22820bA3';
  app.db.prepare('UPDATE wallets SET address = ? WHERE account_id = ?').run(evm, u.id);
  const w = await ok(call('POST', '/api/wallet/withdraw', { key: u.key, body: { amount: 500 } }));
  assert.equal(w.to_account, evm);
  await app.payments.init();
  assert.equal((await ok(call('GET', '/api/wallet', { key: u.key }))).wallet, null);
  const back = (await ok(adminCall('GET', '/api/admin/withdrawals'))).withdrawals.find((x) => x.id === w.id);
  assert.equal(back.status, 'rejected');
  assert.match(back.note, /moved to NEAR/);
  assert.equal(await balance(u), 500);
  await solvent();
});

test('operator payouts of house fees, and the setup check in token mode', async () => {
  const t0 = await ok(adminCall('GET', '/api/admin/treasury'));
  assert.ok(t0.fees > 0, 'earlier jobs left house fees');
  const to = 'operator.near';
  node.addAccount(to);
  await fails(adminCall('POST', '/api/admin/payout', { source: 'nope', amount: 1, to }), 400);
  await fails(adminCall('POST', '/api/admin/payout', { source: 'fees', amount: t0.fees + 1, to }), 402);
  await fails(adminCall('POST', '/api/admin/payout', { source: 'fees', amount: 1, to: 'not an account!' }), 400);
  const p = await ok(adminCall('POST', '/api/admin/payout', { source: 'fees', amount: t0.fees, to }));
  assert.equal(p.note, 'operator payout');
  assert.equal(p.to_account, to);
  await ok(adminCall('POST', `/api/admin/withdrawals/${p.id}/approve`));
  await settle();
  assert.equal(node.balance(to), BigInt(t0.fees) * node.unit);
  const t1 = await ok(adminCall('GET', '/api/admin/treasury'));
  assert.equal(t1.fees, 0);
  assert.equal(t1.owed_total, t0.owed_total - t0.fees, 'paying out fees reduces what the treasury owes');
  await solvent();
  const h = await ok(adminCall('GET', '/api/admin/health'));
  const byName = Object.fromEntries(h.checks.map((c) => [c.item, c]));
  assert.equal(byName['NEAR connection'].level, 'ok');
  assert.equal(byName['Treasury storage'].level, 'ok');
  assert.equal(byName['Hot wallet key'].level, 'ok');
  assert.equal(byName['NEAR for gas'].level, 'ok');
  assert.equal(byName.Solvency.level, 'ok');
  assert.equal(byName['Deposit indexer'].level, 'ok');
  assert.equal(byName['RPC endpoint'].level, 'ok');
});

test('daily withdrawal limit per account', async () => {
  app.payments.cfg.maxWithdrawalPerDay = 1_500;
  try {
    const u = await signup('agent', { fund: 5_000 }); await link(u);
    await deposit(u, 5_000);
    const a = await ok(call('POST', '/api/wallet/withdraw', { key: u.key, body: { amount: 1_000 } }));
    const over = await fails(call('POST', '/api/wallet/withdraw', { key: u.key, body: { amount: 600 } }), 429, 'daily_limit');
    assert.match(over.error, /500 left/);
    await ok(adminCall('POST', `/api/admin/withdrawals/${a.id}/reject`, { reason: 'test' }));
    const b = await ok(call('POST', '/api/wallet/withdraw', { key: u.key, body: { amount: 1_500 } }));
    await ok(adminCall('POST', `/api/admin/withdrawals/${b.id}/reject`, { reason: 'cleanup' }));
    await solvent();
  } finally {
    app.payments.cfg.maxWithdrawalPerDay = 0;
  }
});
