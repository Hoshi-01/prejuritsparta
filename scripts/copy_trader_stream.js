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

function parseBool(v, dflt = true) {
  const s = String(v ?? '').trim().toLowerCase();
  if (!s) return dflt;
  if (['1', 'true', 'yes', 'y', 'on'].includes(s)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(s)) return false;
  return dflt;
}

function parseArgs(argv) {
  const out = {
    source: '',
    mode: 'paper',
    profile: 'fast',
    sizeMode: 'percent',
    myBalanceUsdc: 100,
    sourceBalanceUsdc: 20000,
    fixedOrderUsdc: 1,
    minPrice: 0.01,
    maxPrice: 0.99,
    maxLagMs: 1200,
    maxSpread: 0.03,
    crossTick: 0.01,
    bootstrapSeconds: 180,
    reconcileSeconds: 20,
    tradeFetchLimit: 80,
    maxParallel: 12,
    minAssetRefreshMs: 250,
    refreshDebounceMs: 120,
    activityCacheMs: 120,
    bookHttpFallback: true,
    bookTtlMs: 3000,
    pythonBin: 'python3',
    liveExec: 'python-bridge',
    benchmarkSeconds: 0,
    statsEvery: 25,
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
      'tradeFetchLimit', 'maxParallel', 'minAssetRefreshMs', 'refreshDebounceMs',
      'activityCacheMs', 'bookTtlMs', 'benchmarkSeconds', 'statsEvery',
    ]);

    if (key === 'bookHttpFallback') {
      out[key] = parseBool(next, true);
    } else {
      out[key] = nKeys.has(key) ? Number(next) : next;
    }
  }

  applyProfile(out);
  return out;
}

function applyProfile(cfg) {
  const profile = String(cfg.profile || 'fast').toLowerCase();
  cfg.profile = profile;

  if (profile === 'turbo') {
    cfg.maxParallel = cfg.maxParallel || 24;
    cfg.minAssetRefreshMs = Math.min(cfg.minAssetRefreshMs || 100, 100);
    cfg.refreshDebounceMs = Math.min(cfg.refreshDebounceMs || 40, 40);
    cfg.activityCacheMs = Math.min(cfg.activityCacheMs || 40, 40);
    cfg.reconcileSeconds = Math.min(cfg.reconcileSeconds || 10, 10);
    cfg.bookHttpFallback = cfg.bookHttpFallback && false;
    cfg.bookTtlMs = Math.max(cfg.bookTtlMs || 8000, 8000);
    cfg.tradeFetchLimit = Math.max(cfg.tradeFetchLimit || 120, 120);
    return;
  }

  // fast profile default (low-latency but safety checks remain)
  cfg.maxParallel = Math.max(6, cfg.maxParallel || 12);
  cfg.minAssetRefreshMs = Math.min(cfg.minAssetRefreshMs || 250, 250);
  cfg.refreshDebounceMs = Math.min(cfg.refreshDebounceMs || 120, 120);
  cfg.activityCacheMs = Math.min(cfg.activityCacheMs || 120, 120);
  cfg.reconcileSeconds = Math.min(cfg.reconcileSeconds || 20, 20);
}

function usage() {
  return `Usage:
  node scripts/copy_trader_stream.js --source @handle [--paper|--live] [options]

Sizing:
  --size-mode percent|fixed
  --my-balance-usdc 100 --source-balance-usdc 20000
  --fixed-order-usdc 1

Latency profiles:
  --profile fast|turbo               (default: fast)
  --refresh-debounce-ms 120          (turbo defaults to 40)
  --min-asset-refresh-ms 250         (turbo defaults to 100)
  --book-http-fallback true|false    (turbo defaults to false)

Risk params:
  --max-lag-ms 1200 --max-spread 0.03 --cross-tick 0.01
  --min-price 0.01 --max-price 0.99

Benchmark:
  --paper --benchmark-seconds 120 --stats-every 25

Live execution:
  --live --live-exec python-bridge --python-bin python3
`;}

function normalizeTsMs(v) {
  const ts = Number(v);
  if (!Number.isFinite(ts) || ts <= 0) return 0;
  return ts < 10_000_000_000 ? Math.floor(ts * 1000) : Math.floor(ts);
}

function itemKey(it) {
  return [it.transactionHash ?? '', it.asset ?? '', it.side ?? '', it.timestamp ?? '', it.price ?? '', it.size ?? ''].join('|');
}

