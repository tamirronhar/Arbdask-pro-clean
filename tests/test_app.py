
import unittest
import app


class ArbDaskTests(unittest.TestCase):
    def test_demo_markets_include_required_assets(self):
        assets = " ".join(
            market["asset"] for market in app.DEMO_MARKETS
        )
        self.assertIn("USDT", assets)
        self.assertIn("USDC", assets)
        self.assertIn("BRL", assets)

    def test_mode_is_simulation_only(self):
        self.assertEqual(app.MODE, "SIMULATION_ONLY")

    def test_opportunities_are_marked_as_demo(self):
        rows = app.opportunities()
        self.assertTrue(rows)
        for row in rows:
            self.assertIn("DEMO", row["data_type"])

    def test_simulation_does_not_execute_trades(self):
        result = app.simulate({
            "capital": 100,
            "min_margin_pct": 0.20
        })
        self.assertIn(
            "nenhuma ordem",
            result["message"].lower()
        )

    def test_invalid_capital_is_rejected(self):
        with self.assertRaises(ValueError):
            app.simulate({"capital": 0})

    def test_invalid_margin_is_rejected(self):
        with self.assertRaises(ValueError):
            app.simulate({
                "capital": 100,
                "min_margin_pct": 101
            })


if __name__ == "__main__":
    unittest.main()
