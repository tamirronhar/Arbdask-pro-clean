"""Public read-only market data for ArbDask PRO.

Uses only Python's standard library. No API keys, account access, order placement,
withdrawals, or transfers. Quotes are best-effort snapshots, not executable prices.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from typing import Optional

TIMEOUT_SECONDS = 4.0
MAX_QUOTE_AGE_SECONDS = 15.0
USER_AGENT = "ArbDask-PRO/0.1 market-data-readonly"
# The product scope is stablecoin / fiat pairs only; extend explicitly as needed.
SUPPORTED_PAIRS = ("USDT/USDC", "USDC/USDT", "USDT/BRL", "USDC/BRL", "BRL/USDT", "BRL/USDC")


@dataclass
class Quote:
    exchange: str
    pair: str
    bid: float
    ask: float
    timestamp: str
    timestamp_ms: int
    age_ms: int
    source: str
    status: str = "OK"
    error: Optional[str] = None

    def to_dict(self):
        return asdict(self)


def _get_json(url: str) -> dict:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json", "User-Agent": USER_AGENT},
        method="GET",
    )
    with urllib.request.urlopen(request, timeout=TIMEOUT_SECONDS) as response:
        if response.status != 200:
            raise RuntimeError(f"HTTP {response.status}")
        data = response.read(1_000_000)
    return json.loads(data.decode("utf-8"))


def _float_positive(value, label: str) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{label} inválido")
    if number <= 0:
        raise ValueError(f"{label} deve ser maior que zero")
    return number


def _pair_symbols(pair: str):
    if pair not in SUPPORTED_PAIRS:
        raise ValueError("Par não suportado")
    base, quote = pair.split("/")
    return base, quote


def _now_ms() -> int:
    return int(time.time() * 1000)


def _quote(exchange: str, pair: str, bid, ask, source: str, timestamp_ms=None) -> Quote:
    bid = _float_positive(bid, "bid")
    ask = _float_positive(ask, "ask")
    if bid > ask:
        raise ValueError("Livro inválido: bid superior a ask")
    now = _now_ms()
    stamp = int(timestamp_ms or now)
    age = max(0, now - stamp)
    return Quote(
        exchange=exchange,
        pair=pair,
        bid=bid,
        ask=ask,
        timestamp=datetime.fromtimestamp(stamp / 1000, timezone.utc).isoformat(),
        timestamp_ms=stamp,
        age_ms=age,
        source=source,
        status="STALE" if age > MAX_QUOTE_AGE_SECONDS * 1000 else "OK",
    )


def _binance(pair: str) -> Quote:
    base, quote = _pair_symbols(pair)
    symbol = base + quote
    url = "https://api.binance.com/api/v3/ticker/bookTicker?" + urllib.parse.urlencode({"symbol": symbol})
    data = _get_json(url)
    return _quote("Binance", pair, data["bidPrice"], data["askPrice"], url)


def _bitget(pair: str) -> Quote:
    base, quote = _pair_symbols(pair)
    symbol = base + quote
    url = "https://api.bitget.com/api/v2/spot/market/tickers?" + urllib.parse.urlencode({"symbol": symbol})
    data = _get_json(url)
    if data.get("code") != "00000":
        raise RuntimeError("Bitget recusou a consulta")
    rows = data.get("data") or []
    if not rows:
        raise LookupError("Par não encontrado na Bitget")
    row = rows[0]
    return _quote("Bitget", pair, row.get("bidPr"), row.get("askPr"), url, row.get("ts"))


def _bybit(pair: str) -> Quote:
    base, quote = _pair_symbols(pair)
    symbol = base + quote
    url = "https://api.bybit.com/v5/market/tickers?" + urllib.parse.urlencode({"category": "spot", "symbol": symbol})
    data = _get_json(url)
    if data.get("retCode") != 0:
        raise RuntimeError("Bybit recusou a consulta")
    rows = (data.get("result") or {}).get("list") or []
    if not rows:
        raise LookupError("Par não encontrado na Bybit")
    row = rows[0]
    return _quote("Bybit", pair, row.get("bid1Price"), row.get("ask1Price"), url, row.get("ts"))


def _okx(pair: str) -> Quote:
    base, quote = _pair_symbols(pair)
    inst_id = f"{base}-{quote}"
    url = "https://www.okx.com/api/v5/market/ticker?" + urllib.parse.urlencode({"instId": inst_id})
    data = _get_json(url)
    if data.get("code") != "0":
        raise RuntimeError("OKX recusou a consulta")
    rows = data.get("data") or []
    if not rows:
        raise LookupError("Par não encontrado na OKX")
    row = rows[0]
    return _quote("OKX", pair, row.get("bidPx"), row.get("askPx"), url, row.get("ts"))


FETCHERS = {"Binance": _binance, "Bitget": _bitget, "Bybit": _bybit, "OKX": _okx}


def fetch_quote(exchange: str, pair: str) -> Quote:
    """Fetch one public top-of-book quote. Errors are surfaced to the caller."""
    if exchange not in FETCHERS:
        raise ValueError("Corretora não suportada")
    return FETCHERS[exchange](pair)


def collect_quotes(pairs=SUPPORTED_PAIRS, exchanges=None):
    """Collect quotes independently so one exchange failure doesn't hide the others."""
    exchanges = tuple(exchanges or FETCHERS.keys())
    results = []
    for pair in pairs:
        if pair not in SUPPORTED_PAIRS:
            continue
        for exchange in exchanges:
            started = time.monotonic()
            try:
                quote = fetch_quote(exchange, pair)
                row = quote.to_dict()
                row["request_ms"] = round((time.monotonic() - started) * 1000, 2)
                results.append(row)
            except (OSError, urllib.error.URLError, TimeoutError, ValueError,
                    KeyError, TypeError, LookupError, RuntimeError, json.JSONDecodeError) as exc:
                results.append({
                    "exchange": exchange, "pair": pair, "bid": None, "ask": None,
                    "timestamp": None, "timestamp_ms": None, "age_ms": None,
                    "source": None, "status": "UNAVAILABLE",
                    "error": str(exc)[:180],
                    "request_ms": round((time.monotonic() - started) * 1000, 2),
                })
    return results


