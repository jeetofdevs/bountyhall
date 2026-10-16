// The only module that talks to NEAR. It wraps the JSON-RPC API behind a small
// interface so the payments logic can be tested against an in-memory fake.
//
//   check()                         -> { networkId, decimals, symbol, treasuryRegistered }
//   depositsIn(txHash, senderId)    -> null (unknown) | { final: false } | { final: true, transfers: [{ from, value }] }
//   signTransfer(to, raw, opts)     -> { hash, raw, nonce, blockHash }        (signed, not sent)
//   broadcast(raw)                  -> hash
//   receipt(hash)                   -> null | { final, status: 'pending' | 'success' | 'reverted' }
//   dropped({ nonce, blockHash })   -> true when the transaction can never be included
//   tokenBalance(id) / nativeBalance(id) -> bigint
//   verify({ accountId, publicKey, signature, message, nonce, recipient }) -> boolean   (NEP-413)
//   recentDepositTxs()              -> [{ txHash, sender }]   (optional indexer hint, may be empty)
import {
  isAccountId, keyPairFromString, signTransaction, functionCall, verifyNep413, implicitAccountId,
  b58decode, TGAS,
} from './near.js';

// A transaction's block hash must be at most this many blocks old to be included.
const VALIDITY_BLOCKS = 86_400n;
const GAS_PER_CALL = 30n * TGAS;

export class RpcError extends Error {
  constructor(message, kind) { super(message); this.name = 'RpcError'; this.kind = kind; }
}

