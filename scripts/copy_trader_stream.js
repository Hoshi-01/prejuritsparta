#!/usr/bin/env node
'use strict';

/**
 * Event-driven copy trader for Polymarket (Node.js).
 *
 * Primary trigger: CLOB market websocket events (last_trade_price/book).
 * Data API is used only for source-trade lookup/reconciliation.
 */

const { spawn } = require('node:child_process');

const GAMMA_BASE = 'https://gamma-api.polymarket.com';
const DATA_BASE = 'https://data-api.polymarket.com';
const WSS_MARKET_URL = 'wss://ws-subscriptions-clob.polymarket.com/ws/market';
const CLOB_BOOK_URL = 'https://clob.polymarket.com/book';

function parseArgs(argv) {
  const out = {
    source: '',
    mode: 'paper',
    sizeMode: 'percent',
    myBalanceUsdc: 100,
    sourceBalanceUsdc: 20000,
    fixedOrderUsdc: 1,
    minPrice: 0.01,
    maxPrice: 0.99,
    maxLagMs: 1500,
    maxSpread: 0.03,
    crossTick: 0.01,
    bootstrapSeconds: 180,
    reconcileSeconds: 45,
    tradeFetchLimit: 30,
    maxParallel: 4,
    minAssetRefreshMs: 750,
    pythonBin: 'python3',
    liveExec: 'python-bridge',
    help: false,
  };

  const toKey = (arg) => arg.replace(/^--/, '').replace(/-([a-z])/g, (_, c) => c.toUpperCase());

  for (let i = 2; i < argv.length; i += 1) {
    const raw = argv[i];
    if (raw === '--help' || raw === '-h') {
      out.help = true;
      continue;
    }
    if (!raw.startsWith('--')) continue;

    const key = toKey(raw);
    const next = argv[i + 1];

    if (['paper'].includes(key)) {
      out.mode = 'paper';
      continue;
    }
    if (['live'].includes(key)) {
      out.mode = 'live';
      continue;
    }

    if (next == null || next.startsWith('--')) continue;
    i += 1;

    const nKeys = new Set([
      'myBalanceUsdc', 'sourceBalanceUsdc', 'fixedOrderUsdc', 'minPrice', 'maxPrice',
      'maxLagMs', 'maxSpread', 'crossTick', 'bootstrapSeconds', 'reconcileSeconds',
      'tradeFetchLimit', 'maxParallel', 'minAssetRefreshMs',
    ]);
    out[key] = nKeys.has(key) ? Number(next) : next;
  }

  return out;
}

function usage() {
  return `Usage:\n  node scripts/copy_trader_stream.js --source @handle [--paper|--live] [options]\n\nSizing:\n  --size-mode percent|fixed\n  --my-balance-usdc 100 --source-balance-usdc 20000\n  --fixed-order-usdc 1\n\nRisk params:\n  --max-lag-ms 1500 --max-spread 0.03 --cross-tick 0.01\n  --min-price 0.01 --max-price 0.99\n\nLive execution:\n  --live --live-exec python-bridge --python-bin python3\n`;}

function normalizeTsMs(v) {
  const ts = Number(v);
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return ts < 10_000_000_000 ? Math.floor(ts * 1000) : Math.floor(ts);
}

function itemKey(it) {
  return [it.transactionHash ?? '', it.asset ?? '', it.side ?? '', it.timestamp ?? '', it.price ?? '', it.size ?? ''].join('|');
}

async function getJson(url, params = {}) {
  const u = new URL(url);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null) u.searchParams.set(k, String(v));
  });
  const r = await fetch(u, { headers: { 'user-agent': 'botsparta-copy-trader-stream/1.0' } });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`${r.status} ${r.statusText} :: ${t.slice(0, 200)}`);
  }
  return r.json();
}

