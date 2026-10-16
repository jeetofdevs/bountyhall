// NEAR Protocol primitives with no dependencies beyond node:crypto:
// base58, the borsh layouts Bountyhall needs, ed25519 keys, transaction
// signing, and NEP-413 signed messages. Cross-checked byte for byte against
// near-api-js by `npm run test:near`.
import { createHash, createPrivateKey, createPublicKey, sign as edSign, verify as edVerify } from 'node:crypto';

// ---------- base58 ----------
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const INDEX = Object.fromEntries([...ALPHABET].map((c, i) => [c, BigInt(i)]));

export function b58encode(bytes) {
  const buf = Uint8Array.from(bytes);
  let n = 0n;
  for (const b of buf) n = n * 256n + BigInt(b);
  let out = '';
  while (n > 0n) { out = ALPHABET[Number(n % 58n)] + out; n /= 58n; }
  for (const b of buf) { if (b !== 0) break; out = '1' + out; }
  return out;
}

export function b58decode(str) {
  if (typeof str !== 'string' || !str.length) throw new Error('empty base58 string');
  let n = 0n;
  for (const c of str) {
    if (!(c in INDEX)) throw new Error('invalid base58 character');
    n = n * 58n + INDEX[c];
  }
  const bytes = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const c of str) { if (c !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

export const sha256 = (bytes) => new Uint8Array(createHash('sha256').update(bytes).digest());

// ---------- account ids ----------
// https://nomicon.io/DataStructures/Account#account-id-rules
const ACCOUNT_RE = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;
export function isAccountId(id) {
  return typeof id === 'string' && id.length >= 2 && id.length <= 64 && ACCOUNT_RE.test(id);
}

// ---------- keys ----------
const PKCS8_ED25519 = Buffer.from('302e020100300506032b657004220420', 'hex');
const SPKI_ED25519 = Buffer.from('302a300506032b6570032100', 'hex');

function decodeKey(str, sizes) {
  if (typeof str !== 'string') throw new Error('key must be a string');
  const [type, body] = str.includes(':') ? str.split(':') : ['ed25519', str];
  if (type !== 'ed25519') throw new Error(`unsupported key type ${type}; only ed25519 keys are supported`);
  const bytes = b58decode(body);
  if (!sizes.includes(bytes.length)) throw new Error(`ed25519 key has ${bytes.length} bytes, expected ${sizes.join(' or ')}`);
  return bytes;
}

export const publicKeyBytes = (str) => decodeKey(str, [32]);
export const publicKeyString = (bytes) => `ed25519:${b58encode(bytes)}`;

// A NEAR secret key ("ed25519:<base58>") is the 32-byte seed followed by the
// 32-byte public key; a bare 32-byte seed is accepted too.
export function keyPairFromString(secret) {
  const bytes = decodeKey(secret, [32, 64]);
  const seed = bytes.slice(0, 32);
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_ED25519, seed]), format: 'der', type: 'pkcs8' });
  const pub = new Uint8Array(createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(SPKI_ED25519.length));
  if (bytes.length === 64 && Buffer.compare(Buffer.from(pub), Buffer.from(bytes.slice(32))) !== 0) throw new Error('secret key does not match its public half');
  return {
    publicKey: publicKeyString(pub),
    publicKeyBytes: pub,
    sign: (msg) => new Uint8Array(edSign(null, msg, privateKey)),
  };
}

export function verifyEd25519(publicKey, message, signature) {
  const pub = typeof publicKey === 'string' ? publicKeyBytes(publicKey) : publicKey;
  if (signature.length !== 64) return false;
  const key = createPublicKey({ key: Buffer.concat([SPKI_ED25519, Buffer.from(pub)]), format: 'der', type: 'spki' });
  return edVerify(null, message, key, signature);
}

// An implicit account id is the hex of its ed25519 public key.
export const implicitAccountId = (publicKey) => Buffer.from(publicKeyBytes(publicKey)).toString('hex');

// ---------- borsh ----------
class Writer {
  constructor() { this.parts = []; }
  u8(n) { this.parts.push(Uint8Array.of(n)); return this; }
  u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n); this.parts.push(b); return this; }
  u64(n) { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); this.parts.push(b); return this; }
  u128(n) {
    const v = BigInt(n);
    if (v < 0n || v >= 1n << 128n) throw new Error('u128 out of range');
    const b = Buffer.alloc(16);
    b.writeBigUInt64LE(v & ((1n << 64n) - 1n)); b.writeBigUInt64LE(v >> 64n, 8);
    this.parts.push(b); return this;
  }
  fixed(bytes, len) { if (bytes.length !== len) throw new Error(`expected ${len} bytes`); this.parts.push(Uint8Array.from(bytes)); return this; }
  bytes(bytes) { this.u32(bytes.length); this.parts.push(Uint8Array.from(bytes)); return this; }
  string(s) { return this.bytes(Buffer.from(s, 'utf8')); }
  out() { return new Uint8Array(Buffer.concat(this.parts)); }
}

// ---------- NEP-413 signed messages ----------
const NEP413_TAG = 2 ** 31 + 413;

export function nep413Hash({ message, nonce, recipient, callbackUrl = null }) {
  const w = new Writer().u32(NEP413_TAG).string(message).fixed(nonce, 32).string(recipient);
  if (callbackUrl == null) w.u8(0); else w.u8(1).string(callbackUrl);
  return sha256(w.out());
}

export function verifyNep413({ publicKey, signature, ...payload }) {
  try { return verifyEd25519(publicKey, nep413Hash(payload), signature); } catch { return false; }
}

// ---------- transactions ----------
export const TGAS = 10n ** 12n;

export function functionCall(methodName, args, gas, deposit) {
  return { methodName, args: Buffer.from(JSON.stringify(args)), gas: BigInt(gas), deposit: BigInt(deposit) };
}

// Transaction V0, the layout every NEAR node accepts.
export function serializeTransaction({ signerId, publicKey, nonce, receiverId, blockHash, actions }) {
  const w = new Writer().string(signerId).u8(0).fixed(publicKeyBytes(publicKey), 32).u64(nonce).string(receiverId).fixed(blockHash, 32).u32(actions.length);
  for (const a of actions) w.u8(2).string(a.methodName).bytes(a.args).u64(a.gas).u128(a.deposit); // 2 = FunctionCall
  return w.out();
}

// Returns the base58 hash and the base64 SignedTransaction ready for send_tx.
export function signTransaction(tx, keyPair) {
  if (tx.publicKey !== keyPair.publicKey) throw new Error('transaction public key does not match the signing key');
  const body = serializeTransaction(tx);
  const hash = sha256(body);
  const signature = keyPair.sign(hash);
  const signed = Buffer.concat([body, Uint8Array.of(0), signature]);
  return { hash: b58encode(hash), signedBase64: signed.toString('base64') };
}

// ---------- amounts ----------
// "1.5" with 18 decimals -> 1500000000000000000n
export function toRaw(amount, decimals) {
  const s = String(amount);
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error('amount must be a non-negative number');
  const [whole, frac = ''] = s.split('.');
  if (frac.length > decimals) throw new Error(`at most ${decimals} decimal places`);
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0');
}
