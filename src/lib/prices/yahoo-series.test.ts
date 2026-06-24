import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchYahooDailySeries } from "./yahoo-chart.ts";

/**
 * Unit tests for the Yahoo daily-series fetcher (P11-06). The watchlist backfill
 * depends on a sorted, null-free `{date, close}[]`; a 429 must retry.
 */
function chartResponse(body: unknown, init: { ok?: boolean; status?: number } = {}) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    json: async () => body,
  } as Response;
}

/** Build a chart payload from parallel timestamp (UTC midnight) + close arrays. */
function seriesBody(rows: { date: string; close: number | null }[]) {
  return {
    chart: {
      error: null,
      result: [
        {
          timestamp: rows.map((r) => Math.floor(Date.parse(`${r.date}T00:00:00Z`) / 1000)),
          indicators: { quote: [{ close: rows.map((r) => r.close) }] },
        },
      ],
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe("fetchYahooDailySeries", () => {
  it("maps timestamp+close pairs to a sorted, null-free {date, close}[]", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      chartResponse(
        seriesBody([
          { date: "2026-01-03", close: 102.5 },
          { date: "2026-01-01", close: 100 },
          { date: "2026-01-02", close: null }, // skipped
        ]),
      ),
    );

    const series = await fetchYahooDailySeries("AAPL", "2026-01-01");
    expect(series).toEqual([
      { date: "2026-01-01", close: "100.00000000" },
      { date: "2026-01-03", close: "102.50000000" },
    ]);
  });

  it("passes period1 covering the from-date to the chart endpoint", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(chartResponse(seriesBody([{ date: "2026-01-01", close: 100 }])));
    await fetchYahooDailySeries("GC=F", "2025-06-01");
    const url = String(fetchMock.mock.calls[0]?.[0]);
    expect(url).toContain("/v8/finance/chart/GC%3DF");
    expect(url).toContain(`period1=${Math.floor(Date.parse("2025-06-01T00:00:00Z") / 1000)}`);
  });

  it("returns an empty array when the window holds no trading days", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(chartResponse(seriesBody([])));
    expect(await fetchYahooDailySeries("AAPL", "2026-01-01")).toEqual([]);
  });

  it("retries on a 429 then succeeds", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(chartResponse("Too Many Requests", { ok: false, status: 429 }))
      .mockResolvedValueOnce(chartResponse(seriesBody([{ date: "2026-01-01", close: 100 }])));

    const series = await fetchYahooDailySeries("AAPL", "2026-01-01");
    expect(series).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