async function resolveSourceToWallet(source) {
  const s = String(source || '').trim();
  if (s.startsWith('0x') && s.length === 42) return s;

  const handle = s.startsWith('@') ? s.slice(1) : s;
  const data = await getJson(`${GAMMA_BASE}/public-search`, {
    q: handle,
    search_profiles: 'true',
    limit_per_type: 20,
  });
  const profiles = Array.isArray(data?.profiles) ? data.profiles : [];
  const exact = profiles.find((p) => String(p?.pseudonym || '').toLowerCase() === handle.toLowerCase() && p?.proxyWallet);
  if (exact?.proxyWallet) return exact.proxyWallet;
  const first = profiles.find((p) => p?.proxyWallet);
  if (first?.proxyWallet) return first.proxyWallet;
  throw new Error(`Could not resolve source profile/address: ${source}`);
}

async function fetchSourceActivity(userWallet, limit = 50) {
  const items = await getJson(`${DATA_BASE}/activity`, {
    user: userWallet,
    type: 'TRADE',
    limit,
    offset: 0,
    sortBy: 'TIMESTAMP',
    sortDirection: 'DESC',
  });
  return Array.isArray(items) ? items : [];
}

class Semaphore {
  constructor(max = 4) {
    this.max = Math.max(1, max);
    this.active = 0;
    this.q = [];
  }

  async run(task) {
    if (this.active >= this.max) {
      await new Promise((resolve) => this.q.push(resolve));
    }
    this.active += 1;
    try {
      return await task();
    } finally {
      this.active -= 1;
      const next = this.q.shift();
      if (next) next();
    }
  }
}

class CopyTraderStream {
  constructor(cfg) {
    this.cfg = cfg;
    this.sourceWallet = '';
    this.ws = null;
    this.stopped = false;
    this.seen = new Set();
    this.trackedAssets = new Set();
    this.lastAssetRefreshMs = new Map();
    this.books = new Map(); // asset -> {bestBid,bestAsk,spread,updatedAtMs}
    this.sem = new Semaphore(cfg.maxParallel);
    this.startMs = Date.now();
  }

  async start() {
    this.validateConfig();

    this.sourceWallet = await resolveSourceToWallet(this.cfg.source);
    console.log(`🎯 Source resolved: ${this.cfg.source} -> ${this.sourceWallet}`);

    if (this.cfg.sizeMode === 'percent') {
      const ratio = this.cfg.myBalanceUsdc / this.cfg.sourceBalanceUsdc;
      console.log(`⚙️ Mode=${this.cfg.mode.toUpperCase()} Sizing=PERCENT ratio=${ratio.toFixed(6)}`);
    } else {
      console.log(`⚙️ Mode=${this.cfg.mode.toUpperCase()} Sizing=FIXED usdc=${this.cfg.fixedOrderUsdc}`);
    }

    await this.bootstrap();
    this.connectWS();
    this.startReconcileLoop();
  }

  validateConfig() {
    if (!this.cfg.source) throw new Error('--source is required');
    if (this.cfg.sizeMode === 'percent') {
      if (!(this.cfg.myBalanceUsdc > 0) || !(this.cfg.sourceBalanceUsdc > 0)) {
        throw new Error('--my-balance-usdc and --source-balance-usdc must be > 0');
      }
    }
    if (this.cfg.sizeMode === 'fixed' && !(this.cfg.fixedOrderUsdc > 0)) {
      throw new Error('--fixed-order-usdc must be > 0 in fixed mode');
    }
  }

  async bootstrap() {
    const items = await fetchSourceActivity(this.sourceWallet, 100);
    const now = Date.now();
    const cutoff = now - this.cfg.bootstrapSeconds * 1000;

    for (const it of items) {
      const k = itemKey(it);
      this.seen.add(k);
      const ts = normalizeTsMs(it.timestamp);
      const asset = String(it.asset || '');
      if (asset) this.trackedAssets.add(asset);
      if (ts && ts >= cutoff) {
        // Process fresh trades once at startup.
        this.sem.run(() => this.processTradeItem(it, 'bootstrap')).catch(() => {});
      }
    }

    console.log(`📦 Bootstrap loaded: ${items.length} activities, tracking assets=${this.trackedAssets.size}`);
  }

