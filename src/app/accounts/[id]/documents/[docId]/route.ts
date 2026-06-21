import { db } from "@/db/client.ts";
import { assetDocuments } from "@/db/schema/index.ts";
import { requireUser } from "@/lib/auth/require-user.ts";
import { and, eq } from "drizzle-orm";
import type { NextRequest } from "next/server";

/**
 * Secure download route for a personal asset's proof-of-authenticity document
 * (Phase 10, P10-10, ADR-024).
 *
 * This is the ONLY path that serves `asset_documents.bytes`. Hardening:
 *   - `requireUser` — authenticated (single user); unauth redirects to /login.
 *   - The document is loaded **scoped to the account** in the URL, so a docId
 *     belonging to another account 404s (no cross-account read).
 *   - `Content-Disposition: attachment` + `X-Content-Type-Options: nosniff` —
 *     the browser downloads, never renders. Combined with the upload whitelist
 *     (no SVG/HTML) this neutralizes stored-XSS via a crafted upload.
 *   - `Cache-Control: private, no-store` — never cached by a shared proxy/CDN.
 *
 * Never serve inline. Never put these bytes behind a CDN.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface RouteContext {
  params: Promise<{ id: string; docId: string }>;
}

/**
 * Stream a single proof document's bytes as an attachment.
 *
 * @param _request - The incoming request (unused; bytes come from the DB).
 * @param context - Route params: the account `id` and the `docId`.
 * @returns The file bytes with attachment + nosniff headers, or 404.
 */
export async function GET(_request: NextRequest, context: RouteContext): Promise<Response> {
  await requireUser();

  const { id, docId } = await context.params;
  if (!UUID_RE.test(id) || !UUID_RE.test(docId)) {
    return new Response("Not found", { status: 404 });
  }

  const [doc] = await db
    .select()
    .from(assetDocuments)
    .where(and(eq(assetDocuments.id, docId), eq(assetDocuments.accountId, id)))
    .limit(1);
  if (!doc) {
    return new Response("Not found", { status: 404 });
  }

  // Strip any double-quotes from the (already path-sanitized) filename so it
  // cannot break out of the quoted Content-Disposition value.
  const safeName = doc.filename.replace(/"/g, "");
  const body = new Uint8Array(doc.bytes);

  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": doc.mimeType,
      "Content-Disposition": `attachment; filename="${safeName}"`,
      "Content-Length": String(doc.sizeBytes),
      "X-Content-Type-Options": "nosniff",
      "Cache-Control": "private, no-store",
    },
  });
}
