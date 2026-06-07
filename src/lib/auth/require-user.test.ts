// @vitest-environment node
import { db } from "@/db/client.ts";
import { users } from "@/db/schema/index.ts";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* ---------------------------------------------------------------------------
 * Mocks: the iron-session (so we control userId + spy on destroy/save) and
 * next/navigation.redirect (throws a sentinel like the real one). DB is real.
 * --------------------------------------------------------------------------- */

const sessionState: { userId?: string } = {};
const destroySpy = vi.fn();
const saveSpy = vi.fn();

vi.mock("./session.ts", () => ({
  getSession: vi.fn(async () => ({
    get userId() {
      return sessionState.userId;
    },
    set userId(v: string | undefined) {
      sessionState.userId = v;
    },
    destroy: destroySpy,
    save: saveSpy,
  })),
}));

class RedirectError extends Error {
  constructor(public readonly path: string) {
    super(`__redirect__:${path}`);
  }
}
vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new RedirectError(path);
  },
}));

const { requireUser } = await import("./require-user.ts");

const FIXED_UUID = "00000000-0000-0000-0000-0000000000ff";

beforeEach(async () => {
  await db.execute(sql`TRUNCATE users CASCADE`);
  sessionState.userId = undefined;
  destroySpy.mockClear();
  saveSpy.mockClear();
});
afterEach(() => vi.clearAllMocks());

describe("requireUser", () => {
  it("redirects to /login when there is no session", async () => {
    await expect(requireUser()).rejects.toMatchObject({ path: "/login" });
  });

  it("redirects to /login for a stale session WITHOUT mutating the cookie", async () => {
    // Cookie points at a user that no longer exists (e.g. after a db-reset).
    sessionState.userId = FIXED_UUID;

    await expect(requireUser()).rejects.toMatchObject({ path: "/login" });

    // The bug: session.destroy() here is a cookie write, illegal inside a
    // Server Component render → Next throws "Cookies can only be modified in a
    // Server Action or Route Handler". The fix redirects without writing.
    expect(destroySpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
  });

  it("returns the user when the session resolves to a real row", async () => {
    const [created] = await db
      .insert(users)
      .values({ id: FIXED_UUID, passwordHash: "fake" })
      .returning({ id: users.id });
    sessionState.userId = created?.id;

    const user = await requireUser();
    expect(user.id).toBe(FIXED_UUID);
    expect(destroySpy).not.toHaveBeenCalled();
  });
});
