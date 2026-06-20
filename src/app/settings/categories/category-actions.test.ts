// @vitest-environment node
import { db } from "@/db/client.ts";
import { categories } from "@/db/schema/index.ts";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* Mocks: requireUser (needs cookies) + next/cache. DB runs for real. */
vi.mock("@/lib/auth/require-user.ts", () => ({
  requireUser: vi.fn(async () => ({
    id: "00000000-0000-0000-0000-000000000001",
    passwordHash: "fake",
    createdAt: new Date(),
    updatedAt: new Date(),
  })),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

const { createCategoryAction } = await import("./category-actions.ts");

function form(fields: Record<string, string>): FormData {
  const fd = new FormData();
  for (const [k, v] of Object.entries(fields)) fd.set(k, v);
  return fd;
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE categories, category_groups CASCADE`);
});
afterEach(() => vi.clearAllMocks());

describe("createCategoryAction (P8-08 inline-create)", () => {
  it("creates a category and returns its id for inline selection", async () => {
    const res = await createCategoryAction({}, form({ name: "Pharmacy", kind: "expense" }));
    expect(res.ok).toBe(true);
    expect(res.createdId).toBeTruthy();

    const [row] = await db
      .select()
      .from(categories)
      .where(eq(categories.id, res.createdId ?? ""));
    expect(row?.name).toBe("Pharmacy");
    expect(row?.kind).toBe("expense");
  });

  it("rejects a case-insensitive duplicate with a friendly message", async () => {
    await createCategoryAction({}, form({ name: "Coffee", kind: "expense" }));
    const dup = await createCategoryAction({}, form({ name: "coffee", kind: "expense" }));
    expect(dup.error).toMatch(/already exists/i);
    expect(await db.select().from(categories)).toHaveLength(1);
  });

  it("rejects a blank name", async () => {
    const res = await createCategoryAction({}, form({ name: "  ", kind: "expense" }));
    expect(res.error).toBeTruthy();
    expect(await db.select().from(categories)).toHaveLength(0);
  });
});
