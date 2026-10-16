// On-chain payments in a NEP-141 token on NEAR Protocol (MUSEBOOK by default).
//
// Custodial model: users deposit tokens to the treasury account, the server
// verifies each deposit transaction on-chain once it is final and credits it in
// the internal ledger, and every job then settles instantly off-chain.
// Withdrawals wait in a queue until an admin approves them; only then does the
// server sign and broadcast an ft_transfer from the treasury.
//
// Ledger: 1 credit = 1 whole token. Deposits move sys_chain -> user; a
// withdrawal request moves user -> sys_withdrawals; confirmation moves
// sys_withdrawals -> sys_chain; a rejection or refund moves it back to the user.
// So -balance(sys_chain) is always exactly what the treasury owes on-chain.
//
//   deposit:    reported (by the depositor or an indexer) ─final─▶ credited | unclaimed | dust
//   withdrawal: pending ─approve─▶ signing ─▶ sending ─final─▶ confirmed
//                  │                   │          ├─failed on-chain─▶ failed   (refunded)
//                  └─reject─▶ rejected └─error─▶ pending  └─dropped─▶ refunded
import { randomBytes } from 'node:crypto';
import { tx } from './db.js';
import { SYS } from './market.js';
import { isAccountId, b58decode, sha256 } from './near.js';
import { HttpError, newId, now, int, str, MINUTE } from './util.js';

const NETWORKS = {
  mainnet: { rpcUrl: 'https://free.rpc.fastnear.com', explorer: 'https://nearblocks.io', indexerUrl: 'https://api.nearblocks.io' },
  testnet: { rpcUrl: 'https://rpc.testnet.fastnear.com', explorer: 'https://testnet.nearblocks.io', indexerUrl: 'https://api-testnet.nearblocks.io' },
};

export const DEFAULTS = {
  networkId: 'mainnet',
  networkName: 'NEAR Protocol',
  symbol: 'MUSEBOOK',
  minWithdrawal: 1000,
};

export function paymentsConfigFromEnv(env = process.env) {
  const mode = (env.PAYMENTS || 'credits').toLowerCase();
  if (mode !== 'token') return { mode: 'credits' };
  const networkId = (env.NEAR_NETWORK || DEFAULTS.networkId).toLowerCase();
  const net = NETWORKS[networkId] || NETWORKS.mainnet;
  let recipient = env.LINK_RECIPIENT || 'bountyhall.lol';
  if (!env.LINK_RECIPIENT && env.PUBLIC_URL) { try { recipient = new URL(env.PUBLIC_URL).host; } catch {} }
  return {
    mode: 'token',
    networkId,
    networkName: networkId === 'mainnet' ? DEFAULTS.networkName : `NEAR Protocol ${networkId}`,
    rpcUrl: env.NEAR_RPC_URL || net.rpcUrl,
    token: (env.TOKEN_CONTRACT || '').trim() || null,
    symbol: env.TOKEN_SYMBOL || DEFAULTS.symbol,
    explorer: (env.EXPLORER_URL || net.explorer).replace(/\/$/, ''),
    indexerUrl: env.INDEXER_URL === '' ? null : (env.INDEXER_URL || net.indexerUrl).replace(/\/$/, ''),
    accountId: (env.NEAR_ACCOUNT_ID || '').trim() || null,
    privateKey: env.HOT_WALLET_PRIVATE_KEY || null,
    minWithdrawal: Number(env.MIN_WITHDRAWAL || DEFAULTS.minWithdrawal),
    maxWithdrawalPerDay: Number(env.MAX_WITHDRAWAL_PER_DAY || 0),
    recipient,
  };
}

// Stand-in used when the configuration is incomplete: the site keeps running and
// every payment call reports what is missing.
export function brokenChain(cfg, err) {
  const fail = async () => { throw err; };
  return { treasury: cfg.accountId || '(not set)', token: cfg.token || '(not set)', canSend: false, check: fail, depositsIn: fail, signTransfer: fail, broadcast: fail, receipt: fail, dropped: fail, tokenBalance: fail, nativeBalance: fail, verify: fail, recentDepositTxs: async () => [] };
}

