// NEAR primitives (against vectors produced by near-api-js 7.3.1) and the RPC
// adapter in src/chain.js against the scripted node in test/support/fake-near.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  b58encode, b58decode, isAccountId, keyPairFromString, serializeTransaction, signTransaction, functionCall,
  nep413Hash, verifyNep413, implicitAccountId, toRaw, TGAS,
} from '../src/near.js';
import { createChain } from '../src/chain.js';
import { createFakeNear } from './support/fake-near.js';

// Produced with near-api-js: KeyPairSigner.signTransaction / signNep413Message.
const V = {
  secret: 'ed25519:2CNiVUkS2FjsZkw2bLksLCxVXsJot5GebHiqorSEzbmFhG7WdSsWMrtvvLNWxVfugsaqB2aQiez3sJRVuLkPsuZ',
  publicKey: 'ed25519:GM4eCsQuaLNXApYz6YYUQVMxajTaJ7dB4TbroFGBaou9',
  txHex: '0d00000074726561737572792e6e65617200e4030998cfd5ad1723c169f956aa0b9eb8619b5992bd612c2af428ebc79f8df001a09c359d9a00000d0000006d757365626f6f6b2e6e656172090909090909090909090909090909090909090909090909090909090909090902000000020f00000073746f726167655f6465706f736974320000007b226163636f756e745f6964223a22626f622e6e656172222c22726567697374726174696f6e5f6f6e6c79223a747275657d00e057eb481b00000000485637193cc34300000000000000020b00000066745f7472616e73666572600000007b2272656365697665725f6964223a22626f622e6e656172222c22616d6f756e74223a2235303030303030303030303030303030303030303030222c226d656d6f223a22426f756e747968616c6c207769746864726177616c2077645f31227d00e057eb481b000001000000000000000000000000000000',
  txHash: 'fNru2jEa2QTbrqKxxk3G13X4ZKAZmyPhiVWGyhWFMxA',
  signedB64: 'DQAAAHRyZWFzdXJ5Lm5lYXIA5AMJmM/VrRcjwWn5VqoLnrhhm1mSvWEsKvQo68efjfABoJw1nZoAAA0AAABtdXNlYm9vay5uZWFyCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkJCQkCAAAAAg8AAABzdG9yYWdlX2RlcG9zaXQyAAAAeyJhY2NvdW50X2lkIjoiYm9iLm5lYXIiLCJyZWdpc3RyYXRpb25fb25seSI6dHJ1ZX0A4FfrSBsAAAAASFY3GTzDQwAAAAAAAAACCwAAAGZ0X3RyYW5zZmVyYAAAAHsicmVjZWl2ZXJfaWQiOiJib2IubmVhciIsImFtb3VudCI6IjUwMDAwMDAwMDAwMDAwMDAwMDAwMDAiLCJtZW1vIjoiQm91bnR5aGFsbCB3aXRoZHJhd2FsIHdkXzEifQDgV+tIGwAAAQAAAAAAAAAAAAAAAAAAAAAXeoZE5hjNWRW4TKvJWo5QbmJVMuZM9vJmD62XJE8rOYwokMovamu8GguyzZU+KF9cG/3t0QQHIww7vC3ebZoO',
  nep413Sig: 'l/ETM1JmNmpX2mvUixrUoFEahLUI8HGiGHYtZgg51dZ0NxwaMZxKoZbqi5uIx7jFIB8X4mbhC/ECdYP//K7jCw==',
};
const vectorTx = (publicKey) => ({
  signerId: 'treasury.near', publicKey, nonce: 170000000000001n, receiverId: 'musebook.near', blockHash: Buffer.alloc(32, 9),
  actions: [
    functionCall('storage_deposit', { account_id: 'bob.near', registration_only: true }, 30n * TGAS, 1250000000000000000000n),
    functionCall('ft_transfer', { receiver_id: 'bob.near', amount: '5000000000000000000000', memo: 'Bountyhall withdrawal wd_1' }, 30n * TGAS, 1n),
  ],
});

