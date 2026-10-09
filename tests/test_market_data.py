import unittest
from market_data import compare_quotes, _quote, SUPPORTED_PAIRS


class MarketDataTests(unittest.TestCase):
    def test_supported_pairs_are_stablecoin_or_brl_scope(self):
        self.assertIn("USDT/USDC", SUPPORTED_PAIRS)
        self.assertIn("USDT/BRL", SUPPORTED_PAIRS)
        self.assertNotIn("AOA/USDT", SUPPORTED_PAIRS)

    def test_compare_uses_ask_to_buy_and_bid_to_sell(self):
        quotes = [
            {"exchange":"A","pair":"USDT/USDC","bid":0.999,"ask":1.000,
             "status":"OK","age_ms":10},
            {"exchange":"B","pair":"USDT/USDC","bid":1.004,"ask":1.005,
             "status":"OK","age_ms":10},
        ]
        rows = compare_quotes(quotes, fee_pct=0.1, slippage_pct=0.05)
        self.assertEqual(len(rows), 2)
        best = rows[0]
        self.assertEqual(best["buy_exchange"], "A")
        self.assertEqual(best["sell_exchange"], "B")
        self.assertAlmostEqual(best["gross_pct"], 0.4, places=3)
        self.assertAlmostEqual(best["net_pct_estimate"], 0.25, places=3)
        self.assertFalse(best["execution_enabled"])

    def test_stale_and_unavailable_quotes_are_ignored(self):
        quotes = [
            {"exchange":"A","pair":"USDT/USDC","bid":0.99,"ask":1.00,
             "status":"OK","age_ms":20000},
            {"exchange":"B","pair":"USDT/USDC","bid":1.02,"ask":1.03,
             "status":"UNAVAILABLE","age_ms":0},
        ]
        self.assertEqual(compare_quotes(quotes), [])

    def test_same_exchange_not_compared_to_itself(self):
        quotes = [
            {"exchange":"A","pair":"USDC/USDT","bid":0.99,"ask":1.00,
             "status":"OK","age_ms":10}
        ]
        self.assertEqual(compare_quotes(quotes), [])

    def test_invalid_market_book_is_rejected(self):
        with self.assertRaises(ValueError):
            _quote("test", "USDT/USDC", 1.01, 1.00, "test")


if __name__ == "__main__":
    unittest.main()