const CHALLENGE_TTL = 10 * MINUTE;
const REPORT_TTL = 60 * MINUTE; // stop looking for a reported transaction after this long
const INDEXER_EVERY = MINUTE;
const OPEN_WITHDRAWALS = ['pending', 'signing', 'sending'];
const YOCTO = 10n ** 24n;

const normAccount = (v) => (typeof v === 'string' ? v.trim().toLowerCase() : v);
const decodeSig = (s) => {
  if (typeof s !== 'string') return null;
  try {
    const bytes = s.startsWith('ed25519:') ? b58decode(s.slice(8)) : Buffer.from(s, 'base64');
    return bytes.length === 64 ? Uint8Array.from(bytes) : null;
  } catch { return null; }
};
const validHash = (h) => { try { return typeof h === 'string' && b58decode(h).length === 32; } catch { return false; } };

export function formatNear(yocto) {
  const whole = yocto / YOCTO;
  const frac = (yocto % YOCTO).toString().padStart(24, '0').slice(0, 4);
  return `${whole}.${frac}`;
}

export class Payments {
  constructor(market, chain, cfg, { log = console } = {}) {
    this.market = market;
    this.db = market.db;
    this.chain = chain;
    this.cfg = cfg;
    this.log = log;
    this.ready = false;
    this.decimals = null;
    this.lastError = null;
    this.treasuryRegistered = null;
    this.lastIndexScan = 0;
    this.indexerError = null;
    this.queue = Promise.resolve(); // serializes signing so nonces never collide
  }

  // ---------- setup ----------
  async init() {
    // A crash between claiming a withdrawal and recording its signed hash leaves
    // it in 'signing'. Nothing was broadcast (the hash is stored first), so it
    // is safe to put it back in the queue.
    const stuck = this.db.prepare("UPDATE withdrawals SET status = 'pending', error = 'interrupted before signing; back in the queue', updated_at = ? WHERE status = 'signing' AND tx_hash IS NULL").run(now());
    if (stuck.changes) this.log.warn?.(`[payments] ${stuck.changes} interrupted withdrawal(s) returned to the queue`);
    this.#retireEvmWallets();
    try {
      const info = await this.chain.check();
      this.decimals = info.decimals;
      this.onchainSymbol = info.symbol;
      this.treasuryRegistered = info.treasuryRegistered;
      this.ready = true;
      this.lastError = null;
      if (info.symbol !== this.cfg.symbol) this.log.warn?.(`[payments] token symbol on-chain is ${info.symbol}, configured ${this.cfg.symbol}`);
      if (!info.treasuryRegistered) this.log.warn?.(`[payments] ${this.chain.treasury} has no storage registration on ${this.chain.token}; deposits to it will fail`);
      const unbacked = this.market.balance(SYS.faucet);
      if (unbacked !== 0) this.log.warn?.(`[payments] ${-unbacked} free signup credits exist that no token backs; set SIGNUP_CREDITS=0 in token mode`);
    } catch (err) {
      this.ready = false;
      this.lastError = err.message;
      this.log.error?.(`[payments] NEAR check failed: ${err.message}`);
    }
    return this.ready;
  }

