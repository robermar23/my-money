// @vitest-environment node
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type MailMessage, notifyNewAlerts } from "@/lib/alerts/notify.ts";
import { type PriceTargetInput, priceTargetAlerts } from "@/lib/alerts/rules.ts";
import { describe, expect, it, vi } from "vitest";

/**
 * P11-21 — MANDATORY privacy-regression for the watchlist/price-target paths
 * (ADR-025 / ADR-026, CLAUDE.md §Privacy & Data Sovereignty).
 *
 * Two egress surfaces are introduced this phase; both must leak nothing financial:
 *
 *  1. The price-target → `notifyNewAlerts` email. The doorbell is content-free:
 *     a COUNT + a sign-in link, never the symbol, threshold, price, or pretend
 *     P&L — even though those values DO exist (in the alert's `detail`, rendered
 *     only on the authenticated `/alerts` + `/watchlist` pages). This test pins
 *     the architectural guarantee: the figures live in `detail`, and `detail`
 *     never reaches the wire.
 *
 *  2. The daily/backfill price fetch for a watched symbol. Only the ticker string
 *     egresses to the same public Yahoo/CoinGecko endpoints already used for held
 *     symbols — never a quantity, cost, target, or balance. A static audit over
 *     the series fetchers fails loudly the moment a user-data identifier appears
 *     in a market-data fetch path (mirrors the Plaid + fundamentals egress audits).
 */

/** Build a fired price_target alert — its `detail` deliberately carries figures. */
function firedTargetAlert() {
  const input: PriceTargetInput = {
    targetId: "11111111-1111-1111-1111-111111111111",
    watchlistItemId: "22222222-2222-2222-2222-222222222222",
    symbol: "AAPL",
    direction: "above",
    threshold: "200.00000000",
    latestClose: "205.00000000",
    latestDate: "2026-06-21",
    currency: "USD",
    pretendPnl: {
      costBasis: "1500.00",
      value: "2050.00",
      gainAbsolute: "550.00",
      gainPercent: "36.67",
    },
  };
  const [alert] = priceTargetAlerts([input]);
  if (!alert) throw new Error("expected the target to fire");
  return alert;
}

describe("P11-21 — price-target notification leaks no financial data", () => {
  it("confines symbol/threshold/price/P&L to `detail`, never the title", () => {
    const alert = firedTargetAlert();
    // The figures EXIST (so the test can't pass by accident of them being absent)…
    expect(alert.detail.symbol).toBe("AAPL");
    expect(alert.detail.threshold).toBe("200.00000000");
    expect(alert.detail.price).toBe("205.00000000");
    expect(alert.detail.pretendPnl).toMatchObject({ gainAbsolute: "550.00" });
    // …but the title (the only thing a glance reveals) carries no digits at all.
    expect(alert.title).toBe("AAPL hit your above target");
    expect(alert.title).not.toMatch(/\d/);
  });

  it("sends a content-free email for a fired target — no symbol/price/threshold/P&L", async () => {
    // A target fired this run → the evaluator rings the doorbell with a COUNT only
    // (the alert's figures, asserted above, never reach `notifyNewAlerts`).
    let captured: MailMessage | undefined;
    const send = vi.fn(async (msg: MailMessage) => {
      captured = msg;
    });

    const result = await notifyNewAlerts(1, "2026-06-21", {
      env: {
        SMTP_URL: "smtp://user:pass@mail.example.com:587",
        ALERT_EMAIL_TO: "me@example.com",
        APP_BASE_URL: "https://money.example.com",
      },
      createTransport: () => ({ sendMail: send }),
    });

    expect(result).toEqual({ sent: true });
    expect(send).toHaveBeenCalledTimes(1);
    expect(captured?.text).toMatch(/1 new alert\b/);
    expect(captured?.text).toContain("https://money.example.com/alerts");

    // Privacy regression: NONE of the price-target figures may appear in the wire body.
    const body = `${captured?.subject}\n${captured?.text}`;
    const financialFixtures = ["AAPL", "200", "205", "550.00", "1500.00", "36.67", "$", "target"];
    for (const f of financialFixtures) {
      expect(body, `email body leaked "${f}"`).not.toContain(f);
    }
  });
});

/** Strip block comments so the scan covers executable code, not the JSDoc that
 * legitimately names the very identifiers we forbid. (Line comments are left
 * intact so `https://` URLs survive — none name a forbidden identifier.) */
function code(path: string): string {
  return readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

const FETCH_DIR = join(__dirname, "..", "prices");
const YAHOO_SERIES = code(join(FETCH_DIR, "yahoo-chart.ts"));
const COINGECKO = code(join(FETCH_DIR, "coingecko.ts"));

describe("P11-21 — watched-symbol price fetch egresses only the ticker", () => {
  const forbidden: RegExp[] = [
    /\bpretend/i,
    /\bquantity\b/i,
    /\bunitCost\b/i,
    /\bcostBasis\b/i,
    /\bthreshold\b/i,
    /\bbalance\b/i,
    /\bgainLoss\b/i,
    /\baccountId\b/,
  ];

  it("yahoo-chart series fetcher references no pretend/qty/cost/target identifier", () => {
    const hits = forbidden.filter((p) => p.test(YAHOO_SERIES)).map((p) => p.source);
    expect(hits, `forbidden identifier(s) in yahoo-chart.ts: ${hits.join(", ")}`).toEqual([]);
  });

  it("coingecko series fetcher references no pretend/qty/cost/target identifier", () => {
    const hits = forbidden.filter((p) => p.test(COINGECKO)).map((p) => p.source);
    expect(hits, `forbidden identifier(s) in coingecko.ts: ${hits.join(", ")}`).toEqual([]);
  });

  it("builds each request URL from the symbol/id alone (encoded), not user data", () => {
    expect(YAHOO_SERIES).toMatch(/encodeURIComponent\(yahooSymbol\)/);
    expect(COINGECKO).toMatch(/encodeURIComponent\(id\)/);
  });

  it("market-data fetchers never import the DB or schema (no path to user data)", () => {
    for (const src of [YAHOO_SERIES, COINGECKO]) {
      expect(src).not.toMatch(/@\/db\//);
      expect(src).not.toMatch(/db\/schema/);
    }
  });
});
