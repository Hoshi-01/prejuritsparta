"""
Fair Value Strategy — Ultra Aggressive Mode

Trades Polymarket 15-minute Up/Down markets using real-time crypto price
data from Binance to calculate fair value and exploit mispricing.

Mode: ULTRA AGGRESSIVE
- Threshold: 0.02% (trades on smallest price moves)
- Min edge: 0.5% (requires minimal mispricing)
- Coins: BTC, ETH, SOL, XRP (all coins)
- Max trades: ~150+/day
- Size: FIXED $0.50 per trade (Phase 1)

Usage:
    python scripts/run_fair_value.py
"""

import time
import requests
from dataclasses import dataclass, field
from typing import Dict, Optional
from datetime import datetime, timezone

from strategies.base import BaseStrategy, StrategyConfig
from src.bot import TradingBot
from src.websocket_client import OrderbookSnapshot


# ============================================================
# CONFIG
# ============================================================

@dataclass
class FairValueConfig(StrategyConfig):
    """Fair Value Ultra Aggressive configuration."""
    
    # === SIZING ===
    size_usd: float = 0.50           # FIXED $0.50 per trade (Phase 1)
    use_percent_sizing: bool = False  # True = use % of balance (Phase 2)
    percent_size: float = 3.0        # 3% of balance (Phase 2 only)
    
    # === SIGNAL THRESHOLDS ===
    signal_threshold: float = 0.02   # Min price change % for signal (ULTRA: 0.02%)
    min_edge: float = 0.005          # Min edge vs polymarket (ULTRA: 0.5%)
    binance_lookback: int = 5        # Candle count (1-min candles)
    
    # === RISK MANAGEMENT ===
    max_daily_loss: float = 2.00     # Stop trading hari ini jika loss >= $2
    max_consecutive_loss: int = 5    # Cooldown setelah 5 loss berturut
    cooldown_seconds: int = 1800     # 30 min cooldown (bukan 1 jam - ultra)
    min_balance: float = 8.00        # STOP TOTAL jika balance < $8
    max_spread: float = 0.20        # Skip jika spread > 20¢ (ultra: lebih toleran)
    
    # === MULTI-COIN ===
    coins: list = field(default_factory=lambda: ["BTC", "ETH", "SOL", "XRP"])
    max_trades_per_window: int = 2   # Trade 2 coins per 15-min window
    
    # === TIMING ===
    check_interval: float = 30.0     # Cek signal setiap 30 detik
    window_seconds: int = 900        # 15 menit = 900 detik


# ============================================================
# BINANCE PRICE FEED
# ============================================================

BINANCE_SYMBOLS = {
    "BTC": "BTCUSDT",
    "ETH": "ETHUSDT",
    "SOL": "SOLUSDT",
    "XRP": "XRPUSDT",
}


def get_binance_change(coin: str, lookback: int = 5) -> Optional[float]:
    """
    Get price change % for a coin over the last N minutes from Binance.
    
    Args:
        coin: Coin symbol (BTC, ETH, SOL, XRP)
        lookback: Number of 1-min candles to look back
    
    Returns:
        Percentage change (e.g., 0.15 = +0.15%), or None on error
    """
    symbol = BINANCE_SYMBOLS.get(coin)
    if not symbol:
        return None
    
    url = "https://api.binance.com/api/v3/klines"
    params = {"symbol": symbol, "interval": "1m", "limit": lookback}
    
    try:
        resp = requests.get(url, params=params, timeout=10)
        resp.raise_for_status()
        candles = resp.json()
        
        if len(candles) < 2:
            return None
        
        first_close = float(candles[0][4])
        last_close = float(candles[-1][4])
        
        if first_close == 0:
            return None
        
        change_pct = ((last_close - first_close) / first_close) * 100
        return round(change_pct, 4)
    
    except Exception as e:
        print(f"[BINANCE ERROR] {coin}: {e}")
        return None


# ============================================================
# FAIR VALUE CALCULATOR
# ============================================================