  // Wallets linked when payments ran on an EVM chain cannot receive NEAR
  // transfers. Unlink them (balances are untouched) and return their queued
  // withdrawals to the owners.
  #retireEvmWallets() {
    const evm = /^0x[0-9a-fA-F]{40}$/;
    tx(this.db, () => {
      for (const w of this.db.prepare("SELECT * FROM withdrawals WHERE status = 'pending'").all()) {
        if (evm.test(w.to_address) && /[A-F]/.test(w.to_address)) this.#refund(w, 'rejected', 'payments moved to NEAR Protocol; link a NEAR account and request again');
      }
      const old = this.db.prepare('SELECT account_id, address FROM wallets').all().filter((w) => evm.test(w.address) && /[A-F]/.test(w.address));
      for (const w of old) this.db.prepare('DELETE FROM wallets WHERE account_id = ?').run(w.account_id);
      if (old.length) this.log.warn?.(`[payments] unlinked ${old.length} EVM wallet(s) left from before the move to NEAR`);
      this.db.prepare("DELETE FROM wallet_challenges WHERE address LIKE '0x%' AND length(address) = 42").run();
    });
  }

  #needReady() {
    if (!this.ready) throw new HttpError(503, `payments are temporarily unavailable: ${this.lastError || 'NEAR not checked yet'}`, 'chain_unavailable');
  }

  unit() { return 10n ** BigInt(this.decimals); }

  publicConfig() {
    return {
      mode: 'token', symbol: this.cfg.symbol, token_contract: this.chain.token, network: this.cfg.networkName, network_id: this.cfg.networkId,
      rpc_url: this.cfg.rpcUrl, explorer: this.cfg.explorer, decimals: this.decimals, deposit_account: this.chain.treasury,
      finality: 'final', min_withdrawal: this.cfg.minWithdrawal, max_withdrawal_per_day: this.cfg.maxWithdrawalPerDay || null,
      link_recipient: this.cfg.recipient, withdrawals: 'reviewed by an admin', ready: this.ready,
    };
  }

  explorerTx = (hash) => `${this.cfg.explorer}/txns/${hash}`;
  explorerAccount = (id) => `${this.cfg.explorer}/address/${id}`;

  // ---------- wallets ----------
  wallet(accountId) {
    return this.db.prepare('SELECT address AS account_id, linked_at FROM wallets WHERE account_id = ?').get(accountId) || null;
  }

  // NEP-413: the wallet signs { message, nonce, recipient } off-chain. No transaction, no gas.
  challenge(me, accountIdInput) {
    const id = normAccount(accountIdInput);
    if (!isAccountId(id)) throw new HttpError(400, 'account_id must be a NEAR account, like alice.near', 'invalid_input');
    const expires = now() + CHALLENGE_TTL;
    const message = [
      'Bountyhall wallet link',
      `Account: ${me.name} (${me.id})`,
      `NEAR account: ${id}`,
      `Network: ${this.cfg.networkId}`,
      `Nonce: ${randomBytes(16).toString('hex')}`,
      `Expires: ${new Date(expires).toISOString()}`,
    ].join('\n');
    this.db.prepare('INSERT OR REPLACE INTO wallet_challenges (account_id, address, message, expires_at) VALUES (?, ?, ?, ?)').run(me.id, id, message, expires);
    return { account_id: id, message, nonce: Buffer.from(sha256(Buffer.from(message))).toString('base64'), recipient: this.cfg.recipient, expires_at: expires };
  }

  async link(me, body = {}) {
    const id = normAccount(body.account_id ?? body.accountId);
    const publicKey = body.public_key ?? body.publicKey;
    if (!isAccountId(id)) throw new HttpError(400, 'account_id must be a NEAR account, like alice.near', 'invalid_input');
    if (typeof publicKey !== 'string' || !/^ed25519:[1-9A-HJ-NP-Za-km-z]{40,50}$/.test(publicKey)) throw new HttpError(400, 'public_key must be an ed25519:… key', 'invalid_input');
    const signature = decodeSig(body.signature);
    if (!signature) throw new HttpError(400, 'signature must be a 64-byte ed25519 signature in base64', 'invalid_input');
    const ch = this.db.prepare('SELECT * FROM wallet_challenges WHERE account_id = ?').get(me.id);
    if (!ch || ch.address !== id) throw new HttpError(400, 'request a challenge for this NEAR account first', 'no_challenge');
    if (now() > ch.expires_at) throw new HttpError(400, 'the challenge expired; request a new one', 'challenge_expired');
    // single use: a challenge is spent by any attempt, right or wrong
    this.db.prepare('DELETE FROM wallet_challenges WHERE account_id = ?').run(me.id);
    let valid = false;
    try {
      valid = await this.chain.verify({ accountId: id, publicKey, signature, message: ch.message, nonce: sha256(Buffer.from(ch.message)), recipient: this.cfg.recipient });
    } catch (err) {
      throw new HttpError(503, `could not check the key on NEAR: ${err.message}`, 'chain_unavailable');
    }
    if (!valid) throw new HttpError(400, 'signature does not match, or the key is not a full-access key of that account', 'bad_signature');
    return tx(this.db, () => {
      const owner = this.db.prepare('SELECT account_id FROM wallets WHERE address = ?').get(id);
      if (owner && owner.account_id !== me.id) throw new HttpError(409, 'that NEAR account is linked to another Bountyhall account', 'wallet_taken');
      const open = this.db.prepare(`SELECT COUNT(*) AS c FROM withdrawals WHERE account_id = ? AND status IN (${OPEN_WITHDRAWALS.map(() => '?').join(',')})`).get(me.id, ...OPEN_WITHDRAWALS).c;
      if (open) throw new HttpError(409, 'you cannot change wallets while a withdrawal is open', 'withdrawal_open');
      this.db.prepare('INSERT INTO wallets (account_id, address, linked_at) VALUES (?, ?, ?) ON CONFLICT(account_id) DO UPDATE SET address = excluded.address, linked_at = excluded.linked_at').run(me.id, id, now());
      // deposits that arrived from this account before it was linked
      const claimed = this.db.prepare("SELECT * FROM deposits WHERE from_address = ? AND status = 'unclaimed'").all(id);
      for (const d of claimed) this.#credit(d, me.id);
      return { account_id: id, linked_at: now(), claimed_deposits: claimed.length, claimed_amount: claimed.reduce((a, d) => a + d.credited, 0) };
    });
  }

  #credit(d, accountId) {
    this.market.transfer([[SYS.chain, -d.credited], [accountId, d.credited]], 'deposit');
    this.db.prepare("UPDATE deposits SET status = 'credited', account_id = ? WHERE id = ?").run(accountId, d.id);
  }

  // ---------- deposits ----------
  #recordDeposit(txHash, index, from, value) {
    const credited = value / this.unit();
    if (credited > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`deposit too large to credit: ${value}`);
    const id = newId('dep');
    const r = this.db.prepare(`INSERT OR IGNORE INTO deposits (id, tx_hash, log_index, block_number, from_address, raw_amount, credited, status, created_at)
      VALUES (?, ?, ?, 0, ?, ?, ?, 'new', ?)`).run(id, txHash, index, from, value.toString(), Number(credited), now());
    if (!r.changes) return null; // already recorded
    const d = this.db.prepare('SELECT * FROM deposits WHERE id = ?').get(id);
    if (d.credited === 0) { this.db.prepare("UPDATE deposits SET status = 'dust' WHERE id = ?").run(id); return 'dust'; }
    const owner = this.db.prepare('SELECT account_id FROM wallets WHERE address = ?').get(from);
    if (owner) { this.#credit(d, owner.account_id); return 'credited'; }
    this.db.prepare("UPDATE deposits SET status = 'unclaimed' WHERE id = ?").run(id);
    return 'unclaimed';
  }

  // Anyone may point the server at a transaction; what gets credited, and to
  // whom, is decided only by what the transaction did on-chain.
  async reportDeposit(me, body = {}) {
    this.#needReady();
    const hash = typeof body.tx_hash === 'string' ? body.tx_hash.trim() : body.tx_hash;
    if (!validHash(hash)) throw new HttpError(400, 'tx_hash must be a NEAR transaction hash (base58)', 'invalid_input');
    const sender = normAccount(body.sender ?? this.wallet(me.id)?.account_id);
    if (!isAccountId(sender)) throw new HttpError(400, 'sender must be the NEAR account that signed the transaction (defaults to your linked account)', 'invalid_input');
    this.db.prepare("INSERT OR IGNORE INTO deposit_reports (tx_hash, sender, reported_by, status, created_at, updated_at) VALUES (?, ?, ?, 'pending', ?, ?)").run(hash, sender, me.id, now(), now());
    const row = this.db.prepare('SELECT * FROM deposit_reports WHERE tx_hash = ?').get(hash);
    if (row.status === 'pending') await this.#checkReport(row).catch((err) => this.#noteReport(hash, err.message));
    return this.depositReport(hash);
  }

  depositReport(hash) {
    const r = this.db.prepare('SELECT tx_hash, sender, status, error, attempts, created_at, updated_at FROM deposit_reports WHERE tx_hash = ?').get(hash);
    if (!r) throw new HttpError(404, 'no report for that transaction', 'not_found');
    const deposits = this.db.prepare('SELECT id, from_address AS from_account, credited, status FROM deposits WHERE tx_hash = ? ORDER BY log_index').all(hash);
    return { ...r, deposits, explorer_url: this.explorerTx(hash) };
  }

  #noteReport(hash, error) {
    this.db.prepare('UPDATE deposit_reports SET error = ?, attempts = attempts + 1, updated_at = ? WHERE tx_hash = ?').run(error, now(), hash);
  }

  async #checkReport(row) {
    let res = await this.chain.depositsIn(row.tx_hash, row.sender);
    // the hash may have been reported with the wrong sender; the linked account of the reporter is the next best guess
    if (res === null && row.reported_by) {
      const alt = this.wallet(row.reported_by)?.account_id;
      if (alt && alt !== row.sender) { res = await this.chain.depositsIn(row.tx_hash, alt); if (res) this.db.prepare('UPDATE deposit_reports SET sender = ? WHERE tx_hash = ?').run(alt, row.tx_hash); }
    }
    if (res === null || !res.final) {
      const expired = now() - row.created_at > REPORT_TTL;
      this.db.prepare('UPDATE deposit_reports SET status = ?, error = ?, attempts = attempts + 1, updated_at = ? WHERE tx_hash = ?')
        .run(expired ? 'not_found' : 'pending', res === null ? 'transaction not found on NEAR yet' : 'waiting for finality', now(), row.tx_hash);
      return;
    }
    tx(this.db, () => {
      const transfers = [...res.transfers].sort((a, b) => (a.from < b.from ? -1 : a.from > b.from ? 1 : 0));
      transfers.forEach((t, i) => this.#recordDeposit(row.tx_hash, i, t.from, t.value));
      this.db.prepare('UPDATE deposit_reports SET status = ?, error = ?, attempts = attempts + 1, updated_at = ? WHERE tx_hash = ?')
        .run(transfers.length ? 'done' : 'no_deposit', transfers.length ? null : `no ${this.cfg.symbol} reached ${this.chain.treasury} in this transaction`, now(), row.tx_hash);
    });
  }

  async scanDeposits() {
    let found = 0;
    if (this.cfg.indexerUrl !== null && now() - this.lastIndexScan >= INDEXER_EVERY) {
      this.lastIndexScan = now();
      try {
        for (const h of await this.chain.recentDepositTxs()) {
          const r = this.db.prepare("INSERT OR IGNORE INTO deposit_reports (tx_hash, sender, status, created_at, updated_at) VALUES (?, ?, 'pending', ?, ?)").run(h.txHash, h.sender, now(), now());
          found += r.changes;
        }
        this.indexerError = null;
      } catch (err) {
        this.indexerError = err.message; // only a hint source: never blocks payments
      }
    }
    const pending = this.db.prepare("SELECT * FROM deposit_reports WHERE status = 'pending' ORDER BY created_at LIMIT 50").all();
    for (const row of pending) await this.#checkReport(row);
    return found;
  }

  deposits(accountId, limit = 50) {
    return this.db.prepare('SELECT id, tx_hash, from_address AS from_account, raw_amount, credited, status, created_at FROM deposits WHERE account_id = ? ORDER BY created_at DESC LIMIT ?').all(accountId, limit)
      .map((d) => ({ ...d, explorer_url: this.explorerTx(d.tx_hash) }));
  }

  depositReports(accountId, limit = 20) {
    return this.db.prepare("SELECT tx_hash, sender, status, error, created_at FROM deposit_reports WHERE reported_by = ? AND status != 'done' ORDER BY created_at DESC LIMIT ?").all(accountId, limit);
  }

  // ---------- withdrawals ----------
  requestWithdrawal(me, input) {
    this.#needReady();
    const amount = int(input.amount, 'amount', { min: this.cfg.minWithdrawal, max: Number.MAX_SAFE_INTEGER });
    return tx(this.db, () => {
      const w = this.wallet(me.id);
      if (!w) throw new HttpError(409, 'link a NEAR account first; withdrawals only go to your linked account', 'no_wallet');
      if (this.market.balance(me.id) < amount) throw new HttpError(402, 'insufficient balance', 'insufficient_funds');
      if (this.cfg.maxWithdrawalPerDay) {
        const used = Number(this.db.prepare("SELECT COALESCE(SUM(amount), 0) AS s FROM withdrawals WHERE account_id = ? AND created_at > ? AND status NOT IN ('rejected', 'failed', 'refunded')").get(me.id, now() - 24 * 60 * MINUTE).s);
        if (used + amount > this.cfg.maxWithdrawalPerDay) throw new HttpError(429, `daily withdrawal limit is ${this.cfg.maxWithdrawalPerDay}; ${Math.max(0, this.cfg.maxWithdrawalPerDay - used)} left in the last 24 hours`, 'daily_limit');
      }
      const id = newId('wd');
      const t = now();
      this.db.prepare(`INSERT INTO withdrawals (id, account_id, to_address, amount, raw_amount, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)`).run(id, me.id, w.account_id, amount, (BigInt(amount) * this.unit()).toString(), t, t);
      this.market.transfer([[me.id, -amount], [SYS.withdrawals, amount]], 'withdrawal requested');
      return this.withdrawal(id);
    });
  }

  // Operator payout: move house fees (or another system-owned account, like the
  // house agent's earnings) to any NEAR account. Goes through the same review queue.
  requestOperatorWithdrawal(accountId, { amount, to }) {
    this.#needReady();
    const n = int(amount, 'amount', { min: 1, max: Number.MAX_SAFE_INTEGER });
    const dest = normAccount(to);
    if (!isAccountId(dest)) throw new HttpError(400, 'to must be a NEAR account, like alice.near', 'invalid_input');
    return tx(this.db, () => {
      if (this.market.balance(accountId) < n) throw new HttpError(402, `that account holds ${this.market.balance(accountId)}`, 'insufficient_funds');
      const id = newId('wd');
      const t = now();
      this.db.prepare(`INSERT INTO withdrawals (id, account_id, to_address, amount, raw_amount, status, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'pending', 'operator payout', ?, ?)`).run(id, accountId, dest, n, (BigInt(n) * this.unit()).toString(), t, t);
      this.market.transfer([[accountId, -n], [SYS.withdrawals, n]], 'operator payout requested');
      return this.withdrawal(id);
    });
  }

  withdrawal(id) {
    const w = this.db.prepare('SELECT w.*, a.name AS account_name FROM withdrawals w JOIN accounts a ON a.id = w.account_id WHERE w.id = ?').get(id);
    if (!w) throw new HttpError(404, 'withdrawal not found', 'not_found');
    const { raw_tx, to_address, ref_block, ...rest } = w;
    return { ...rest, to_account: to_address, explorer_url: w.tx_hash ? this.explorerTx(w.tx_hash) : null };
  }

  withdrawals({ accountId, status, limit = 100 } = {}) {
    const where = []; const args = [];
    if (accountId) where.push('account_id = ?'), args.push(accountId);
    if (status) where.push('status = ?'), args.push(status);
    const ids = this.db.prepare(`SELECT id FROM withdrawals ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY created_at DESC LIMIT ?`).all(...args, limit);
    return ids.map((r) => this.withdrawal(r.id));
  }

  #setWithdrawal(id, fields) {
    const cols = Object.keys(fields);
    this.db.prepare(`UPDATE withdrawals SET ${cols.map((c) => `${c} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(...cols.map((c) => fields[c]), now(), id);
  }

  #refund(w, status, note) {
    this.market.transfer([[SYS.withdrawals, -w.amount], [w.account_id, w.amount]], `withdrawal ${status}`);
    this.#setWithdrawal(w.id, { status, note });
  }

  reject(id, reason) {
    const why = str(reason, 'reason', { min: 3, max: 500 });
    return tx(this.db, () => {
      const w = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
      if (!w) throw new HttpError(404, 'withdrawal not found', 'not_found');
      if (w.status !== 'pending') throw new HttpError(409, `cannot reject a withdrawal that is ${w.status}`, 'invalid_state');
      this.#refund(w, 'rejected', why);
      return this.withdrawal(id);
    });
  }

  // Approve: claim the row, then sign and broadcast one at a time.
  approve(id) {
    this.#needReady();
    if (!this.chain.canSend) throw new HttpError(503, 'no hot wallet key is configured, so withdrawals cannot be sent', 'no_hot_wallet');
    const w = tx(this.db, () => {
      const row = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
      if (!row) throw new HttpError(404, 'withdrawal not found', 'not_found');
      if (row.status !== 'pending') throw new HttpError(409, `cannot approve a withdrawal that is ${row.status}`, 'invalid_state');
      this.#setWithdrawal(id, { status: 'signing', error: null });
      return row;
    });
    const job = this.queue.then(() => this.#send(w));
    this.queue = job.catch(() => {});
    return job;
  }

  async #send(w) {
    let signed;
    try {
      const raw = BigInt(w.raw_amount);
      const have = await this.chain.tokenBalance(this.chain.treasury);
      if (have < raw) throw new Error(`the treasury holds ${have / this.unit()} ${this.cfg.symbol}, needs ${w.amount}`);
      // a nonce above every transfer already signed, even ones not yet on-chain
      const minNonce = Number(this.db.prepare('SELECT COALESCE(MAX(nonce), 0) AS n FROM withdrawals WHERE tx_hash IS NOT NULL').get().n);
      signed = await this.chain.signTransfer(w.to_address, raw, { minNonce, memo: `Bountyhall withdrawal ${w.id}` });
    } catch (err) {
      // nothing left the building: put it back in the queue
      this.#setWithdrawal(w.id, { status: 'pending', error: err.message });
      throw new HttpError(502, `could not sign the transfer: ${err.message}`, 'send_failed');
    }
    // record the hash before broadcasting, so a crash can never lose track of a sent transfer
    this.#setWithdrawal(w.id, { status: 'sending', tx_hash: signed.hash, nonce: signed.nonce, raw_tx: signed.raw, ref_block: signed.blockHash });
    try {
      await this.chain.broadcast(signed.raw);
    } catch (err) {
      this.#setWithdrawal(w.id, { error: `broadcast failed: ${err.message}` });
    }
    return this.withdrawal(w.id);
  }

  async rebroadcast(id) {
    const w = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
    if (!w) throw new HttpError(404, 'withdrawal not found', 'not_found');
    if (w.status !== 'sending') throw new HttpError(409, 'only withdrawals that are sending can be rebroadcast', 'invalid_state');
    try { await this.chain.broadcast(w.raw_tx); this.#setWithdrawal(id, { error: null }); } catch (err) {
      this.#setWithdrawal(id, { error: `rebroadcast failed: ${err.message}` });
    }
    return this.withdrawal(id);
  }

  // Refund a transfer that can never be included: unknown to the chain, and its
  // nonce is spent or its block hash has expired.
  async refundDropped(id) {
    const w = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
    if (!w) throw new HttpError(404, 'withdrawal not found', 'not_found');
    if (w.status !== 'sending') throw new HttpError(409, 'only withdrawals that are sending can be refunded', 'invalid_state');
    const before = await this.chain.receipt(w.tx_hash);
    if (before) throw new HttpError(409, before.status === 'pending' ? 'that transfer is on-chain and still executing' : 'that transfer is on-chain; wait for the watcher to settle it', before.status === 'pending' ? 'still_pending' : 'mined');
    const verdict = await this.chain.dropped({ nonce: w.nonce, blockHash: w.ref_block });
    if (verdict === 'too_old') throw new HttpError(409, 'this transfer is older than the RPC history: check it on the explorer, or point NEAR_RPC_URL at an archival node', 'too_old');
    if (!verdict) throw new HttpError(409, 'it could still be included: rebroadcast it instead', 'not_dropped');
    // look once more, so a transfer included a moment ago is never refunded
    if (await this.chain.receipt(w.tx_hash)) throw new HttpError(409, 'that transfer just landed on-chain', 'mined');
    return tx(this.db, () => {
      const row = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(id);
      if (row.status !== 'sending') throw new HttpError(409, `withdrawal is ${row.status}`, 'invalid_state');
      this.#refund(row, 'refunded', 'transfer was dropped; refunded to the account');
      return this.withdrawal(id);
    });
  }

  async trackWithdrawals() {
    const sending = this.db.prepare("SELECT * FROM withdrawals WHERE status = 'sending'").all();
    let settled = 0;
    for (const w of sending) {
      const r = await this.chain.receipt(w.tx_hash);
      if (!r || !r.final || r.status === 'pending') continue;
      tx(this.db, () => {
        const row = this.db.prepare('SELECT * FROM withdrawals WHERE id = ?').get(w.id);
        if (row.status !== 'sending') return;
        if (r.status === 'success') {
          this.market.transfer([[SYS.withdrawals, -row.amount], [SYS.chain, row.amount]], 'withdrawal sent');
          this.#setWithdrawal(row.id, { status: 'confirmed', error: null });
        } else {
          this.#refund(row, 'failed', 'the transfer failed on-chain; refunded to the account');
        }
      });
      settled++;
    }
    return settled;
  }

  async poll() {
    if (!this.ready && !(await this.init())) return { ready: false };
    try {
      const deposits = await this.scanDeposits();
      const withdrawals = await this.trackWithdrawals();
      this.lastError = null;
      return { ready: true, deposits, withdrawals };
    } catch (err) {
      this.lastError = err.message;
      this.log.error?.(`[payments] poll failed: ${this.lastError}`);
      return { ready: true, error: this.lastError };
    }
  }

  // ---------- solvency ----------
  async treasury() {
    const owed = -this.market.balance(SYS.chain);
    const out = {
      account: this.chain.treasury, token_contract: this.chain.token, symbol: this.cfg.symbol, ready: this.ready, last_error: this.lastError,
      owed_total: owed, held_by_users: null, in_escrow: this.market.balance(SYS.escrow), fees: this.market.balance(SYS.fees),
      pending_withdrawals: this.market.balance(SYS.withdrawals), unbacked_signup_credits: -this.market.balance(SYS.faucet),
      unclaimed_deposits: Number(this.db.prepare("SELECT COALESCE(SUM(credited), 0) AS s FROM deposits WHERE status = 'unclaimed'").get().s),
      pending_reports: this.db.prepare("SELECT COUNT(*) AS c FROM deposit_reports WHERE status = 'pending'").get().c,
      treasury_registered: this.treasuryRegistered, indexer: this.cfg.indexerUrl ? (this.indexerError ? `error: ${this.indexerError}` : 'ok') : 'off',
    };
    out.held_by_users = owed - out.in_escrow - out.fees - out.pending_withdrawals;
    if (this.ready) {
      const [tokens, near] = await Promise.all([this.chain.tokenBalance(this.chain.treasury), this.chain.nativeBalance(this.chain.treasury)]);
      out.onchain_balance = Number(tokens / this.unit());
      out.near_balance = formatNear(near);
      out.solvent = out.onchain_balance >= owed;
      out.surplus = out.onchain_balance - owed;
    }
    return out;
  }
}
