// Live cross-check against the official NEAR JavaScript library (near-api-js),
// installed on demand by `npm run test:near`:
//   1. src/near.js signs, serializes and verifies exactly like near-api-js, on random keys;
//   2. an agent follows the documented near-api-js snippets (NEP-413 link, ft_transfer deposit)
//      against a running Bountyhall and a NEAR JSON-RPC node over HTTP;
//   3. the withdrawal Bountyhall signs decodes and verifies with near-api-js.
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import * as N from 'near-api-js';
import * as mine from '../src/near.js';
import { createApp } from '../src/server.js';
import { createChain } from '../src/chain.js';
import { createFakeNear } from '../test/support/fake-near.js';

const log = (m) => console.log(`✓ ${m}`);
const sha = (b) => new Uint8Array(createHash('sha256').update(b).digest());

// 1. primitives on random inputs
for (let i = 0; i < 25; i++) {
  const kp = N.KeyPair.fromRandom('ed25519');
  const k = mine.keyPairFromString(kp.toString());
  assert.equal(k.publicKey, kp.getPublicKey().toString());
  const blockHash = randomBytes(32);
  const nonce = BigInt(Date.now()) * 1000n + BigInt(i);
  const args = { receiver_id: `r${i}.near`, amount: (BigInt(i + 1) * 10n ** 21n).toString(), memo: `m${i}` };
  const ref = N.encodeTransaction(N.createTransaction('t.near', kp.getPublicKey(), 'tok.near', nonce, [N.actions.functionCall('ft_transfer', args, 30n * 10n ** 12n, 1n)], blockHash));
  const tx = { signerId: 't.near', publicKey: k.publicKey, nonce, receiverId: 'tok.near', blockHash, actions: [mine.functionCall('ft_transfer', args, 30n * 10n ** 12n, 1n)] };
  assert.deepEqual(Buffer.from(mine.serializeTransaction(tx)), Buffer.from(ref));
  const signed = mine.signTransaction(tx, k);
  const dec = N.decodeSignedTransaction(Buffer.from(signed.signedBase64, 'base64'));
  assert.ok(kp.getPublicKey().verify(sha(N.encodeTransaction(dec.transaction)), Uint8Array.from(dec.signature.ed25519Signature.data)));
  assert.equal(N.baseEncode(sha(N.encodeTransaction(dec.transaction))), signed.hash);
  const payload = { message: `hello ${i}`, recipient: 'bountyhall.lol', nonce: randomBytes(32) };
  const sm = await new N.KeyPairSigner(kp).signNep413Message('a.near', payload);
  assert.ok(mine.verifyNep413({ ...payload, publicKey: sm.publicKey.toString(), signature: Uint8Array.from(sm.signature) }));
  assert.equal(mine.implicitAccountId(k.publicKey), N.keyToImplicitAddress(kp.getPublicKey()));
}
log('25 random keys: transactions, hashes, signatures and NEP-413 match near-api-js');

// 2. a NEAR node over HTTP, and Bountyhall pointed at it
const node = createFakeNear({ token: 'musebook.near' });
const rpc = createServer((req, res) => {
  let body = ''; req.on('data', (c) => (body += c));
  req.on('end', () => {
    const { id, method, params } = JSON.parse(body);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ jsonrpc: '2.0', id, ...node.handle(method, params) }));
  });
});
await new Promise((r) => rpc.listen(0, r));
const rpcUrl = `http://127.0.0.1:${rpc.address().port}`;
const treasuryKey = N.KeyPair.fromRandom('ed25519');
node.addAccount('bountyhall.near', { keyPair: mine.keyPairFromString(treasuryKey.toString()) });
const agentKey = N.KeyPair.fromRandom('ed25519');
node.addAccount('agent.near', { keyPair: mine.keyPairFromString(agentKey.toString()) });
node.mint('agent.near', 50_000);

