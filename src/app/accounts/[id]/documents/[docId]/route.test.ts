// @vitest-environment node
import { db } from "@/db/client.ts";
import { accounts, assetDocuments } from "@/db/schema/index.ts";
import { sql } from "drizzle-orm";
import type { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Download-route security tests (Phase 10, P10-10 / P10-17). This is the only
 * path that serves `asset_documents.bytes`, so its hardening is asserted here:
 * attachment-only + nosniff headers, account-scoped lookup (no cross-account
 * read), and UUID validation. `requireUser` is mocked (cookies); the DB is real.
 */

vi.mock("@/lib/auth/require-user.ts", () => ({
  requireUser: vi.fn(async () => ({
    id: "00000000-0000-0000-0000-000000000001",
    passwordHash: "fake",
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
}));

const { GET } = await import("./route.ts");

/** A NextRequest stand-in — the route never reads it (bytes come from the DB). */
const fakeRequest = {} as NextRequest;

function ctx(id: string, docId: string): { params: Promise<{ id: string; docId: string }> } {
  return { params: Promise.resolve({ id, docId }) };
}

async function seedAssetWithDoc(): Promise<{ accountId: string; docId: string; bytes: Buffer }> {
  await db.execute(sql`TRUNCATE accounts, asset_documents CASCADE`);
  const [account] = await db
    .insert(accounts)
    .values({
      name: "2021 Tacoma",
      institution: "Personal asset",
      type: "personal_asset",
      currency: "USD",
      assetCategory: "vehicle",
    })
    .returning({ id: accounts.id });
  if (!account) throw new Error("seed asset");
  const bytes = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]); // "%PDF-1.7"
  const [doc] = await db
    .insert(assetDocuments)
    .values({
      accountId: account.id,
      filename: "title.pdf",
      mimeType: "application/pdf",
      sizeBytes: bytes.byteLength,
      bytes,
    })
    .returning({ id: assetDocuments.id });
  if (!doc) throw new Error("seed doc");
  return { accountId: account.id, docId: doc.id, bytes };
}

afterEach(() => vi.clearAllMocks());

describe("GET /accounts/[id]/documents/[docId] (P10-10)", () => {
  it("streams the bytes with attachment-only + nosniff headers for the owner", async () => {
    const { accountId, docId, bytes } = await seedAssetWithDoc();

    const res = await GET(fakeRequest, ctx(accountId, docId));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toBe('attachment; filename="title.pdf"');
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("cache-control")).toBe("private, no-store");

    const body = Buffer.from(await res.arrayBuffer());
    expect(body.equals(bytes)).toBe(true);
  });

  it("404s a docId that belongs to another account (no cross-account read)", async () => {
    const { docId } = await seedAssetWithDoc();
    const res = await GET(fakeRequest, ctx(crypto.randomUUID(), docId));
    expect(res.status).toBe(404);
  });

  it("404s a malformed account or document id", async () => {
    const { accountId, docId } = await seedAssetWithDoc();
    expect((await GET(fakeRequest, ctx("not-a-uuid", docId))).status).toBe(404);
    expect((await GET(fakeRequest, ctx(accountId, "not-a-uuid"))).status).toBe(404);
  });

  it("downloads an HTML-bytes payload as an attachment, never inline", async () => {
    // Even if bytes somehow looked like HTML, the route forces a download and
    // nosniff; combined with the upload whitelist this closes the stored-XSS path.
    const { accountId, docId } = await seedAssetWithDoc();
    const res = await GET(fakeRequest, ctx(accountId, docId));
    expect(res.headers.get("content-disposition")?.startsWith("attachment")).toBe(true);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });
});
