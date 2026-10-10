// @vitest-environment node
import { db } from "@/db/client.ts";
import { users } from "@/db/schema/index.ts";
import { sql } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { changePassword, parseChangePassword } from "./change-password.ts";
import { hashPassword, verifyPassword } from "./password.ts";

/* P19-33(b): real DB and real argon2id — the hash is the thing being changed. */

async function seedUser(password: string): Promise<string> {
  const [row] = await db
    .insert(users)
    .values({ passwordHash: await hashPassword(password) })
    .returning({ id: users.id });
  if (!row) throw new Error("seed user");
  return row.id;
}

async function storedHash(): Promise<string> {
  const [row] = await db.select({ h: users.passwordHash }).from(users);
  return row?.h ?? "";
}

function form(fields: Record<string, string>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  return f;
}

beforeEach(async () => {
  await db.execute(sql`TRUNCATE users`);
});

describe("parseChangePassword", () => {
  it("rejects a confirmation that does not match", () => {
    const result = parseChangePassword(form({ current: "a", next: "b", confirm: "c" }));
    expect(result).toEqual({ ok: false, error: expect.stringContaining("do not match") });
  });

  it("requires the current password", () => {
    expect(parseChangePassword(form({ current: "", next: "b", confirm: "b" })).ok).toBe(false);
  });

  it("imposes no minimum length (ADR-004)", () => {
    expect(parseChangePassword(form({ current: "a", next: "b", confirm: "b" })).ok).toBe(true);
  });
});

describe("changePassword", () => {
  it("refuses a wrong current password and changes nothing", async () => {
    const id = await seedUser("old");
    const before = await storedHash();

    const result = await changePassword(id, { current: "nope", next: "new", confirm: "new" });

    expect(result).toEqual({ kind: "wrong_current" });
    expect(await storedHash()).toBe(before);
  });

  it("stores the new password as argon2id, and the old one stops working", async () => {
    const id = await seedUser("old");

    const result = await changePassword(id, { current: "old", next: "new", confirm: "new" });

    expect(result.kind).toBe("changed");
    const hash = await storedHash();
    expect(hash.startsWith("$argon2id$")).toBe(true);
    expect(await verifyPassword(hash, "new")).toBe(true);
    expect(await verifyPassword(hash, "old")).toBe(false);
  });

  it("rotates the user id, so every session minted before the change is dead", async () => {
    const id = await seedUser("old");

    const result = await changePassword(id, { current: "old", next: "new", confirm: "new" });

    if (result.kind !== "changed") throw new Error(result.kind);
    expect(result.userId).not.toBe(id);
    const rows = await db.select({ id: users.id }).from(users);
    expect(rows).toEqual([{ id: result.userId }]);
  });

  it("never adds a second user", async () => {
    const id = await seedUser("old");
    await changePassword(id, { current: "old", next: "new", confirm: "new" });

    const [count] = await db.select({ n: sql<number>`count(*)::int` }).from(users);
    expect(count?.n).toBe(1);
  });

  it("reports a session whose user no longer exists", async () => {
    await seedUser("old");
    const result = await changePassword("00000000-0000-0000-0000-000000000000", {
      current: "old",
      next: "new",
      confirm: "new",
    });
    expect(result).toEqual({ kind: "no_user" });
  });
});