function pctl(vals, p) {
  if (!vals.length) return 0;
  const sorted = [...vals].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}

async function getJson(url, params = {}) {
  const u = new URL(url);
  Object.entries(params).forEach(([k, v]) => {
    if (v != null) u.searchParams.set(k, String(v));
  });
  const r = await fetch(u, { headers: { 'user-agent': 'botsparta-copy-trader-stream/1.1-latency' } });
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

    this.pendingAssets = new Set();
    this.pendingMetaByAsset = new Map();
    this.refreshTimer = null;
    this.refreshInFlight = null;
    this.lastActivityFetchMs = 0;
    this.lastActivityItems = [];

    this.latencySamples = [];
    this.maxSamples = 5000;
    this.benchmarkTimer = null;
  }

  async start() {
    this.validateConfig();

    this.sourceWallet = await resolveSourceToWallet(this.cfg.source);
    console.log(`🎯 Source resolved: ${this.cfg.source} -> ${this.sourceWallet}`);

    if (this.cfg.sizeMode === 'percent') {
      const ratio = this.cfg.myBalanceUsdc / this.cfg.sourceBalanceUsdc;
      console.log(`⚙️ Mode=${this.cfg.mode.toUpperCase()} Profile=${this.cfg.profile.toUpperCase()} Sizing=PERCENT ratio=${ratio.toFixed(6)}`);
    } else {
      console.log(`⚙️ Mode=${this.cfg.mode.toUpperCase()} Profile=${this.cfg.profile.toUpperCase()} Sizing=FIXED usdc=${this.cfg.fixedOrderUsdc}`);
    }

    await this.bootstrap();
    this.connectWS();
    this.startReconcileLoop();

    if (this.cfg.benchmarkSeconds > 0) {
      this.benchmarkTimer = setTimeout(() => {
        this.stop('benchmark-complete');
      }, this.cfg.benchmarkSeconds * 1000);
      console.log(`⏱️ Benchmark mode active for ${this.cfg.benchmarkSeconds}s`);
    }

    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));
  }

  stop(reason) {
    if (this.stopped) return;
    this.stopped = true;
    if (this.ws) {
      try { this.ws.close(); } catch {}
    }
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.benchmarkTimer) clearTimeout(this.benchmarkTimer);
    console.log(`🛑 Stopping (${reason})`);
    this.printLatencySummary('final');
    if (this.cfg.benchmarkSeconds > 0) process.exit(0);
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
        this.sem.run(() => this.processTradeItem(it, 'bootstrap', { eventTs: ts, recvTs: now })).catch(() => {});
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

  requestActivityRefresh(asset, reason, meta = {}) {
    if (asset) {
      this.pendingAssets.add(asset);
      if (!this.pendingMetaByAsset.has(asset)) this.pendingMetaByAsset.set(asset, meta);
    }

    if (this.refreshTimer) return;
    const now = Date.now();
    const elapsed = now - this.lastActivityFetchMs;
    const delay = Math.max(0, this.cfg.refreshDebounceMs - elapsed);

    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      this.runActivityRefresh(reason).catch((e) => console.error('[refresh error]', e.message));
    }, delay);
  }

  async runActivityRefresh(reason = 'refresh') {
    if (this.refreshInFlight) return;

    this.refreshInFlight = (async () => {
      const now = Date.now();
      const useCache = this.lastActivityItems.length > 0 && (now - this.lastActivityFetchMs) <= this.cfg.activityCacheMs;
      const items = useCache
        ? this.lastActivityItems
        : await fetchSourceActivity(this.sourceWallet, this.cfg.tradeFetchLimit);

      if (!useCache) {
        this.lastActivityItems = items;
        this.lastActivityFetchMs = Date.now();
      }

      const focusAssets = this.pendingAssets.size ? new Set(this.pendingAssets) : null;
      const metaByAsset = new Map(this.pendingMetaByAsset);
      this.pendingAssets.clear();
      this.pendingMetaByAsset.clear();

      for (const it of items) {
        const asset = String(it.asset || '');
        if (focusAssets && asset && !focusAssets.has(asset)) continue;
        const k = itemKey(it);
        if (this.seen.has(k)) continue;
        this.seen.add(k);

        const fallbackTs = normalizeTsMs(it.timestamp);
        const m = metaByAsset.get(asset) || {};
        const meta = {
          eventTs: m.eventTs || fallbackTs,
          recvTs: m.recvTs || Date.now(),
        };

        this.sem.run(() => this.processTradeItem(it, reason, meta)).catch(() => {});
      }
    })();

    try {
      await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
      if (this.pendingAssets.size > 0 && !this.stopped) this.requestActivityRefresh('', 'refresh-flush');
    }
  }

  async handleWSMessage(raw) {
    let data;
    try {
      data = JSON.parse(String(raw));
    } catch {
      return;
    }

    const recvTs = Date.now();
    const arr = Array.isArray(data) ? data : [data];
    for (const m of arr) {
      const type = m?.event_type;
      if (type === 'book') {
        const bids = Array.isArray(m.bids) ? m.bids : [];
        const asks = Array.isArray(m.asks) ? m.asks : [];
        const bestBid = bids.length ? Number(bids[0].price) : null;
        const bestAsk = asks.length ? Number(asks[0].price) : null;
        const spread = bestBid != null && bestAsk != null ? bestAsk - bestBid : null;
        this.books.set(String(m.asset_id || ''), { bestBid, bestAsk, spread, updatedAtMs: recvTs });
        continue;
      }

      if (type === 'last_trade_price') {
        const asset = String(m.asset_id || '');
        if (!asset || !this.trackedAssets.has(asset)) continue;

        const now = recvTs;
        const last = this.lastAssetRefreshMs.get(asset) || 0;
        if (now - last < this.cfg.minAssetRefreshMs) continue;
        this.lastAssetRefreshMs.set(asset, now);

        this.requestActivityRefresh(asset, 'ws-trigger', {
          eventTs: normalizeTsMs(m.timestamp || m.ts || m.created_at || m.createdAt),
          recvTs,
        });
      }
    }
  }

  async getTopOfBook(asset) {
    const cached = this.books.get(asset);
    if (cached && (Date.now() - cached.updatedAtMs) <= this.cfg.bookTtlMs) return cached;

    if (!this.cfg.bookHttpFallback) {
      return cached || { bestBid: null, bestAsk: null, spread: null, updatedAtMs: 0 };
    }

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
      return cached || { bestBid: null, bestAsk: null, spread: null, updatedAtMs: 0 };
    }
  }

  recordLatency(sample) {
    this.latencySamples.push(sample);
    if (this.latencySamples.length > this.maxSamples) {
      this.latencySamples.splice(0, this.latencySamples.length - this.maxSamples);
    }

    if (this.cfg.statsEvery > 0 && (this.latencySamples.length % this.cfg.statsEvery === 0)) {
      this.printLatencySummary(`n=${this.latencySamples.length}`);
    }
  }

  printLatencySummary(tag = '') {
    if (!this.latencySamples.length) {
      console.log(`📊 Latency summary (${tag}): no samples`);
      return;
    }

    const totals = this.latencySamples.map((s) => s.totalMs).filter((v) => Number.isFinite(v) && v >= 0);
    const decision = this.latencySamples.map((s) => s.decisionMs).filter((v) => Number.isFinite(v) && v >= 0);
    const submit = this.latencySamples.map((s) => s.submitMs).filter((v) => Number.isFinite(v) && v >= 0);
    const ack = this.latencySamples.map((s) => s.ackMs).filter((v) => Number.isFinite(v) && v >= 0);

    const fmt = (v) => Number(v || 0).toFixed(1);
    console.log(
      `📊 Latency (${tag}) count=${totals.length} ` +
      `total_ms[p50=${fmt(pctl(totals, 50))} p90=${fmt(pctl(totals, 90))} p99=${fmt(pctl(totals, 99))}] ` +
      `decision_ms[p50=${fmt(pctl(decision, 50))} p90=${fmt(pctl(decision, 90))}] ` +
      `submit_ms[p50=${fmt(pctl(submit, 50))}] ack_ms[p50=${fmt(pctl(ack, 50))}]`
    );
  }

  async processTradeItem(it, reason, meta = {}) {
    const side = String(it?.side || '').toUpperCase();
    const asset = String(it?.asset || '');
    const srcPrice = Number(it?.price || 0);

    const telemetry = {
      eventTs: meta.eventTs || normalizeTsMs(it?.timestamp),
      recvTs: meta.recvTs || Date.now(),
      decisionTs: 0,
      submitTs: 0,
      ackTs: 0,
    };

    if (!['BUY', 'SELL'].includes(side) || !asset) return;
    if (!(srcPrice >= this.cfg.minPrice && srcPrice <= this.cfg.maxPrice)) return;

    const lagMs = telemetry.eventTs ? (telemetry.recvTs - telemetry.eventTs) : 0;
    if (telemetry.eventTs && lagMs > this.cfg.maxLagMs) return;

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
    telemetry.decisionTs = Date.now();

    if (this.cfg.mode === 'paper') {
      telemetry.submitTs = telemetry.decisionTs;
      telemetry.ackTs = Date.now();

      const sample = {
        eventTs: telemetry.eventTs,
        recvTs: telemetry.recvTs,
        decisionTs: telemetry.decisionTs,
        submitTs: telemetry.submitTs,
        ackTs: telemetry.ackTs,
        ingestMs: telemetry.eventTs ? (telemetry.recvTs - telemetry.eventTs) : 0,
        decisionMs: telemetry.decisionTs - telemetry.recvTs,
        submitMs: telemetry.submitTs - telemetry.decisionTs,
        ackMs: telemetry.ackTs - telemetry.submitTs,
        totalMs: telemetry.ackTs - (telemetry.eventTs || telemetry.recvTs),
      };
      this.recordLatency(sample);

      console.log(
        `[PAPER:${reason}] ${side} token=${asset.slice(0, 14)}.. px=${px.toFixed(4)} src_px=${srcPrice.toFixed(4)} ` +
        `src=$${srcUsdc.toFixed(2)} copy=$${copyUsdc.toFixed(2)} shares=${shares.toFixed(4)} ` +
        `lag=${lagMs}ms spread=${spread ?? 'na'} ` +
        `lat={eventTs:${sample.eventTs},recvTs:${sample.recvTs},decisionTs:${sample.decisionTs},submitTs:${sample.submitTs},ackTs:${sample.ackTs},` +
        `ms:{ingest:${sample.ingestMs},decision:${sample.decisionMs},submit:${sample.submitMs},ack:${sample.ackMs},total:${sample.totalMs}}}`
      );
      return;
    }

    telemetry.submitTs = Date.now();
    const ok = await this.execLiveOrder({ tokenId: asset, side, price: px, shares });
    telemetry.ackTs = Date.now();

    const sample = {
      eventTs: telemetry.eventTs,
      recvTs: telemetry.recvTs,
      decisionTs: telemetry.decisionTs,
      submitTs: telemetry.submitTs,
      ackTs: telemetry.ackTs,
      ingestMs: telemetry.eventTs ? (telemetry.recvTs - telemetry.eventTs) : 0,
      decisionMs: telemetry.decisionTs - telemetry.recvTs,
      submitMs: telemetry.submitTs - telemetry.decisionTs,
      ackMs: telemetry.ackTs - telemetry.submitTs,
      totalMs: telemetry.ackTs - (telemetry.eventTs || telemetry.recvTs),
    };
    this.recordLatency(sample);

    if (ok.success) {
      console.log(
        `[LIVE OK] ${side} token=${asset.slice(0, 14)}.. px=${px.toFixed(4)} shares=${shares.toFixed(4)} ` +
        `lag=${lagMs}ms spread=${spread ?? 'na'} ` +
        `lat_ms={ingest:${sample.ingestMs},decision:${sample.decisionMs},submit:${sample.submitMs},ack:${sample.ackMs},total:${sample.totalMs}} ${ok.message}`
      );
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
          const ts = normalizeTsMs(it.timestamp);
          this.sem.run(() => this.processTradeItem(it, 'reconcile', { eventTs: ts, recvTs: Date.now() })).catch(() => {});
        }

        if (addedAssets > 0 && this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ assets_ids: [...this.trackedAssets], type: 'MARKET' }));
          console.log(`➕ Added assets=${addedAssets}; total subscribed=${this.trackedAssets.size}`);
        }
      } catch (e) {
        console.error('[reconcile]', e.message);
      } finally {
        setTimeout(run, Math.max(2, this.cfg.reconcileSeconds) * 1000);
      }
    };

    setTimeout(run, Math.max(2, this.cfg.reconcileSeconds) * 1000);
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
