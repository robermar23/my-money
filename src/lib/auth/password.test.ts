import { describe, expect, it } from "vitest";
import { hashPassword, verifyPassword } from "./password.ts";

describe("password hashing", () => {
  it("hashes and verifies the same password", async () => {
    const password = "correct horse battery staple";
    const hash = await hashPassword(password);

    expect(hash).toMatch(/^\$argon2id\$/);
    await expect(verifyPassword(hash, password)).resolves.toBe(true);
  });

  it("rejects an incorrect password", async () => {
    const hash = await hashPassword("right");
    await expect(verifyPassword(hash, "wrong")).resolves.toBe(false);
  });

  it("produces different hashes for the same password (salted)", async () => {
    const password = "same input";
    const hashA = await hashPassword(password);
    const hashB = await hashPassword(password);

    expect(hashA).not.toBe(hashB);
    await expect(verifyPassword(hashA, password)).resolves.toBe(true);
    await expect(verifyPassword(hashB, password)).resolves.toBe(true);
  });
});
