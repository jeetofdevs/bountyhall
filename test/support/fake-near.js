// A scripted NEAR node for tests: speaks the JSON-RPC methods Bountyhall uses,
// keeps NEP-141 token state, checks every signed transaction (borsh layout,
// ed25519 signature, access key, nonce, block hash expiry) and produces
// receipts with NEP-297 event logs. Transactions land when you call include()
// and become final on finalize(), so tests control timing.
import { randomBytes } from 'node:crypto';
import { b58encode, sha256, verifyEd25519, publicKeyString, keyPairFromString, nep413Hash } from '../../src/near.js';

const err = (name, data) => ({ error: { name: 'HANDLER_ERROR', cause: { name }, code: -32000, message: 'Server error', data } });

// ---------- borsh reader for SignedTransaction ----------
function decodeSigned(buf) {
  let o = 0;
  const u8 = () => buf[o++];
  const u32 = () => { const v = buf.readUInt32LE(o); o += 4; return v; };
  const u64 = () => { const v = buf.readBigUInt64LE(o); o += 8; return v; };
  const u128 = () => { const lo = buf.readBigUInt64LE(o); const hi = buf.readBigUInt64LE(o + 8); o += 16; return (hi << 64n) | lo; };
  const fixed = (n) => { const v = buf.subarray(o, o + n); o += n; return v; };
  const string = () => fixed(u32()).toString('utf8');
  const signerId = string();
  if (u8() !== 0) throw new Error('only ed25519 keys');
  const publicKey = publicKeyString(fixed(32));
  const nonce = u64();
  const receiverId = string();
  const blockHash = b58encode(fixed(32));
  const n = u32();
  const actions = [];
  for (let i = 0; i < n; i++) {
    const kind = u8();
    if (kind !== 2) throw new Error(`unsupported action ${kind}`);
    actions.push({ methodName: string(), args: JSON.parse(fixed(u32()).toString('utf8')), gas: u64(), deposit: u128() });
  }
  const bodyEnd = o;
  if (u8() !== 0) throw new Error('only ed25519 signatures');
  const signature = fixed(64);
  if (o !== buf.length) throw new Error('trailing bytes');
  return { signerId, publicKey, nonce, receiverId, blockHash, actions, body: buf.subarray(0, bodyEnd), signature };
}

const event = (data) => `EVENT_JSON:${JSON.stringify({ standard: 'nep141', version: '1.0.0', event: 'ft_transfer', data })}`;
const randomHash = () => b58encode(randomBytes(32));

