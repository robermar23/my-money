import { getSession } from "@/lib/auth/session.ts";
import { type SearchResult, globalSearch } from "@/lib/search/global.ts";
import { type NextRequest, NextResponse } from "next/server";

/**
 * Internal command-palette search endpoint (Phase 12, P12-13, ADR-027/028).
 *
 * `GET /api/search?q=…` backs the ⌘K palette client island ([command-palette]).
 * It is **internal, same-origin, read-only, and session-guarded** — not a public
 * API (CLAUDE.md §Domain Scope keeps the public surface at zero; an authenticated
 * handler for our own UI is not a public API). It runs {@link globalSearch}, which
 * touches only local Postgres, and returns capped, trigram-ranked jump targets.
 *
 * **Privacy (CLAUDE.md §Privacy — binding):** there is **no egress** on this path
 * and the query string `q` is **never logged** — a payee/ticker fragment is
 * financial data. Errors log a generic message only, never the term.
 *
 * Auth: unlike a page, a route handler must not `redirect()` to /login for a
 * `fetch` caller — it returns `401` JSON so the island can quietly ignore an
 * expired session rather than render a login page into the palette.
 *
 * Node runtime (postgres.js needs it); never cached (per-request query).
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** The palette's JSON contract: a flat, pre-ordered list of jump targets. */
interface SearchResponse {
  readonly results: readonly SearchResult[];
}

/**
 * Run a cross-entity palette search for the `q` parameter.
 *
 * @param request - The incoming request; reads `?q=` from the URL.
 * @returns `200` with `{ results }` (empty when the term is blank/too short, which
 *   {@link globalSearch} handles), or `401 { error }` when unauthenticated.
 */
export async function GET(
  request: NextRequest,
): Promise<NextResponse<SearchResponse | { error: string }>> {
  const session = await getSession();
  if (!session.userId) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // `q` is sanitized inside globalSearch (sanitizeSearchTerm); a null/short term
  // yields []. Never log `q` — it is financial data.
  const q = request.nextUrl.searchParams.get("q") ?? "";

  try {
    const results = await globalSearch(q);
    return NextResponse.json({ results }, { status: 200 });
  } catch (err) {
    // Log a generic message only — never the query term or row data.
    console.error("[search] palette query failed:", err instanceof Error ? err.message : err);
    return NextResponse.json({ error: "Search failed" }, { status: 500 });
  }
}
