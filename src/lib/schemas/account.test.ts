import { describe, expect, it } from "vitest";
import { createAssetSchema, updateAssetMetadataSchema } from "./account.ts";

/**
 * Pure validation tests for the Phase 10 asset schemas (P10-04, P10-06). No DB —
 * these only exercise Zod parsing of the create/edit form shapes.
 */

describe("createAssetSchema (P10-04)", () => {
  it("accepts a minimal asset (name + category, currency defaults to USD)", () => {
    const parsed = createAssetSchema.safeParse({ name: "2021 Tacoma", assetCategory: "vehicle" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.currency).toBe("USD");
      expect(parsed.data.description).toBeUndefined();
    }
  });

  it("accepts the full optional field set", () => {
    const parsed = createAssetSchema.safeParse({
      name: "Rolex Submariner",
      assetCategory: "jewelry",
      description: "Ref. 124060, box & papers",
      acquiredAt: "2022-06-01",
      acquisitionCost: "9500.00",
      currency: "USD",
      initialValue: "11000.00",
      initialValueDate: "2026-06-20",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown category", () => {
    const parsed = createAssetSchema.safeParse({ name: "Mystery", assetCategory: "spaceship" });
    expect(parsed.success).toBe(false);
  });

  it("rejects a blank name", () => {
    const parsed = createAssetSchema.safeParse({ name: "   ", assetCategory: "other" });
    expect(parsed.success).toBe(false);
  });

  it("rejects acquisition cost with more than two decimals", () => {
    const parsed = createAssetSchema.safeParse({
      name: "Boat",
      assetCategory: "watercraft",
      acquisitionCost: "1234.567",
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects a malformed acquired date", () => {
    const parsed = createAssetSchema.safeParse({
      name: "Boat",
      assetCategory: "watercraft",
      acquiredAt: "06/01/2022",
    });
    expect(parsed.success).toBe(false);
  });

  it("treats empty-string optionals as present-but-empty", () => {
    const parsed = createAssetSchema.safeParse({
      name: "Art piece",
      assetCategory: "collectible",
      description: "",
      acquiredAt: "",
      acquisitionCost: "",
      initialValue: "",
      initialValueDate: "",
    });
    expect(parsed.success).toBe(true);
  });
});

describe("updateAssetMetadataSchema (P10-06)", () => {
  it("accepts an edit with cleared optional fields", () => {
    const parsed = updateAssetMetadataSchema.safeParse({
      name: "Renamed asset",
      assetCategory: "other",
      description: "",
      acquiredAt: "",
      acquisitionCost: "",
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects an unknown category", () => {
    const parsed = updateAssetMetadataSchema.safeParse({ name: "x", assetCategory: "house" });
    expect(parsed.success).toBe(false);
  });
});