  connectWS() {
    const loop = () => {
      if (this.stopped) return;
      this.ws = new WebSocket(WSS_MARKET_URL);

      this.ws.addEventListener('open', () => {
        const assets = [...this.trackedAssets];
        if (assets.length === 0) {
          console.log('⚠️ No tracked assets yet; waiting for reconcile loop to discover assets...');
          return;
        }
        const msg = { assets_ids: assets, type: 'MARKET' };
        this.ws.send(JSON.stringify(msg));
        console.log(`🔌 WS connected; subscribed assets=${assets.length}`);
      });

      this.ws.addEventListener('message', (ev) => {
        this.handleWSMessage(ev.data).catch((e) => console.error('[WS msg error]', e.message));
      });

      this.ws.addEventListener('close', () => {
        if (this.stopped) return;
        console.log('🔁 WS closed, reconnecting in 3s...');
        setTimeout(loop, 3000);
      });

      this.ws.addEventListener('error', (err) => {
        console.error('[WS error]', err?.message || err);
      });
    };

    loop();
  }

  async handleWSMessage(raw) {
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }

    const arr = Array.isArray(data) ? data : [data];
    for (const m of arr) {
      const type = m?.event_type;
      if (type === 'book') {
        const bids = Array.isArray(m.bids) ? m.bids : [];
        const asks = Array.isArray(m.asks) ? m.asks : [];
        const bestBid = bids.length ? Number(bids[0].price) : null;
        const bestAsk = asks.length ? Number(asks[0].price) : null;
        const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
        this.books.set(String(m.asset_id || ''), { bestBid, bestAsk, spread, updatedAtMs: Date.now() });
        continue;
      }

      if (type === 'last_trade_price') {
        const asset = String(m.asset_id || '');
        if (!asset || !this.trackedAssets.has(asset)) continue;

        const now = Date.now();
        const last = this.lastAssetRefreshMs.get(asset) || 0;
        if (now - last < this.cfg.minAssetRefreshMs) continue;
        this.lastAssetRefreshMs.set(asset, now);

        this.sem.run(async () => {
          const recent = await fetchSourceActivity(this.sourceWallet, this.cfg.tradeFetchLimit);
          for (const it of recent) {
            if (String(it.asset || '') !== asset) continue;
            const k = itemKey(it);
            if (this.seen.has(k)) continue;
            this.seen.add(k);
            await this.processTradeItem(it, 'ws-trigger');
          }
        }).catch((e) => console.error('[refresh error]', e.message));
      }
    }
  }

  async getTopOfBook(asset) {
    const cached = this.books.get(asset);
    if (cached) return cached;

    try {
      const data = await getJson(CLOB_BOOK_URL, { token_id: asset });
      const bids = Array.isArray(data?.bids) ? data.bids : [];
      const asks = Array.isArray(data?.asks) ? data.asks : [];
      const bestBid = bids.length ? Number(bids[0].price) : null;
      const bestAsk = asks.length ? Number(asks[0].price) : null;
      const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
      const out = { bestBid, bestAsk, spread, updatedAtMs: Date.now() };
      this.books.set(asset, out);
      return out;
    } catch {
      return { bestBid: null, bestAsk: null, spread: null, updatedAtMs: 0 };
    }
  }

  async processTradeItem(it, reason) {
    const side = String(it?.side || '').toUpperCase();
    const asset = String(it?.asset || '');
    const srcPrice = Number(it?.price || 0);
    const ts = normalizeTsMs(it?.timestamp);

    if (!['BUY', 'SELL'].includes(side) || !asset) return;
    if (!(srcPrice >= this.cfg.minPrice && srcPrice <= this.cfg.maxPrice)) return;

    const lagMs = ts ? Date.now() - ts : 0;
    if (ts && lagMs > this.cfg.maxLagMs) return;

    const { bestBid, bestAsk, spread } = await this.getTopOfBook(asset);
    if (spread != null && spread > this.cfg.maxSpread) return;

    let px;
    if (side === 'BUY') {
      if (bestAsk == null) return;
      px = Math.min(this.cfg.maxPrice, bestAsk + this.cfg.crossTick);
    } else {
      if (bestBid == null) return;
      px = Math.max(this.cfg.minPrice, bestBid - this.cfg.crossTick);
    }
    px = Math.max(this.cfg.minPrice, Math.min(this.cfg.maxPrice, Math.round(px * 100) / 100));

    let srcUsdc = Number(it?.usdcSize || 0);
    if (!(srcUsdc > 0)) {
      const size = Number(it?.size || 0);
      if (size > 0) srcUsdc = size * px;
    }
    if (!(srcUsdc > 0)) return;

    const copyUsdc = this.cfg.sizeMode === 'percent'
      ? srcUsdc * (this.cfg.myBalanceUsdc / this.cfg.sourceBalanceUsdc)
      : this.cfg.fixedOrderUsdc;
    if (!(copyUsdc > 0)) return;

    const shares = copyUsdc / px;

    if (this.cfg.mode === 'paper') {
      console.log(`[PAPER:${reason}] ${side} token=${asset.slice(0, 14)}.. px=${px.toFixed(4)} src_px=${srcPrice.toFixed(4)} src=$${srcUsdc.toFixed(2)} copy=$${copyUsdc.toFixed(2)} shares=${shares.toFixed(4)} lag=${lagMs}ms spread=${spread ?? 'na'}`);
      return;
    }

    const ok = await this.execLiveOrder({ tokenId: asset, side, price: px, shares });
    if (ok.success) {
      console.log(`[LIVE OK] ${side} token=${asset.slice(0, 14)}.. px=${px.toFixed(4)} shares=${shares.toFixed(4)} lag=${lagMs}ms spread=${spread ?? 'na'} ${ok.message}`);
    } else {
      console.log(`[LIVE FAIL] ${side} token=${asset.slice(0, 14)}.. err=${ok.message}`);
    }
  }

  execLiveOrder({ tokenId, side, price, shares }) {
    if (this.cfg.liveExec !== 'python-bridge') {
      return Promise.resolve({ success: false, message: `unsupported --live-exec ${this.cfg.liveExec}` });
    }

    const args = [
      'scripts/place_order_once.py',
      '--token-id', tokenId,
      '--side', side,
      '--price', String(price),
      '--size', String(shares),
      '--order-type', 'FOK',
    ];

    return new Promise((resolve) => {
      const p = spawn(this.cfg.pythonBin, args, { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      let err = '';
      p.stdout.on('data', (d) => { out += d.toString(); });
      p.stderr.on('data', (d) => { err += d.toString(); });
      p.on('close', (code) => {
        const msg = [out.trim(), err.trim()].filter(Boolean).join(' | ');
        resolve({ success: code === 0, message: msg || `exit=${code}` });
      });
    });
  }

  startReconcileLoop() {
    const run = async () => {
      if (this.stopped) return;
      try {
        const recent = await fetchSourceActivity(this.sourceWallet, 100);
        let addedAssets = 0;
        for (const it of recent) {
          const asset = String(it.asset || '');
          if (asset && !this.trackedAssets.has(asset)) {
            this.trackedAssets.add(asset);
            addedAssets += 1;
          }

          const k = itemKey(it);
          if (this.seen.has(k)) continue;
          this.seen.add(k);
          this.sem.run(() => this.processTradeItem(it, 'reconcile')).catch(() => {});
        }

        if (addedAssets > 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ assets_ids: [...this.trackedAssets], type: 'MARKET' }));
          console.log(`➕ Added assets=${addedAssets}; total subscribed=${this.trackedAssets.size}`);
        }
      } catch (e) {
        console.error('[reconcile]', e.message);
      } finally {
        setTimeout(run, Math.max(5, this.cfg.reconcileSeconds) * 1000);
      }
    };

    setTimeout(run, Math.max(5, this.cfg.reconcileSeconds) * 1000);
  }
}

async function main() {
  const cfg = parseArgs(process.argv);
  if (cfg.help) {
    console.log(usage());
    process.exit(0);
  }

  const trader = new CopyTraderStream(cfg);
  await trader.start();
}

main().catch((e) => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