test('primitives match near-api-js byte for byte', () => {
  const kp = keyPairFromString(V.secret);
  assert.equal(kp.publicKey, V.publicKey);
  assert.equal(Buffer.from(serializeTransaction(vectorTx(kp.publicKey))).toString('hex'), V.txHex);
  const signed = signTransaction(vectorTx(kp.publicKey), kp);
  assert.equal(signed.hash, V.txHash);
  assert.equal(signed.signedBase64, V.signedB64);
  const payload = { message: 'Bountyhall wallet link\nhello', nonce: Buffer.alloc(32, 3), recipient: 'bountyhall.lol' };
  assert.equal(Buffer.from(kp.sign(nep413Hash(payload))).toString('base64'), V.nep413Sig);
  assert.equal(verifyNep413({ ...payload, publicKey: V.publicKey, signature: Buffer.from(V.nep413Sig, 'base64') }), true);
  assert.equal(verifyNep413({ ...payload, recipient: 'evil.example', publicKey: V.publicKey, signature: Buffer.from(V.nep413Sig, 'base64') }), false);
  assert.equal(verifyNep413({ ...payload, publicKey: V.publicKey, signature: Buffer.alloc(10) }), false);
  // a 32-byte seed works as a secret too
  assert.equal(keyPairFromString(`ed25519:${b58encode(b58decode(V.secret.slice(8)).slice(0, 32))}`).publicKey, V.publicKey);
  assert.throws(() => keyPairFromString('secp256k1:abc'), /only ed25519/);
  assert.throws(() => signTransaction(vectorTx('ed25519:11111111111111111111111111111111'), kp), /does not match/);
});