export function createChain({ rpcUrl, networkId, token, accountId, privateKey, indexerUrl = null, fetch: doFetch = globalThis.fetch }) {
  if (!token) throw new Error('TOKEN_CONTRACT is not set: the NEP-141 contract id of the token, e.g. token.near');
  if (!isAccountId(token)) throw new Error(`TOKEN_CONTRACT "${token}" is not a valid NEAR account id`);
  if (!accountId || !isAccountId(accountId)) throw new Error('NEAR_ACCOUNT_ID must be the treasury account, e.g. bountyhall.near');
  const key = privateKey ? keyPairFromString(privateKey) : null;
  let id = 0;

  async function rpc(method, params) {
    let res;
    try {
      res = await doFetch(rpcUrl, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) { throw new RpcError(`RPC unreachable: ${err.message}`, 'NETWORK'); }
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { throw new RpcError(`RPC returned ${res.status}: ${text.slice(0, 120)}`, 'BAD_RESPONSE'); }
    if (body.error) {
      const kind = body.error.cause?.name || body.error.name || 'RPC_ERROR';
      const info = body.error.data && typeof body.error.data === 'object' ? JSON.stringify(body.error.data) : (body.error.data || body.error.message);
      throw new RpcError(`${kind}: ${String(info).slice(0, 300)}`, kind);
    }
    // view calls report contract errors inside a successful response
    if (body.result?.error) throw new RpcError(String(body.result.error).slice(0, 300), 'CONTRACT_ERROR');
    return body.result;
  }

  async function view(contract, method, args = {}) {
    const r = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: contract, method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
    return JSON.parse(Buffer.from(r.result).toString('utf8'));
  }

  async function accessKey(account, publicKey) {
    try {
      return await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: account, public_key: publicKey });
    } catch (err) {
      if (/UNKNOWN_ACCESS_KEY|UNKNOWN_ACCOUNT|does not exist/i.test(err.message)) return null;
      throw err;
    }
  }

  async function txStatus(hash, sender) {
    try {
      return await rpc('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: sender, wait_until: 'NONE' });
    } catch (err) {
      if (/UNKNOWN_TRANSACTION|doesn't exist|does not exist/i.test(err.message)) return null;
      throw err;
    }
  }

  const isFinal = (r) => r.final_execution_status === 'FINAL';
  const settled = (status) => status && typeof status === 'object' && ('SuccessValue' in status || 'Failure' in status);
  const ok = (status) => status && typeof status === 'object' && ('SuccessValue' in status || 'SuccessReceiptId' in status);

  // NEP-141 transfers in successful receipts of the token contract (NEP-297 events,
  // falling back to the legacy "Transfer N from A to B" log line).
  function transfersIn(r) {
    const out = [];
    for (const o of r.receipts_outcome || []) {
      if (o.outcome?.executor_id !== token || !ok(o.outcome.status)) continue;
      for (const log of o.outcome.logs || []) {
        if (log.startsWith('EVENT_JSON:')) {
          let ev; try { ev = JSON.parse(log.slice(11)); } catch { continue; }
          if (ev.standard !== 'nep141' || ev.event !== 'ft_transfer') continue;
          for (const d of ev.data || []) if (d.old_owner_id && d.new_owner_id && /^\d+$/.test(d.amount)) out.push({ from: d.old_owner_id, to: d.new_owner_id, value: BigInt(d.amount) });
        } else {
          const m = /^Transfer (\d+) from (\S+) to (\S+)$/.exec(log);
          if (m) out.push({ from: m[2], to: m[3], value: BigInt(m[1]) });
        }
      }
    }
    return out;
  }

  return {
    treasury: accountId,
    token,
    canSend: Boolean(key),
    publicKey: key?.publicKey ?? null,

    async check() {
      const status = await rpc('status', []);
      if (status.chain_id !== networkId) throw new Error(`RPC is on ${status.chain_id}, expected ${networkId}`);
      const meta = await view(token, 'ft_metadata');
      if (!Number.isInteger(meta?.decimals)) throw new Error(`${token} did not return NEP-141 metadata`);
      const storage = await view(token, 'storage_balance_of', { account_id: accountId }).catch(() => null);
      if (key) {
        const ak = await accessKey(accountId, key.publicKey);
        if (!ak) throw new Error(`HOT_WALLET_PRIVATE_KEY is not an access key of ${accountId}`);
        if (ak.permission !== 'FullAccess') throw new Error(`the hot wallet key of ${accountId} is not a full-access key`);
      }
      return { networkId: status.chain_id, decimals: meta.decimals, symbol: meta.symbol, treasuryRegistered: Boolean(storage) };
    },

    // Net amount each sender moved to the treasury in one transaction. A refund
    // back to the sender in the same transaction (a failed ft_transfer_call) is
    // subtracted, so it is never credited.
    async depositsIn(hash, sender) {
      const r = await txStatus(hash, sender);
      if (!r) return null;
      if (!isFinal(r) || !settled(r.status)) return { final: false };
      const net = new Map();
      for (const t of transfersIn(r)) {
        if (t.to === accountId && t.from !== accountId) net.set(t.from, (net.get(t.from) || 0n) + t.value);
        if (t.from === accountId && net.has(t.to)) net.set(t.to, net.get(t.to) - t.value);
      }
      return { final: true, transfers: [...net].filter(([, v]) => v > 0n).map(([from, value]) => ({ from, value })) };
    },

    async signTransfer(to, rawAmount, { minNonce = 0, memo = null } = {}) {
      if (!key) throw new Error('no hot wallet key configured');
      const ak = await accessKey(accountId, key.publicKey);
      if (!ak) throw new Error(`the hot wallet key is not an access key of ${accountId}`);
      const nonce = BigInt(Math.max(ak.nonce, minNonce)) + 1n;
      const actions = [];
      // the receiver needs a storage registration on the token contract, or ft_transfer fails
      const registered = await view(token, 'storage_balance_of', { account_id: to });
      if (!registered) {
        const bounds = await view(token, 'storage_balance_bounds');
        actions.push(functionCall('storage_deposit', { account_id: to, registration_only: true }, GAS_PER_CALL, BigInt(bounds.min)));
      }
      actions.push(functionCall('ft_transfer', { receiver_id: to, amount: rawAmount.toString(), ...(memo ? { memo } : {}) }, GAS_PER_CALL, 1n));
      const signed = signTransaction({ signerId: accountId, publicKey: key.publicKey, nonce, receiverId: token, blockHash: b58decode(ak.block_hash), actions }, key);
      return { hash: signed.hash, raw: signed.signedBase64, nonce: Number(nonce), blockHash: ak.block_hash };
    },

    async broadcast(raw) {
      const r = await rpc('send_tx', { signed_tx_base64: raw, wait_until: 'NONE' });
      return r?.transaction?.hash ?? null;
    },

    async receipt(hash) {
      const r = await txStatus(hash, accountId);
      if (!r) return null;
      if (!settled(r.status)) return { final: false, status: 'pending' };
      return { final: isFinal(r), status: 'Failure' in r.status ? 'reverted' : 'success' };
    },

    // For a transaction the RPC does not know: true when it can never be included
    // (its nonce is spent or its block hash expired), false when it still could,
    // and 'too_old' when the RPC has pruned that history, so its absence proves nothing.
    async dropped({ nonce, blockHash }) {
      if (!blockHash) return false;
      let ref;
      try { ref = await rpc('block', { block_id: blockHash }); } catch (err) {
        if (/UNKNOWN_BLOCK|garbage/i.test(err.message)) return 'too_old';
        throw err;
      }
      if (key) {
        const ak = await accessKey(accountId, key.publicKey);
        if (ak && ak.nonce >= nonce) return true;
      }
      const head = await rpc('block', { finality: 'final' });
      return BigInt(head.header.height) - BigInt(ref.header.height) > VALIDITY_BLOCKS;
    },

    tokenBalance: async (account) => BigInt(await view(token, 'ft_balance_of', { account_id: account })),
    async nativeBalance(account) {
      const a = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: account });
      return BigInt(a.amount);
    },

    async verify({ accountId: who, publicKey, signature, message, nonce, recipient }) {
      if (!verifyNep413({ publicKey, signature, message, nonce, recipient })) return false;
      const ak = await accessKey(who, publicKey);
      if (ak) return ak.permission === 'FullAccess';
      // a fresh implicit account is controlled by the key it is named after
      return /^[0-9a-f]{64}$/.test(who) && implicitAccountId(publicKey) === who;
    },

    // Best-effort hint from a public indexer: recent token transfers touching the
    // treasury. Every hint is verified on-chain through depositsIn() before crediting.
    async recentDepositTxs() {
      if (!indexerUrl) return [];
      const res = await doFetch(`${indexerUrl}/v1/account/${encodeURIComponent(accountId)}/ft-txns?per_page=25&order=desc`, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`indexer returned ${res.status}`);
      const body = await res.json();
      const rows = Array.isArray(body?.txns) ? body.txns : [];
      return rows
        .filter((t) => typeof t?.transaction_hash === 'string' && isAccountId(t?.involved_account_id) && (!t.ft?.contract || t.ft.contract === token) && !String(t.delta_amount ?? '').startsWith('-'))
        .map((t) => ({ txHash: t.transaction_hash, sender: t.involved_account_id }));
    },
  };
}