def calculate_fair_value_up(change_pct: float) -> Optional[float]:
    """
    Calculate fair value for UP side based on Binance price change.
    
    ULTRA mode: fine-grained mapping for small moves.
    
    Args:
        change_pct: Price change percentage from Binance
    
    Returns:
        Fair value UP (0.0-1.0), or None if sideways/skip
    """
    if change_pct is None:
        return None
    
    # Ultra aggressive: fine-grained tiers
    if change_pct > 0.30:
        return 0.75
    elif change_pct > 0.20:
        return 0.70
    elif change_pct > 0.15:
        return 0.65
    elif change_pct > 0.10:
        return 0.60
    elif change_pct > 0.05:
        return 0.57
    elif change_pct > 0.02:
        return 0.54  # Threshold 0.02% — smallest tradeable signal
    elif change_pct >= -0.02:
        return None   # Dead zone → SKIP
    elif change_pct > -0.05:
        return 0.46   # Mirror: fair_down = 0.54
    elif change_pct > -0.10:
        return 0.43
    elif change_pct > -0.15:
        return 0.40
    elif change_pct > -0.20:
        return 0.35
    elif change_pct > -0.30:
        return 0.30
    else:
        return 0.25


# ============================================================
# STRATEGY CLASS
# ============================================================

class FairValueStrategy(BaseStrategy):
    """
    Fair Value Trading Strategy — Ultra Aggressive
    
    Monitors Binance real-time prices and trades Polymarket 15-minute
    Up/Down markets when fair value diverges from market price.
    """
    
    def __init__(self, bot: TradingBot, config: FairValueConfig):
        # Set coin to first in list for BaseStrategy
        config.coin = config.coins[0] if config.coins else "BTC"
        super().__init__(bot, config)
        
        self.fv_config = config
        self.balance = 10.00  # Starting balance (update from actual)
        
        # Tracking
        self.total_trades = 0
        self.wins = 0
        self.losses = 0
        self.skips = 0
        self.daily_loss = 0.0
        self.consecutive_losses = 0
        self.daily_trades = []
        self.trades_this_window = 0
        self.last_daily_reset = datetime.now(timezone.utc).date()
        
        # Error tracking
        self.consecutive_errors = 0
        self.max_consecutive_errors = 3
    
    # ========================================
    # RISK CHECKS
    # ========================================
    
    def check_risk(self) -> tuple:
        """
        Check all risk rules.
        Returns: (can_trade: bool, reason: str)
        """
        # Daily reset
        today = datetime.now(timezone.utc).date()
        if today != self.last_daily_reset:
            self.daily_loss = 0.0
            self.daily_trades = []
            self.last_daily_reset = today
            self.log("📅 Daily reset — counters cleared", "info")
        
        # Balance check
        if self.balance < self.fv_config.min_balance:
            return False, f"STOP: Balance ${self.balance:.2f} < ${self.fv_config.min_balance}"
        
        # Daily loss
        if self.daily_loss >= self.fv_config.max_daily_loss:
            return False, f"PAUSE: Daily loss ${self.daily_loss:.2f} >= ${self.fv_config.max_daily_loss}"
        
        # Consecutive losses
        if self.consecutive_losses >= self.fv_config.max_consecutive_loss:
            return False, f"COOLDOWN: {self.consecutive_losses} consecutive losses"
        
        # Error rate
        if self.consecutive_errors >= self.max_consecutive_errors:
            return False, f"ERROR HALT: {self.consecutive_errors} consecutive API errors"
        
        return True, "OK"
    
    # ========================================
    # MAIN TICK LOGIC
    # ========================================
    
    async def on_tick(self, prices: Dict[str, float]):
        """
        Called every tick — main strategy logic.
        Scans all coins for fair value edge.
        """
        # Risk check
        can_trade, reason = self.check_risk()
        if not can_trade:
            self.log(f"[RISK] {reason}", "warning")
            if "STOP" in reason:
                await self.stop()
            return
        
        # Reset trades per window counter
        self.trades_this_window = 0
        
        # Scan all coins
        for coin in self.fv_config.coins:
            if self.trades_this_window >= self.fv_config.max_trades_per_window:
                break
            
            await self._evaluate_coin(coin, prices)
    
    async def _evaluate_coin(self, coin: str, market_prices: Dict[str, float]):
        """Evaluate a single coin for fair value edge."""
        
        # 1. Get Binance price change
        change = get_binance_change(coin, self.fv_config.binance_lookback)
        
        if change is None:
            self.consecutive_errors += 1
            self.log(f"[ERROR] Binance data unavailable for {coin}", "error")
            return
        
        self.consecutive_errors = 0  # Reset on success
        
        # 2. Calculate fair value
        fair_up = calculate_fair_value_up(change)
        
        if fair_up is None:
            self.skips += 1
            self.log(f"[SKIP] {coin} | {change:+.4f}% | Dead zone (sideways)", "info")
            return
        
        fair_down = 1.0 - fair_up
        
        # 3. Get Polymarket prices
        # Use market_prices from BaseStrategy if available for current coin
        # Otherwise try to get from GammaClient
        poly_up = market_prices.get("up", 0.50)
        poly_down = market_prices.get("down", 0.50)
        
        # If we're evaluating a different coin than current market,
        # we need to get its prices separately
        if coin != self.config.coin:
            try:
                from src.gamma_client import GammaClient
                gamma = GammaClient()
                info = gamma.get_market_info(coin)
                if info is None:
                    self.log(f"[SKIP] {coin} | No active market", "info")
                    return
                poly_up = info['prices']['up']
                poly_down = info['prices']['down']
            except Exception as e:
                self.log(f"[ERROR] {coin} market info: {e}", "error")
                return
        
        # 4. Check spread
        spread = abs(1.0 - poly_up - poly_down)
        if spread > self.fv_config.max_spread:
            self.log(f"[SKIP] {coin} | Spread {spread:.2f} > {self.fv_config.max_spread}", "info")
            return
        
        # 5. Find edge
        edge_up = fair_up - poly_up
        edge_down = fair_down - poly_down
        
        side = None
        entry_price = None
        edge = 0
        
        if edge_up >= self.fv_config.min_edge:
            side = "up"
            entry_price = poly_up
            edge = edge_up
        elif edge_down >= self.fv_config.min_edge:
            side = "down"
            entry_price = poly_down
            edge = edge_down
        
        if side is None:
            self.skips += 1
            self.log(
                f"[SKIP] {coin} | FairUP:{fair_up:.0%} vs Poly:{poly_up:.0%} | "
                f"EdgeUP:{edge_up:+.1%} EdgeDN:{edge_down:+.1%} | "
                f"Binance:{change:+.4f}%",
                "info"
            )
            return
        
        # 6. Calculate position size
        size_usd = self.fv_config.size_usd
        
        if self.fv_config.use_percent_sizing:
            size_usd = self.balance * (self.fv_config.percent_size / 100)
        
        shares = size_usd / entry_price
        
        # 7. Execute trade
        self.total_trades += 1
        self.trades_this_window += 1
        
        self.log(
            f"[TRADE #{self.total_trades}] {coin} | BUY {side.upper()} | "
            f"Price: {entry_price:.0%} | Shares: {shares:.2f} | "
            f"Cost: ${size_usd:.2f} | Edge: {edge:+.1%} | "
            f"Fair: {fair_up:.0%} | Binance: {change:+.4f}%",
            "trade"
        )
        
        await self.execute_buy(side, entry_price)
        
        # Record trade
        self.daily_trades.append({
            "num": self.total_trades,
            "coin": coin,
            "side": side,
            "price": entry_price,
            "shares": shares,
            "cost": size_usd,
            "edge": edge,
            "change": change,
            "fair_up": fair_up,
            "time": datetime.now(timezone.utc).isoformat(),
        })
    
    # ========================================
    # RESULT TRACKING
    # ========================================
    
    def record_win(self, pnl: float):
        """Record a winning trade."""
        self.wins += 1
        self.balance += pnl
        self.consecutive_losses = 0
        self.log(
            f"[WIN ✅] +${pnl:.2f} | Balance: ${self.balance:.2f} | "
            f"WR: {self.win_rate:.1f}% ({self.wins}/{self.total_trades})",
            "success"
        )
    
    def record_loss(self, loss: float):
        """Record a losing trade."""
        self.losses += 1
        self.balance -= abs(loss)
        self.daily_loss += abs(loss)
        self.consecutive_losses += 1
        self.log(
            f"[LOSE ❌] -${abs(loss):.2f} | Balance: ${self.balance:.2f} | "
            f"WR: {self.win_rate:.1f}% ({self.wins}/{self.total_trades}) | "
            f"Consec: {self.consecutive_losses}",
            "warning"
        )
    
    @property
    def win_rate(self) -> float:
        """Current win rate percentage."""
        total = self.wins + self.losses
        if total == 0:
            return 0.0
        return (self.wins / total) * 100
    
    # ========================================
    # MARKET EVENTS
    # ========================================
    
    def on_market_change(self, old_slug: str, new_slug: str):
        """Called when 15-min market changes — print summary."""
        self.trades_this_window = 0
        
        total = self.wins + self.losses
        wr = self.win_rate
        pnl = self.balance - 10.0  # assuming $10 start
        
        self.log(
            f"[WINDOW] {old_slug} → {new_slug}\n"
            f"  Trades: {total} | W/L: {self.wins}/{self.losses} | "
            f"WR: {wr:.1f}% | P&L: ${pnl:+.2f} | "
            f"Balance: ${self.balance:.2f} | Skips: {self.skips}",
            "info"
        )
    
    async def on_book_update(self, snapshot: OrderbookSnapshot):
        """Handle orderbook update."""
        pass  # Price tracking handled by BaseStrategy
    
    def render_status(self, prices: Dict[str, float]):
        """Render TUI status display."""
        total = self.wins + self.losses
        wr = self.win_rate
        pnl = self.balance - 10.0
        
        print(f"\r  💰 ${self.balance:.2f} | "
              f"📊 {total} trades | "
              f"✅ {self.wins}W/{self.losses}L | "
              f"🎯 {wr:.0f}% WR | "
              f"{'📈' if pnl >= 0 else '📉'} ${pnl:+.2f} | "
              f"⏭ {self.skips} skips",
              end="", flush=True)
    
    # ========================================
    # HOURLY & DAILY REPORTS
    # ========================================
    
    def hourly_report(self):
        """Print hourly summary."""
        total = self.wins + self.losses
        wr = self.win_rate
        pnl = self.balance - 10.0
        
        self.log(
            f"\n{'='*60}\n"
            f"[HOURLY REPORT] {datetime.now(timezone.utc).strftime('%H:%M UTC')}\n"
            f"  Trades: {total} | W/L: {self.wins}/{self.losses}\n"
            f"  Win Rate: {wr:.1f}%\n"
            f"  P&L: ${pnl:+.2f}\n"
            f"  Balance: ${self.balance:.2f}\n"
            f"  Daily Loss: ${self.daily_loss:.2f} / ${self.fv_config.max_daily_loss:.2f}\n"
            f"  Skips: {self.skips}\n"
            f"{'='*60}",
            "info"
        )
    
    def daily_report(self):
        """Print daily summary."""
        total = self.wins + self.losses
        wr = self.win_rate
        pnl = self.balance - 10.0
        
        self.log(
            f"\n{'🏆'*20}\n"
            f"[DAILY REPORT] {datetime.now(timezone.utc).strftime('%Y-%m-%d')}\n"
            f"  Total Trades: {total}\n"
            f"  Wins: {self.wins} | Losses: {self.losses}\n"
            f"  Win Rate: {wr:.1f}%\n"
            f"  Total P&L: ${pnl:+.2f}\n"
            f"  Balance: ${self.balance:.2f}\n"
            f"  Daily Trades: {len(self.daily_trades)}\n"
            f"  Daily Loss: ${self.daily_loss:.2f}\n"
            f"{'🏆'*20}",
            "info"
        )
