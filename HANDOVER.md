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

## Catatan
- Hardcap `--max-order-usdc` sudah dihapus sesuai permintaan user.
- Untuk live mode, hilangkan `--paper` dan pastikan `.env` valid.
