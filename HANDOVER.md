# HANDOVER - Copy Trader

## Goal
Menjalankan copy-trade akun sumber ke akun kecil dengan sizing persentase.

## Script utama
- `scripts/run_copy_trader.py`

## Mode sizing
1) Percent (disarankan)
- Rumus: `copy_usdc = source_trade_usdc * (my_balance_usdc / source_balance_usdc)`
- Contoh akun kecil vs besar:
```bash
python3 scripts/run_copy_trader.py \
  --source @k9Q2mX4L8A7ZP3R \
  --paper \
  --size-mode percent \
  --my-balance-usdc 100 \
  --source-balance-usdc 20000
```

2) Fixed
```bash
python3 scripts/run_copy_trader.py --source @k9Q2mX4L8A7ZP3R --paper --size-mode fixed --fixed-order-usdc 1.0
```

## Node Stream Engine (tambahan baru)
- Script baru: `scripts/copy_trader_stream.js`
- Engine event-driven via CLOB WebSocket (`last_trade_price`/`book`) sebagai trigger utama.
- Reconcile Data API tetap ada tapi ringan (bukan trigger utama).
- Rumus sizing percent tetap: `copy_notional = source_trade_usdc * (my_balance/source_balance)`
- Risk params baru:
  - `--max-lag-ms`
  - `--max-spread`
  - `--cross-tick`
  - `--min-price`
  - `--max-price`
- Live mode Node pakai bridge Python baru: `scripts/place_order_once.py` (reuse env + bot existing).

### Run commands
Paper:
```bash
node scripts/copy_trader_stream.js --source @k9Q2mX4L8A7ZP3R --paper --size-mode percent --my-balance-usdc 100 --source-balance-usdc 20000
```

Live:
```bash
node scripts/copy_trader_stream.js --source @k9Q2mX4L8A7ZP3R --live --python-bin python3
```

Smoke test cepat:
```bash
node --check scripts/copy_trader_stream.js
node scripts/copy_trader_stream.js --help
python3 scripts/place_order_once.py --help
```

## Catatan
- Hardcap `--max-order-usdc` sudah dihapus sesuai permintaan user.
- Untuk live mode, hilangkan `--paper` dan pastikan `.env` valid.
