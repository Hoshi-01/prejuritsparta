#!/usr/bin/env python3
"""
Copy trader for Polymarket.

- Follows a target profile/address activity from Data API
- Mirrors BUY/SELL trades with hard max USDC per order
- Supports paper mode (simulation) and live mode

Examples:
  python scripts/run_copy_trader.py --source @k9Q2mX4L8A7ZP3R --paper
  python scripts/run_copy_trader.py --source 0xabc... --max-order-usdc 1.0
"""

import argparse
import asyncio
import time
import sys
import os
from typing import Dict, Any, List, Set

import requests

# Add project root to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src import create_bot_from_env

GAMMA_BASE = "https://gamma-api.polymarket.com"
DATA_BASE = "https://data-api.polymarket.com"


def resolve_source_to_wallet(source: str) -> str:
    """Resolve @handle/pseudonym or direct address to proxy wallet address."""
    s = source.strip()
    if s.startswith("0x") and len(s) == 42:
        return s

    handle = s[1:] if s.startswith("@") else s
    url = f"{GAMMA_BASE}/public-search"
    params = {
        "q": handle,
        "search_profiles": "true",
        "limit_per_type": 20,
    }
    resp = requests.get(url, params=params, timeout=15)
    resp.raise_for_status()
    data = resp.json() if resp.content else {}
    profiles = data.get("profiles") or []

    # try exact pseudonym first
    for p in profiles:
        pseudo = (p.get("pseudonym") or "").lower()
        if pseudo == handle.lower() and p.get("proxyWallet"):
            return p["proxyWallet"]

    # fallback first profile with proxy wallet
    for p in profiles:
        if p.get("proxyWallet"):
            return p["proxyWallet"]

    raise ValueError(f"Could not resolve source profile/address: {source}")


def fetch_activity(user_wallet: str, limit: int = 100) -> List[Dict[str, Any]]:
    params = {
        "user": user_wallet,
        "type": "TRADE",
        "limit": limit,
        "offset": 0,
        "sortBy": "TIMESTAMP",
        "sortDirection": "DESC",
    }
    resp = requests.get(f"{DATA_BASE}/activity", params=params, timeout=15)
    resp.raise_for_status()
    items = resp.json() if resp.content else []
    return items if isinstance(items, list) else []


def item_key(it: Dict[str, Any]) -> str:
    return "|".join(
        [
            str(it.get("transactionHash", "")),
            str(it.get("asset", "")),
            str(it.get("side", "")),
            str(it.get("timestamp", "")),
            str(it.get("price", "")),
            str(it.get("size", "")),
        ]
    )


async def main() -> None:
    ap = argparse.ArgumentParser(description="Polymarket copy trader")
    ap.add_argument("--source", required=True, help="@pseudonym or 0x wallet to follow")
    ap.add_argument("--paper", action="store_true", help="simulate only, no live orders")
    ap.add_argument("--poll-seconds", type=float, default=8.0, help="poll interval")
    ap.add_argument("--max-order-usdc", type=float, default=1.0, help="hard cap USDC per copied order")
    ap.add_argument("--min-price", type=float, default=0.01, help="minimum valid price")
    ap.add_argument("--max-price", type=float, default=0.99, help="maximum valid price")
    ap.add_argument("--bootstrap-seconds", type=int, default=120, help="ignore historical trades older than this at startup")
    args = ap.parse_args()

    if args.max_order_usdc <= 0:
        raise ValueError("--max-order-usdc must be > 0")

    source_wallet = resolve_source_to_wallet(args.source)
    print(f"🎯 Source resolved: {args.source} -> {source_wallet}")
    print(f"⚙️ Mode: {'PAPER' if args.paper else 'LIVE'} | Max order: ${args.max_order_usdc:.2f}")

    bot = None if args.paper else create_bot_from_env()

    seen: Set[str] = set()
    start_ms = int(time.time() * 1000)

    while True:
        try:
            items = fetch_activity(source_wallet, limit=100)
            # oldest first so we replay in order
            items = list(reversed(items))

            for it in items:
                k = item_key(it)
                if k in seen:
                    continue
                seen.add(k)

                ts = int(it.get("timestamp") or 0)
                if ts and ts < (start_ms - args.bootstrap_seconds * 1000):
                    continue

                side = str(it.get("side") or "").upper()
                token_id = str(it.get("asset") or "")
                price = float(it.get("price") or 0)

                if side not in {"BUY", "SELL"}:
                    continue
                if not token_id:
                    continue
                if not (args.min_price <= price <= args.max_price):
                    continue

                # hard cap notional
                shares = args.max_order_usdc / price

                if args.paper:
                    print(f"[PAPER COPY] {side} token={token_id[:14]}.. price={price:.4f} shares={shares:.4f} cost=${shares*price:.2f}")
                    continue

                res = await bot.place_order(
                    token_id=token_id,
                    price=price,
                    size=shares,
                    side=side,
                    order_type="FOK",
                )
                if res.success:
                    print(f"[LIVE COPY OK] {side} token={token_id[:14]}.. price={price:.4f} shares={shares:.4f} order={res.order_id}")
                else:
                    print(f"[LIVE COPY FAIL] {side} token={token_id[:14]}.. err={res.message}")

        except Exception as e:
            print(f"[WARN] loop error: {e}")

        await asyncio.sleep(args.poll_seconds)


if __name__ == "__main__":
    asyncio.run(main())