def compare_quotes(quotes, fee_pct=0.10, slippage_pct=0.05, max_age_ms=None):
    """Compare same-pair quotes. Buy at ask, sell at bid; subtract estimated costs.

    This is a screening estimate only: it does not validate depth, transfer times,
    withdrawal fees, network availability, or whether a trade could be filled.
    """
    max_age_ms = MAX_QUOTE_AGE_SECONDS * 1000 if max_age_ms is None else int(max_age_ms)
    grouped = {}
    for q in quotes:
        if q.get("status") != "OK" or q.get("bid") is None or q.get("ask") is None:
            continue
        if q.get("age_ms") is None or q["age_ms"] > max_age_ms:
            continue
        if q["pair"] not in SUPPORTED_PAIRS:
            continue
        grouped.setdefault(q["pair"], []).append(q)

    results = []
    for pair, rows in grouped.items():
        for buy in rows:
            for sell in rows:
                if buy["exchange"] == sell["exchange"]:
                    continue
                gross_pct = ((float(sell["bid"]) - float(buy["ask"])) / float(buy["ask"])) * 100
                net_pct = gross_pct - float(fee_pct) - float(slippage_pct)
                results.append({
                    "pair": pair,
                    "buy_exchange": buy["exchange"],
                    "sell_exchange": sell["exchange"],
                    "buy_price": buy["ask"],
                    "sell_price": sell["bid"],
                    "gross_pct": round(gross_pct, 6),
                    "fee_pct_estimate": float(fee_pct),
                    "slippage_pct_estimate": float(slippage_pct),
                    "net_pct_estimate": round(net_pct, 6),
                    "data_type": "PUBLIC LIVE SNAPSHOT — indicative only",
                    "execution_enabled": False,
                    "warning": "Sem validação de profundidade, custos de transferência ou execução.",
                })
    return sorted(results, key=lambda row: row["net_pct_estimate"], reverse=True)
