#!/usr/bin/env python3
"""Place a single Polymarket order using existing Python bot/env config."""

import argparse
import asyncio
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src import create_bot_from_env


async def _main() -> int:
    ap = argparse.ArgumentParser(description="Place one order (bridge for Node copy trader live mode)")
    ap.add_argument("--token-id", required=True)
    ap.add_argument("--price", required=True, type=float)
    ap.add_argument("--size", required=True, type=float, help="shares")
    ap.add_argument("--side", required=True, choices=["BUY", "SELL"])
    ap.add_argument("--order-type", default="FOK")
    args = ap.parse_args()

    bot = create_bot_from_env()
    res = await bot.place_order(
        token_id=args.token_id,
        price=args.price,
        size=args.size,
        side=args.side,
        order_type=args.order_type,
    )

    if res.success:
        print(f"OK order_id={res.order_id}")
        return 0

    print(f"FAIL {res.message}")
    return 2


if __name__ == "__main__":
    raise SystemExit(asyncio.run(_main()))
