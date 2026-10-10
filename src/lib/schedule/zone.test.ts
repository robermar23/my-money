// @vitest-environment node
import { describe, expect, it } from "vitest";
import { effectiveZone, localTimeOfDay, resolveScheduleZone, utcOffsetLabel } from "./zone.ts";

describe("resolveScheduleZone", () => {
  it("treats a missing, empty or blank TZ as unset", () => {
    for (const raw of [undefined, "", "   "]) {
      expect(resolveScheduleZone(raw)).toEqual({ kind: "unset" });
    }
  });

  it("canonicalizes a zone the runtime knows", () => {
    expect(resolveScheduleZone(" Australia/Sydney ")).toEqual({
      kind: "zone",
      zone: "Australia/Sydney",
    });
    expect(resolveScheduleZone("utc")).toEqual({ kind: "zone", zone: "UTC" });
  });

  it("reports an unknown zone as invalid instead of throwing", () => {
    expect(resolveScheduleZone("Mars/Olympus")).toEqual({ kind: "invalid", raw: "Mars/Olympus" });
    expect(resolveScheduleZone(":/etc/localtime").kind).toBe("invalid");
  });

  it("caps the echoed raw value", () => {
    const state = resolveScheduleZone("x".repeat(500));
    expect(state.kind === "invalid" && state.raw.length).toBe(64);
  });
});

describe("effectiveZone", () => {
  it("runs on UTC unless a valid zone is set, which is the pre-P19-24 behaviour", () => {
    expect(effectiveZone({ kind: "unset" })).toBe("UTC");
    expect(effectiveZone({ kind: "invalid", raw: "Mars/Olympus" })).toBe("UTC");
    expect(effectiveZone({ kind: "zone", zone: "America/New_York" })).toBe("America/New_York");
  });
});

describe("utcOffsetLabel", () => {
  it("follows daylight time at the instant given", () => {
    expect(utcOffsetLabel("America/New_York", new Date("2026-01-15T12:00:00Z"))).toBe("UTC-05:00");
    expect(utcOffsetLabel("America/New_York", new Date("2026-07-15T12:00:00Z"))).toBe("UTC-04:00");
  });

  it("renders UTC bare and keeps half-hour offsets", () => {
    expect(utcOffsetLabel("UTC", new Date("2026-07-15T12:00:00Z"))).toBe("UTC");
    expect(utcOffsetLabel("Asia/Kolkata", new Date("2026-07-15T12:00:00Z"))).toBe("UTC+05:30");
  });
});

describe("localTimeOfDay", () => {
  it("gives the wall clock in the zone, 24-hour", () => {
    // UTC midnight on 2026-10-10 is 11:00 in Sydney (AEDT) and 20:00 the day
    // before in New York (EDT).
    const midnight = new Date("2026-10-10T00:00:00Z");
    expect(localTimeOfDay("Australia/Sydney", midnight)).toBe("11:00");
    expect(localTimeOfDay("America/New_York", midnight)).toBe("20:00");
    expect(localTimeOfDay("UTC", midnight)).toBe("00:00");
  });
});