process.env.ADMIN_TOKEN = 'e2e-admin-token-e2e-admin-token'; process.env.SIGNUP_PER_HOUR = '1000';
const config = { mode: 'token', networkId: 'mainnet', networkName: 'NEAR Protocol', rpcUrl, token: 'musebook.near', symbol: 'MUSEBOOK', explorer: 'https://nearblocks.io', indexerUrl: null, accountId: 'bountyhall.near', privateKey: treasuryKey.toString(), minWithdrawal: 100, recipient: 'bountyhall.lol' };
const app = createApp({ dbFile: ':memory:', sweepMs: 0, payments: { config, chain: createChain(config), pollMs: 0 } });
await new Promise((r) => app.server.listen(0, r));
const origin = `http://127.0.0.1:${app.server.address().port}`;
try {
  assert.equal((await app.payments.poll()).ready, true);
  const { api_key: KEY } = await (await fetch(`${origin}/api/accounts`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'e2e-agent', kind: 'agent' }) })).json();

  // --- the snippet from solver.md / docs/payments, verbatim apart from constants ---
  const ACCOUNT = 'agent.near';
  const signer = new N.KeyPairSigner(N.KeyPair.fromString(agentKey.toString()));
  const h = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };
  const ch = await (await fetch(`${origin}/api/wallet/challenge?account_id=${ACCOUNT}`, { headers: h })).json();
  const signed = await signer.signNep413Message(ACCOUNT, { message: ch.message, recipient: ch.recipient, nonce: Buffer.from(ch.nonce, 'base64') });
  const linked = await fetch(`${origin}/api/wallet/link`, { method: 'POST', headers: h, body: JSON.stringify({
    account_id: ACCOUNT, public_key: signed.publicKey.toString(), signature: Buffer.from(signed.signature).toString('base64'),
  }) });
  assert.equal(linked.status, 200, await linked.clone().text());
  log('linked agent.near with near-api-js signNep413Message');

  const account = new N.Account(ACCOUNT, new N.JsonRpcProvider({ url: rpcUrl }), signer);
  const out = await account.callFunctionRaw({ contractId: 'musebook.near', methodName: 'ft_transfer',
    args: { receiver_id: 'bountyhall.near', amount: (10_000n * 10n ** 18n).toString() }, deposit: 1n });
  const rep = await (await fetch(`${origin}/api/wallet/deposits`, { method: 'POST', headers: h, body: JSON.stringify({ tx_hash: out.transaction.hash }) })).json();
  assert.equal(rep.status, 'done', JSON.stringify(rep));
  const me = await (await fetch(`${origin}/api/me`, { headers: h })).json();
  assert.equal(me.balance, 10_000);
  log(`deposit sent with near-api-js Account.callFunctionRaw (${out.transaction.hash.slice(0, 10)}…) and credited`);

  // 3. withdrawal signed by Bountyhall, decoded and verified by near-api-js
  const w = await (await fetch(`${origin}/api/wallet/withdraw`, { method: 'POST', headers: h, body: JSON.stringify({ amount: 4_000 }) })).json();
  const ah = { Authorization: `Bearer ${process.env.ADMIN_TOKEN}` };
  const sent = await (await fetch(`${origin}/api/admin/withdrawals/${w.id}/approve`, { method: 'POST', headers: ah })).json();
  assert.equal(sent.status, 'sending', JSON.stringify(sent));
  const raw = app.db.prepare('SELECT raw_tx FROM withdrawals WHERE id = ?').get(w.id).raw_tx;
  const dec = N.decodeSignedTransaction(Buffer.from(raw, 'base64'));
  assert.equal(dec.transaction.signerId, 'bountyhall.near');
  assert.equal(dec.transaction.receiverId, 'musebook.near');
  const call = dec.transaction.actions.at(-1).functionCall;
  assert.equal(call.methodName, 'ft_transfer');
  assert.deepEqual(JSON.parse(Buffer.from(call.args).toString()), { receiver_id: 'agent.near', amount: (4_000n * 10n ** 18n).toString(), memo: `Bountyhall withdrawal ${w.id}` });
  assert.equal(BigInt(call.deposit), 1n);
  assert.ok(treasuryKey.getPublicKey().verify(sha(N.encodeTransaction(dec.transaction)), Uint8Array.from(dec.signature.ed25519Signature.data)));
  node.include(); node.finalize(); await app.payments.poll();
  const after = await (await fetch(`${origin}/api/wallet`, { headers: h })).json();
  assert.equal(after.withdrawals[0].status, 'confirmed');
  assert.equal(node.balance('agent.near'), 44_000n * 10n ** 18n);
  log('withdrawal: near-api-js decodes and verifies the signed ft_transfer; it lands and is confirmed');
  console.log('\nNEAR end-to-end check passed.');
} finally {
  app.server.closeAllConnections(); app.server.close(); rpc.close();
}
