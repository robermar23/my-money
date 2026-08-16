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

const { bulkClassifyAction, createCategoryAction, setCategoryClassificationAction } = await import(
  "./category-actions.ts"
);

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

/**
 * P15-31 — necessity classification. The share of spend left unclassified is
 * what every baseline's honesty rests on, so both the single-row control and the
 * bulk pass have to be able to SET a classification and to take one back.
 */
async function makeCategory(name: string, kind: string): Promise<string> {
  const [row] = await db.insert(categories).values({ name, kind }).returning({ id: categories.id });
  if (!row) throw new Error("seed category");
  return row.id;
}

async function read(id: string) {
  const [row] = await db.select().from(categories).where(eq(categories.id, id));
  return row;
}

describe("setCategoryClassificationAction (P15-31)", () => {
  it("sets a necessity on an expense category", async () => {
    const id = await makeCategory("Rent", "expense");

    const res = await setCategoryClassificationAction(id, { necessity: "essential" });

    expect(res.ok).toBe(true);
    expect((await read(id))?.necessity).toBe("essential");
  });

  it("clears a necessity back to unclassified", async () => {
    // A user who mis-classified needs the way back, and the honest unclassified
    // share depends on that state being reachable.
    const id = await makeCategory("Rent", "expense");
    await setCategoryClassificationAction(id, { necessity: "essential" });

    await setCategoryClassificationAction(id, { necessity: "" });

    expect((await read(id))?.necessity).toBeNull();
  });

  it("toggles baseline exclusion without touching necessity", async () => {
    // The two axes are independent: a refund category excluded from take-home
    // must not lose a necessity it was given, and vice versa.
    const id = await makeCategory("Reimbursements", "income");
    await setCategoryClassificationAction(id, { necessity: "essential" });

    await setCategoryClassificationAction(id, { excludedFromBaseline: true });

    const row = await read(id);
    expect(row?.excludedFromBaseline).toBe(true);
    expect(row?.necessity).toBe("essential");
  });

  it("rejects a necessity outside the vocabulary", async () => {
    const id = await makeCategory("Rent", "expense");

    const res = await setCategoryClassificationAction(id, { necessity: "important" });

    expect(res.error).toBeTruthy();
    expect((await read(id))?.necessity).toBeNull();
  });

  it("reports a missing category rather than silently succeeding", async () => {
    const res = await setCategoryClassificationAction("11111111-1111-4111-8111-111111111111", {
      necessity: "essential",
    });

    expect(res.error).toMatch(/not found/i);
  });
});

describe("bulkClassifyAction (P15-31)", () => {
  it("classifies a batch in one pass", async () => {
    const rent = await makeCategory("Rent", "expense");
    const dining = await makeCategory("Dining", "expense");

    const res = await bulkClassifyAction([
      { categoryId: rent, necessity: "essential" },
      { categoryId: dining, necessity: "discretionary" },
    ]);

    expect(res.classified).toBe(2);
    expect((await read(rent))?.necessity).toBe("essential");
    expect((await read(dining))?.necessity).toBe("discretionary");
  });

  it("writes nothing when one assignment is invalid", async () => {
    // Transactional: landing half the batch would leave an unclassified share
    // the user believes they just fixed.
    const rent = await makeCategory("Rent", "expense");
    const dining = await makeCategory("Dining", "expense");

    const res = await bulkClassifyAction([
      { categoryId: rent, necessity: "essential" },
      { categoryId: dining, necessity: "important" },
    ]);

    expect(res.error).toBeTruthy();
    expect((await read(rent))?.necessity).toBeNull();
  });

  it("rejects the same category twice", async () => {
    const rent = await makeCategory("Rent", "expense");

    const res = await bulkClassifyAction([
      { categoryId: rent, necessity: "essential" },
      { categoryId: rent, necessity: "discretionary" },
    ]);

    expect(res.error).toMatch(/twice/i);
  });

  it("rejects an empty batch", async () => {
    expect((await bulkClassifyAction([])).error).toBeTruthy();
  });
});