test('base58, account ids, implicit accounts and amounts', () => {
  for (const bytes of [[0], [0, 0, 1], [255, 254], [...Buffer.from('hello world')]]) assert.deepEqual([...b58decode(b58encode(bytes))], bytes);
  assert.equal(b58encode([0, 0, 1]), '112');
  assert.throws(() => b58decode('0OIl'), /invalid base58/);
  for (const ok of ['alice.near', 'a1', 'bountyhall.tg', 'sub.app-x_y.near', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef', '0x' + 'ab'.repeat(20)]) assert.ok(isAccountId(ok), ok);
  for (const bad of ['a', 'Alice.near', 'alice..near', '.near', 'alice.', 'alice near', 'a'.repeat(65), 'al!ce.near', '-alice.near', '', null]) assert.ok(!isAccountId(bad), String(bad));
  assert.equal(implicitAccountId(V.publicKey), Buffer.from(b58decode(V.publicKey.slice(8))).toString('hex'));
  assert.equal(toRaw('1.5', 18), 1_500_000_000_000_000_000n);
  assert.equal(toRaw(7, 0), 7n);
  assert.throws(() => toRaw('1.0001', 3), /decimal places/);
  assert.throws(() => toRaw('-1', 3));
});

test('adapter: configuration errors are explicit', () => {
  assert.throws(() => createChain({ rpcUrl: 'x', networkId: 'mainnet', token: null, accountId: 'a.near' }), /TOKEN_CONTRACT is not set/);
  assert.throws(() => createChain({ rpcUrl: 'x', networkId: 'mainnet', token: '0x91A2DAe9699f0B82540B5886b0d8759C22820bA3', accountId: 'a.near' }), /not a valid NEAR account id/);
  assert.throws(() => createChain({ rpcUrl: 'x', networkId: 'mainnet', token: 't.near', accountId: null }), /NEAR_ACCOUNT_ID/);
});

test('adapter: check, deposits, signing, receipts, dropped transfers, NEP-413 and the indexer', async () => {
  const node = createFakeNear();
  const seed = Buffer.alloc(32, 42);
  const kp = keyPairFromString(`ed25519:${b58encode(seed)}`);
  node.addAccount('treasury.near', { keyPair: kp });
  const chain = createChain({ rpcUrl: 'https://rpc.test', networkId: 'mainnet', token: 'musebook.near', accountId: 'treasury.near', privateKey: `ed25519:${b58encode(seed)}`, indexerUrl: 'https://indexer.test', fetch: node.fetch });

  // check
  const info = await chain.check();
  assert.deepEqual(info, { networkId: 'mainnet', decimals: 18, symbol: 'MUSEBOOK', treasuryRegistered: true });
  const wrongNet = createChain({ rpcUrl: 'x', networkId: 'testnet', token: 'musebook.near', accountId: 'treasury.near', fetch: node.fetch });
  await assert.rejects(wrongNet.check(), /expected testnet/);
  const foreignKey = createChain({ rpcUrl: 'x', networkId: 'mainnet', token: 'musebook.near', accountId: 'treasury.near', privateKey: `ed25519:${b58encode(Buffer.alloc(32, 1))}`, fetch: node.fetch });
  await assert.rejects(foreignKey.check(), /not an access key of treasury\.near/);

  // deposits
  node.addAccount('alice.near'); node.mint('alice.near', 100);
  const h1 = node.userTransfer('alice.near', 'treasury.near', 40);
  assert.deepEqual(await chain.depositsIn(h1, 'alice.near'), { final: true, transfers: [{ from: 'alice.near', value: 40n * node.unit }] });
  assert.equal(await chain.depositsIn(h1, 'bob.near'), null, 'wrong sender: unknown');
  assert.equal(await chain.depositsIn('11111111111111111111111111111111', 'alice.near'), null);
  const pending = node.userTransfer('alice.near', 'treasury.near', 1, { final: false });
  assert.deepEqual(await chain.depositsIn(pending, 'alice.near'), { final: false });
  const refunded = node.userTransfer('alice.near', 'treasury.near', 5, { call: true });
  assert.deepEqual(await chain.depositsIn(refunded, 'alice.near'), { final: true, transfers: [] }, 'a refunded ft_transfer_call is never credited');
  const failed = node.userTransfer('alice.near', 'treasury.near', 10_000);
  assert.deepEqual(await chain.depositsIn(failed, 'alice.near'), { final: true, transfers: [] });
  const elsewhere = node.userTransfer('alice.near', 'carol.near', 1);
  assert.deepEqual((await chain.depositsIn(elsewhere, 'alice.near')).transfers, []);

  // signing: unregistered receiver gets a storage_deposit first; the node accepts the signature and nonce
  node.addAccount('bob.near', { register: false });
  const s1 = await chain.signTransfer('bob.near', 7n * node.unit, { memo: 'Bountyhall withdrawal wd_x' });
  assert.match(s1.hash, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
  assert.equal(await chain.broadcast(s1.raw), s1.hash);
  assert.equal(await chain.receipt(s1.hash), null, 'not included yet');
  node.include();
  assert.deepEqual(await chain.receipt(s1.hash), { final: false, status: 'success' });
  node.finalize();
  assert.deepEqual(await chain.receipt(s1.hash), { final: true, status: 'success' });
  assert.equal(node.balance('bob.near'), 7n * node.unit);
  const [sent] = node.sent();
  assert.deepEqual(sent.actions.map((a) => a.methodName), ['storage_deposit', 'ft_transfer']);
  assert.equal(sent.actions[1].args.memo, 'Bountyhall withdrawal wd_x');
  // registered now: a single ft_transfer
  const s2 = await chain.signTransfer('bob.near', 1n * node.unit);
  await chain.broadcast(s2.raw); node.include(); node.finalize();
  assert.deepEqual(node.sent()[1].actions.map((a) => a.methodName), ['ft_transfer']);
  // a transfer that fails on-chain
  const s3 = await chain.signTransfer('bob.near', 1n);
  node.state.failNextReceipt = true;
  await chain.broadcast(s3.raw); node.include(); node.finalize();
  assert.deepEqual(await chain.receipt(s3.hash), { final: true, status: 'reverted' });
  // replaying a signed transaction is rejected by the node (nonce already used)
  const s4 = await chain.signTransfer('bob.near', 1n);
  const s5 = await chain.signTransfer('bob.near', 2n, { minNonce: s4.nonce });
  assert.equal(s5.nonce, s4.nonce + 1, 'minNonce keeps signed-but-unsent transfers apart');
  await chain.broadcast(s5.raw);
  await assert.rejects(chain.broadcast(s4.raw), /InvalidNonce/);
  // so s4 can never land: dropped
  assert.equal(await chain.receipt(s4.hash), null);
  assert.equal(await chain.dropped({ nonce: s4.nonce, blockHash: s4.blockHash }), true);
  // a fresh signed transfer that was never broadcast is not dropped yet
  const s6 = await chain.signTransfer('bob.near', 1n, { minNonce: s5.nonce });
  assert.equal(await chain.dropped({ nonce: s6.nonce, blockHash: s6.blockHash }), false);
  // ...until its block hash expires
  node.advance(86_401);
  assert.equal(await chain.dropped({ nonce: s6.nonce, blockHash: s6.blockHash }), true);
  await assert.rejects(chain.broadcast(s6.raw), /Expired/);
  // a node that pruned the history cannot prove anything
  node.forgetBlocks();
  assert.equal(await chain.dropped({ nonce: s6.nonce, blockHash: s6.blockHash }), 'too_old');

  // balances
  assert.equal(await chain.tokenBalance('alice.near'), 59n * node.unit, '100 - 40 - 1 (not final yet, but executed)');
  assert.equal(await chain.nativeBalance('treasury.near'), 10n ** 24n);

  // NEP-413 verification: full-access key required; implicit accounts by their key
  const aliceKey = node.addAccount('dave.near');
  const fnKey = node.addAccount('erin.near', { permission: 'FunctionCall' });
  const payload = { message: 'link me', nonce: Buffer.alloc(32, 5), recipient: 'bountyhall.lol' };
  const sig = (k) => k.sign(nep413Hash(payload));
  assert.equal(await chain.verify({ accountId: 'dave.near', publicKey: aliceKey.publicKey, signature: sig(aliceKey), ...payload }), true);
  assert.equal(await chain.verify({ accountId: 'dave.near', publicKey: aliceKey.publicKey, signature: sig(fnKey), ...payload }), false, 'wrong key');
  assert.equal(await chain.verify({ accountId: 'erin.near', publicKey: fnKey.publicKey, signature: sig(fnKey), ...payload }), false, 'function-call keys cannot link');
  assert.equal(await chain.verify({ accountId: 'frank.near', publicKey: aliceKey.publicKey, signature: sig(aliceKey), ...payload }), false, 'key of another account');
  const fresh = node.newKeyPair();
  assert.equal(await chain.verify({ accountId: implicitAccountId(fresh.publicKey), publicKey: fresh.publicKey, signature: sig(fresh), ...payload }), true, 'fresh implicit account');

  // indexer hints, filtered and parsed defensively
  node.state.indexer = [
    { transaction_hash: h1, involved_account_id: 'alice.near', delta_amount: '40', ft: { contract: 'musebook.near' } },
    { transaction_hash: 'abc', involved_account_id: 'bob.near', delta_amount: '-1', ft: { contract: 'musebook.near' } },
    { transaction_hash: 'def', involved_account_id: 'carol.near', ft: { contract: 'other.near' } },
    { transaction_hash: 5, involved_account_id: 'x.near' }, null,
  ];
  assert.deepEqual(await chain.recentDepositTxs(), [{ txHash: h1, sender: 'alice.near' }]);
  node.state.indexerDown = true;
  await assert.rejects(chain.recentDepositTxs(), /indexer returned 503/);

  // the RPC being down surfaces as a readable error
  node.state.down = true;
  await assert.rejects(chain.check(), /RPC unreachable/);
});