export function createFakeNear({ networkId = 'mainnet', token = 'musebook.near', decimals = 18, symbol = 'MUSEBOOK', storageMin = 1_250_000_000_000_000_000_000n } = {}) {
  const s = {
    height: 1000, blocks: new Map(), keys: new Map(), accounts: new Map(), balances: new Map(), registered: new Set(),
    txs: new Map(), pool: [], calls: [], down: false, failSend: false, failNextReceipt: false, indexer: [], indexerDown: false,
  };
  const unit = 10n ** BigInt(decimals);
  const newBlock = () => { s.height++; const h = randomHash(); s.blocks.set(h, s.height); s.head = h; return h; };
  newBlock();

  const node = {
    state: s, token, unit,
    newKeyPair() { return keyPairFromString(`ed25519:${b58encode(randomBytes(32))}`); },
    // create an account with a full-access key (or a function-call key)
    addAccount(id, { keyPair = node.newKeyPair(), near = 10n ** 24n, permission = 'FullAccess', register = true } = {}) {
      s.accounts.set(id, { amount: near });
      if (!s.keys.has(id)) s.keys.set(id, new Map());
      s.keys.get(id).set(keyPair.publicKey, { nonce: s.height * 1_000_000, permission: permission === 'FullAccess' ? 'FullAccess' : { FunctionCall: { allowance: null, receiver_id: token, method_names: [] } } });
      if (register) s.registered.add(id);
      return keyPair;
    },
    mint(id, whole) { s.balances.set(id, (s.balances.get(id) || 0n) + BigInt(whole) * unit); s.registered.add(id); },
    balance: (id) => s.balances.get(id) || 0n,
    advance(blocks) { for (let i = 0; i < blocks; i++) newBlock(); },
    forgetBlocks() { for (const h of [...s.blocks.keys()]) if (h !== s.head) s.blocks.delete(h); }, // like a pruned, non-archival node

    // A user's deposit: ft_transfer (or ft_transfer_call that the treasury cannot accept, which refunds).
    userTransfer(from, to, amount, { call = false, final = true, raw = null } = {}) {
      const value = raw ?? BigInt(amount) * unit;
      const hash = randomHash();
      const outcomes = [];
      if ((s.balances.get(from) || 0n) < value || !s.registered.has(to)) {
        outcomes.push({ id: randomHash(), outcome: { executor_id: token, logs: [], status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked' } } } } } } });
        s.txs.set(hash, { signer: from, status: { Failure: {} }, final, outcomes });
        return hash;
      }
      s.balances.set(from, s.balances.get(from) - value);
      s.balances.set(to, (s.balances.get(to) || 0n) + value);
      outcomes.push({ id: randomHash(), outcome: { executor_id: token, logs: [event([{ old_owner_id: from, new_owner_id: to, amount: value.toString() }])], status: { SuccessReceiptId: randomHash() } } });
      if (call) {
        // ft_on_transfer fails on a plain account, ft_resolve_transfer refunds everything
        outcomes.push({ id: randomHash(), outcome: { executor_id: to, logs: [], status: { Failure: { ActionError: { kind: { FunctionCallError: { MethodResolveError: 'MethodNotFound' } } } } } } });
        s.balances.set(to, s.balances.get(to) - value);
        s.balances.set(from, s.balances.get(from) + value);
        outcomes.push({ id: randomHash(), outcome: { executor_id: token, logs: [event([{ old_owner_id: to, new_owner_id: from, amount: value.toString(), memo: 'refund' }])], status: { SuccessValue: Buffer.from('"0"').toString('base64') } } });
      }
      s.txs.set(hash, { signer: from, status: { SuccessValue: '' }, final, outcomes });
      return hash;
    },
    finalize() { for (const t of s.txs.values()) if (t.included !== false) t.final = true; },

    // Execute broadcast transactions (as the next block would).
    include() {
      newBlock();
      for (const t of s.pool.splice(0)) {
        const failed = s.failNextReceipt; s.failNextReceipt = false;
        const outcomes = [];
        let ok = !failed;
        const snapshot = { balances: new Map(s.balances), registered: new Set(s.registered) };
        for (const a of t.actions) {
          if (!ok) break;
          if (a.methodName === 'storage_deposit') {
            if (a.deposit < storageMin) { ok = false; break; }
            s.registered.add(a.args.account_id);
          } else if (a.methodName === 'ft_transfer') {
            const amount = BigInt(a.args.amount);
            if (a.deposit !== 1n || !s.registered.has(a.args.receiver_id) || (s.balances.get(t.signerId) || 0n) < amount) { ok = false; break; }
            s.balances.set(t.signerId, s.balances.get(t.signerId) - amount);
            s.balances.set(a.args.receiver_id, (s.balances.get(a.args.receiver_id) || 0n) + amount);
            outcomes.push(event([{ old_owner_id: t.signerId, new_owner_id: a.args.receiver_id, amount: a.args.amount, ...(a.args.memo ? { memo: a.args.memo } : {}) }]));
          } else ok = false;
        }
        if (!ok) { s.balances = snapshot.balances; s.registered = snapshot.registered; }
        s.txs.set(t.hash, {
          signer: t.signerId, final: false, status: ok ? { SuccessValue: '' } : { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: 'Smart contract panicked: The account is not registered' } } } } },
          outcomes: [{ id: randomHash(), outcome: { executor_id: token, logs: ok ? outcomes : [], status: ok ? { SuccessValue: '' } : { Failure: {} } } }],
          actions: t.actions,
        });
      }
    },
    sent: () => [...s.txs.values()].filter((t) => t.actions),

    async fetch(url, init) {
      if (url.includes('/ft-txns')) {
        if (s.indexerDown) return new Response('busy', { status: 503 });
        return Response.json({ txns: s.indexer });
      }
      if (s.down) throw new TypeError('fetch failed');
      const { id, method, params } = JSON.parse(init.body);
      s.calls.push(method);
      const out = node.handle(method, params);
      return Response.json({ jsonrpc: '2.0', id, ...out });
    },

    handle(method, p) {
      const result = (r) => ({ result: r });
      switch (method) {
        case 'status': return result({ chain_id: networkId, sync_info: { latest_block_height: s.height } });
        case 'block': {
          if (p.finality) return result({ header: { height: s.height, hash: s.head } });
          if (!s.blocks.has(p.block_id)) return err('UNKNOWN_BLOCK', `DB Not Found Error: BLOCK: ${p.block_id}`);
          return result({ header: { height: s.blocks.get(p.block_id), hash: p.block_id } });
        }
        case 'query': {
          if (p.request_type === 'view_access_key') {
            const k = s.keys.get(p.account_id)?.get(p.public_key);
            if (!k) return err('UNKNOWN_ACCESS_KEY', `Access key for public key ${p.public_key} has never been observed on the node`);
            return result({ nonce: k.nonce, permission: k.permission, block_hash: s.head, block_height: s.height });
          }
          if (p.request_type === 'view_account') {
            const a = s.accounts.get(p.account_id);
            if (!a) return err('UNKNOWN_ACCOUNT', `account ${p.account_id} does not exist while viewing`);
            return result({ amount: a.amount.toString(), locked: '0', storage_usage: 500, block_hash: s.head, block_height: s.height });
          }
          if (p.request_type === 'call_function') {
            if (p.account_id !== token) return err('CONTRACT_CODE_NOT_FOUND', 'no contract');
            const args = JSON.parse(Buffer.from(p.args_base64, 'base64').toString() || '{}');
            const view = {
              ft_metadata: () => ({ spec: 'ft-1.0.0', name: 'Musebook', symbol, decimals }),
              storage_balance_of: () => (s.registered.has(args.account_id) ? { total: storageMin.toString(), available: '0' } : null),
              storage_balance_bounds: () => ({ min: storageMin.toString(), max: storageMin.toString() }),
              ft_balance_of: () => (s.balances.get(args.account_id) || 0n).toString(),
            }[p.method_name];
            if (!view) return result({ error: `wasm execution failed: MethodNotFound ${p.method_name}`, logs: [], block_height: s.height });
            return result({ result: [...Buffer.from(JSON.stringify(view()))], logs: [], block_height: s.height, block_hash: s.head });
          }
          return err('UNKNOWN_REQUEST', p.request_type);
        }
        case 'EXPERIMENTAL_tx_status': {
          const t = s.txs.get(p.tx_hash);
          if (!t || t.signer !== p.sender_account_id) return err('UNKNOWN_TRANSACTION', `Transaction ${p.tx_hash} doesn't exist`);
          return result({
            final_execution_status: t.final ? 'FINAL' : 'EXECUTED_OPTIMISTIC',
            status: t.status, transaction: { hash: p.tx_hash, signer_id: t.signer },
            transaction_outcome: { id: p.tx_hash, outcome: { status: { SuccessReceiptId: 'r' }, logs: [] } },
            receipts_outcome: t.outcomes,
          });
        }
        case 'send_tx': {
          if (s.failSend) return err('TIMEOUT_ERROR', 'Timeout');
          let t;
          try { t = decodeSigned(Buffer.from(p.signed_tx_base64, 'base64')); } catch (e) { return err('PARSE_ERROR', e.message); }
          const hash = b58encode(sha256(t.body));
          if (s.txs.has(hash) || s.pool.some((x) => x.hash === hash)) return result({ final_execution_status: 'NONE', transaction: { hash } });
          if (!verifyEd25519(t.publicKey, sha256(t.body), t.signature)) return err('INVALID_TRANSACTION', { TxExecutionError: { InvalidTxError: 'InvalidSignature' } });
          const k = s.keys.get(t.signerId)?.get(t.publicKey);
          if (!k) return err('INVALID_TRANSACTION', { TxExecutionError: { InvalidTxError: { InvalidAccessKeyError: 'AccessKeyNotFound' } } });
          if (t.nonce <= BigInt(k.nonce)) return err('INVALID_TRANSACTION', { TxExecutionError: { InvalidTxError: { InvalidNonce: { tx_nonce: Number(t.nonce), ak_nonce: k.nonce } } } });
          if (!s.blocks.has(t.blockHash) || s.height - s.blocks.get(t.blockHash) > 86_400) return err('INVALID_TRANSACTION', { TxExecutionError: { InvalidTxError: 'Expired' } });
          if (t.receiverId !== token) return err('INVALID_TRANSACTION', 'wrong receiver');
          k.nonce = Number(t.nonce);
          s.pool.push({ ...t, hash });
          // callers that wait (like near-api-js) get the executed outcome back
          if (p.wait_until && p.wait_until !== 'NONE') { node.include(); node.finalize(); return node.handle('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: t.signerId }); }
          return result({ final_execution_status: 'NONE', transaction: { hash } });
        }
        default: return err('METHOD_NOT_FOUND', method);
      }
    },
  };
  return node;
}

// Sign a NEP-413 link challenge the way a NEAR wallet does.
export function signChallenge(keyPair, ch) {
  const nonce = Buffer.from(ch.nonce, 'base64');
  const signature = keyPair.sign(nep413Hash({ message: ch.message, nonce, recipient: ch.recipient }));
  return { account_id: ch.account_id, public_key: keyPair.publicKey, signature: Buffer.from(signature).toString('base64') };
}
