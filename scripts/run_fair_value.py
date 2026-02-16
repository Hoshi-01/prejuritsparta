#!/usr/bin/env python3
"""
Run Fair Value Strategy — Ultra Aggressive

USAGE:
    python scripts/run_fair_value.py                    # Default: $10 modal, $1.00/trade
    python scripts/run_fair_value.py --balance 50       # Start with $50
    python scripts/run_fair_value.py --size 1.00        # $1.00 per trade
    python scripts/run_fair_value.py --phase2           # Enable % sizing (3% of balance)

REQUIREMENTS:
    - .env file configured with Polymarket credentials
    - USDC balance in Polymarket wallet
    - pip install -r requirements.txt
"""

import asyncio
import argparse
import sys
import os

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src import create_bot_from_env
from strategies.fair_value import FairValueStrategy, FairValueConfig


def parse_args():
    parser = argparse.ArgumentParser(description="Polymarket Fair Value Strategy — Ultra Aggressive")
    parser.add_argument("--balance", type=float, default=10.0, help="Starting balance in USDC (default: 10)")
    parser.add_argument("--size", type=float, default=1.00, help="Fixed trade size in USDC (default: 1.00)")
    parser.add_argument("--phase2", action="store_true", help="Enable %% sizing instead of fixed")
    parser.add_argument("--pct", type=float, default=3.0, help="Percent of balance per trade if --phase2 (default: 3)")
    parser.add_argument("--threshold", type=float, default=0.02, help="Signal threshold %% (default: 0.02)")
    parser.add_argument("--edge", type=float, default=0.005, help="Min edge vs Polymarket (default: 0.005 = 0.5%%)")
    parser.add_argument("--coins", nargs="+", default=["BTC", "ETH", "SOL", "XRP"], help="Coins to trade")
    parser.add_argument("--max-daily-loss", type=float, default=2.00, help="Max daily loss before stop")
    parser.add_argument("--paper", action="store_true", help="Paper mode (simulate orders, no real trades)")
    return parser.parse_args()


async def main():
    args = parse_args()
    
    print("=" * 60)
    print("🚀 POLYMARKET FAIR VALUE STRATEGY — ULTRA AGGRESSIVE")
    print("=" * 60)
    print(f"  Modal:          ${args.balance:.2f}")
    print(f"  Size:           {'%.1f%% of balance' % args.pct if args.phase2 else '$%.2f fixed' % args.size}")
    print(f"  Threshold:      {args.threshold}%")
    print(f"  Min Edge:       {args.edge * 100:.1f}%")
    print(f"  Coins:          {', '.join(args.coins)}")
    print(f"  Max Daily Loss: ${args.max_daily_loss:.2f}")
    print(f"  Mode:           {'PAPER (simulated)' if args.paper else 'LIVE'}")
    print(f"  Phase:          {'Phase 2 (compound)' if args.phase2 else 'Phase 1 (fixed size)'}")
    print("=" * 60)
    
    # Create bot from .env
    try:
        bot = create_bot_from_env()
        print("✅ Bot initialized successfully")
    except Exception as e:
        print(f"❌ Bot initialization failed: {e}")
        print("\nPastikan .env file sudah diisi dengan credentials Polymarket!")
        print("Lihat .env.example untuk template")
        return
    
    # Create config
    config = FairValueConfig(
        coin=args.coins[0],
        size=args.size,
        size_usd=args.size,
        use_percent_sizing=args.phase2,
        percent_size=args.pct,
        signal_threshold=args.threshold,
        min_edge=args.edge,
        max_daily_loss=args.max_daily_loss,
        paper_mode=args.paper,
        coins=args.coins,
        max_trades_per_window=2,
        take_profit=0.30,
        stop_loss=0.05,
    )
    
    # Create strategy
    strategy = FairValueStrategy(bot, config)
    strategy.balance = args.balance
    
    print(f"✅ Strategy configured: Fair Value Ultra")
    print(f"📊 Starting trading loop...")
    print()
    
    # Start strategy (BaseStrategy.run() handles start/stop lifecycle)
    try:
        await strategy.run()
    
    except KeyboardInterrupt:
        print("\n\n⏹ Manual stop — shutting down...")
    
    except Exception as e:
        print(f"\n❌ Strategy error: {e}")
    
    finally:
        await strategy.stop()
        
        # Print final summary
        total = strategy.wins + strategy.losses
        wr = strategy.win_rate
        pnl = strategy.balance - args.balance
        
        print()
        print("=" * 60)
        print("📋 FINAL SUMMARY")
        print("=" * 60)
        print(f"  Total Trades:   {total}")
        print(f"  Wins/Losses:    {strategy.wins}/{strategy.losses}")
        print(f"  Win Rate:       {wr:.1f}%")
        print(f"  P&L:            ${pnl:+.2f}")
        print(f"  Final Balance:  ${strategy.balance:.2f}")
        print(f"  Skips:          {strategy.skips}")
        print("=" * 60)


if __name__ == "__main__":
    asyncio.run(main())
