# Polymarket Trading Bot

English | [简体中文](README_CN.md)

A beginner-friendly Python trading bot for Polymarket with gasless transactions and real-time WebSocket data.

## Features

- **Simple API**: Just a few lines of code to start trading
- **Gasless Transactions**: No gas fees with Builder Program credentials
- **Real-time WebSocket**: Live orderbook updates via WebSocket
- **15-Minute Markets**: Built-in support for BTC/ETH/SOL/XRP 15-minute Up/Down markets
- **Flash Crash Strategy**: Pre-built strategy for volatility trading
- **Terminal UI**: Real-time orderbook display with in-place updates
- **Secure Key Storage**: Private keys encrypted with PBKDF2 + Fernet
- **Fully Tested**: 89 unit tests covering all functionality

## Quick Start (5 Minutes)

### Step 1: Install

```bash
git clone https://github.com/your-username/polymarket-trading-bot.git
cd polymarket-trading-bot
pip install -r requirements.txt
```

### Step 2: Configure

```bash
# Set your credentials
export POLY_PRIVATE_KEY=your_metamask_private_key
export POLY_SAFE_ADDRESS=0xYourPolymarketSafeAddress
```

> **Where to find your Safe address?** Go to [polymarket.com/settings](https://polymarket.com/settings) and copy your wallet address.

### Step 3: Run

```bash
# Run the quickstart example
python examples/quickstart.py

# Or run the Flash Crash Strategy
python strategies/flash_crash_strategy.py --coin BTC
```

That's it! You're ready to trade.

## Trading Strategies

### Flash Crash Strategy

Monitors 15-minute Up/Down markets for sudden probability drops and executes trades automatically.

```bash
# Run with default settings (0.30 drop threshold)
python strategies/flash_crash_strategy.py --coin BTC

# Custom settings
python strategies/flash_crash_strategy.py --coin ETH --drop 0.25 --size 10

# Available options
--coin      BTC, ETH, SOL, XRP (default: ETH)
--drop      Drop threshold as absolute change (default: 0.30)
--size      Trade size in USDC (default: 5.0)
--lookback  Detection window in seconds (default: 10)
--take-profit  TP in dollars (default: 0.10)
--stop-loss    SL in dollars (default: 0.05)
```

**Strategy Logic:**
1. Auto-discover current 15-minute market
2. Monitor orderbook prices via WebSocket in real-time
3. When probability drops by 0.30+ in 10 seconds, buy the crashed side
4. Exit at +$0.10 (take profit) or -$0.05 (stop loss)

## Strategy Development Guide

- See `docs/strategy_guide.md` for a step-by-step tutorial and templates.

### Real-time Orderbook TUI

View live orderbook data in a beautiful terminal interface:

```bash
python strategies/orderbook_tui.py --coin BTC --levels 5
```

## Code Examples

### Simplest Example

```python
from src import create_bot_from_env
import asyncio

async def main():
    # Create bot from environment variables
    bot = create_bot_from_env()

    # Get your open orders
    orders = await bot.get_open_orders()
    print(f"You have {len(orders)} open orders")

asyncio.run(main())
```

### Place an Order

```python
from src import TradingBot, Config
import asyncio

async def trade():
    # Create configuration
    config = Config(safe_address="0xYourSafeAddress")

    # Initialize bot with your private key
    bot = TradingBot(config=config, private_key="0xYourPrivateKey")

    # Place a buy order
    result = await bot.place_order(
        token_id="12345...",   # Market token ID
        price=0.65,            # Price (0.65 = 65% probability)
        size=10.0,             # Number of shares
        side="BUY"             # or "SELL"
    )

    if result.success:
        print(f"Order placed! ID: {result.order_id}")
    else:
        print(f"Order failed: {result.message}")

asyncio.run(trade())
```

### Real-time WebSocket Data

```python
from src.websocket_client import MarketWebSocket, OrderbookSnapshot
import asyncio

async def main():
    ws = MarketWebSocket()

    @ws.on_book
    async def on_book_update(snapshot: OrderbookSnapshot):
        print(f"Mid price: {snapshot.mid_price:.4f}")
        print(f"Best bid: {snapshot.best_bid:.4f}")
        print(f"Best ask: {snapshot.best_ask:.4f}")

    await ws.subscribe(["token_id_1", "token_id_2"])
    await ws.run()

asyncio.run(main())
```

### Get 15-Minute Market Info

```python
from src.gamma_client import GammaClient

gamma = GammaClient()

# Get current BTC 15-minute market
market = gamma.get_market_info("BTC")
print(f"Market: {market['question']}")
print(f"Up token: {market['token_ids']['up']}")
print(f"Down token: {market['token_ids']['down']}")
print(f"Ends: {market['end_date']}")
```

### Cancel Orders

```python
# Cancel a specific order
await bot.cancel_order("order_id_here")

# Cancel all orders
await bot.cancel_all_orders()

# Cancel orders for a specific market
await bot.cancel_market_orders(market="condition_id", asset_id="token_id")
```

## Project Structure

```
polymarket-trading-bot/
├── src/                      # Core library
│   ├── bot.py               # TradingBot - main interface
│   ├── config.py            # Configuration handling
│   ├── client.py            # API clients (CLOB, Relayer)
│   ├── signer.py            # Order signing (EIP-712)
│   ├── crypto.py            # Key encryption
│   ├── utils.py             # Helper functions
│   ├── gamma_client.py      # 15-minute market discovery
│   └── websocket_client.py  # Real-time WebSocket client
│
├── strategies/               # Trading strategies
│   ├── flash_crash_strategy.py  # Volatility trading strategy
│   └── orderbook_tui.py     # Real-time orderbook display
│
├── examples/                 # Example code
│   ├── quickstart.py        # Start here!
│   ├── basic_trading.py     # Common operations
│   └── strategy_example.py  # Custom strategies
│
├── scripts/                  # Utility scripts
│   ├── setup.py             # Interactive setup
│   ├── run_bot.py           # Run the bot
│   └── full_test.py         # Integration tests
│
└── tests/                    # Unit tests
```

## Configuration Options

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `POLY_PRIVATE_KEY` | Yes | Your wallet private key |
| `POLY_SAFE_ADDRESS` | Yes | Your Polymarket Safe address |
| `POLY_BUILDER_API_KEY` | For gasless | Builder Program API key |
| `POLY_BUILDER_API_SECRET` | For gasless | Builder Program secret |
| `POLY_BUILDER_API_PASSPHRASE` | For gasless | Builder Program passphrase |

### Config File (Alternative)

Create `config.yaml`:

```yaml
safe_address: "0xYourSafeAddress"

# For gasless trading (optional)
builder:
  api_key: "your_api_key"
  api_secret: "your_api_secret"
  api_passphrase: "your_passphrase"
```

Then load it:

```python
bot = TradingBot(config_path="config.yaml", private_key="0x...")
```

## Gasless Trading

To eliminate gas fees:

1. Apply for [Builder Program](https://polymarket.com/settings?tab=builder)
2. Set the environment variables:

```bash
export POLY_BUILDER_API_KEY=your_key
export POLY_BUILDER_API_SECRET=your_secret
export POLY_BUILDER_API_PASSPHRASE=your_passphrase
```

The bot will automatically use gasless mode when credentials are present.

## API Reference

### TradingBot Methods

| Method | Description |
|--------|-------------|
| `place_order(token_id, price, size, side)` | Place a limit order |
| `cancel_order(order_id)` | Cancel a specific order |
| `cancel_all_orders()` | Cancel all open orders |
| `cancel_market_orders(market, asset_id)` | Cancel orders for a specific market |
| `get_open_orders()` | List your open orders |
| `get_trades(limit=100)` | Get your trade history |
| `get_order_book(token_id)` | Get market order book |
| `get_market_price(token_id)` | Get current market price |
| `is_initialized()` | Check if bot is ready |

### MarketWebSocket Methods

| Method | Description |
|--------|-------------|
| `subscribe(asset_ids, replace=False)` | Subscribe to market data |
| `run(auto_reconnect=True)` | Start WebSocket connection |
| `disconnect()` | Close connection |
| `get_orderbook(asset_id)` | Get cached orderbook |
| `get_mid_price(asset_id)` | Get mid price |

### GammaClient Methods

| Method | Description |
|--------|-------------|
| `get_current_15m_market(coin)` | Get current 15-min market |
| `get_market_info(coin)` | Get market with token IDs |
| `get_all_15m_markets()` | List all 15-min markets |

## Security

Your private key is protected by:

1. **PBKDF2** key derivation (480,000 iterations)
2. **Fernet** symmetric encryption
3. File permissions set to `0600` (owner-only)

Best practices:
- Never commit `.env` files to git
- Use a dedicated wallet for trading
- Keep your encrypted key file private

## Testing

```bash
# Run all tests
pytest tests/ -v

# Run with coverage
pytest tests/ -v --cov=src
```

## Troubleshooting

| Problem | Solution |
|---------|----------|
| `POLY_PRIVATE_KEY not set` | Run `export POLY_PRIVATE_KEY=your_key` |
| `POLY_SAFE_ADDRESS not set` | Get it from polymarket.com/settings |
| `Invalid private key` | Check key is 64 hex characters |
| `Order failed` | Check you have sufficient balance |
| `WebSocket not connecting` | Check network/firewall settings |

## Node.js Streaming Copy Trader (New)

A Node.js event-driven copy engine was added in `scripts/copy_trader_stream.js`.
It uses Polymarket CLOB WebSocket events as the primary trigger (not a polling-only loop), while doing lightweight Data API reconciliation in the background.

### Key behavior
- Percent sizing logic kept: `copy_notional = source_trade_usdc * (my_balance/source_balance)`
- Risk controls: `--max-lag-ms`, `--max-spread`, `--cross-tick`, `--min-price`, `--max-price`
- Low-latency profiles:
  - `--profile fast` (default): low-latency settings with safety checks still on
  - `--profile turbo`: most aggressive path (book HTTP fallback disabled by default, tighter debouncing)
- Precise latency telemetry per copy decision:
  - Timestamps: `eventTs`, `recvTs`, `decisionTs`, `submitTs`, `ackTs`
  - Per-step ms: `ingest`, `decision`, `submit`, `ack`, `total`
- Modes:
  - `--paper` (default): logs simulated copied orders
  - `--live`: routes execution through existing Python bot via `scripts/place_order_once.py`

### Run (paper)
```bash
node scripts/copy_trader_stream.js \
  --source @k9Q2mX4L8A7ZP3R \
  --paper \
  --profile fast \
  --size-mode percent \
  --my-balance-usdc 100 \
  --source-balance-usdc 20000 \
  --max-lag-ms 1200 \
  --max-spread 0.03 \
  --cross-tick 0.01
```

### Benchmark (paper, latency percentiles)
```bash
node scripts/copy_trader_stream.js \
  --source @k9Q2mX4L8A7ZP3R \
  --paper \
  --profile turbo \
  --benchmark-seconds 120 \
  --stats-every 25
```

Sample output (example):
```text
📊 Latency (n=25) count=25 total_ms[p50=42.0 p90=77.0 p99=95.0] decision_ms[p50=9.0 p90=18.0] submit_ms[p50=0.0] ack_ms[p50=0.0]
📊 Latency (n=50) count=50 total_ms[p50=39.0 p90=71.0 p99=93.0] decision_ms[p50=8.0 p90=16.0] submit_ms[p50=0.0] ack_ms[p50=0.0]
📊 Latency (final) count=61 total_ms[p50=40.0 p90=72.0 p99=94.0] decision_ms[p50=8.0 p90=16.0] submit_ms[p50=0.0] ack_ms[p50=0.0]
```

### Run (live via Python bridge)
```bash
node scripts/copy_trader_stream.js \
  --source @k9Q2mX4L8A7ZP3R \
  --live \
  --python-bin python3
```

### Quick smoke checks
```bash
node --check scripts/copy_trader_stream.js
node scripts/copy_trader_stream.js --help
python3 scripts/place_order_once.py --help
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Write tests for new code
4. Run `pytest tests/ -v`
5. Submit a pull request

## License

MIT License - see LICENSE file for details.
