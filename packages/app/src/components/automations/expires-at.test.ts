import { describe, expect, it } from "vitest";
import { dateTimeLocalToIso, isoToDateTimeLocal } from "./expires-at";

// The wire contract for `expiresAt` is an ISO-8601 string (empty = no expiry).
// The <input type="datetime-local"> value is a timezone-less "YYYY-MM-DDTHH:mm".
// We interpret the picker value as UTC wall-clock so the conversion is pure and
// deterministic (no dependence on the runner's local timezone), matching the
// UTC ISO string the field previously held verbatim.
describe("isoToDateTimeLocal", () => {
  it("derives a minute-precision datetime-local value from an ISO string", () => {
    expect(isoToDateTimeLocal("2026-12-31T09:30:00.000Z")).toBe("2026-12-31T09:30");
  });

  it("works when the ISO string has no milliseconds", () => {
    expect(isoToDateTimeLocal("2026-01-02T03:04:05Z")).toBe("2026-01-02T03:04");
  });

  it("returns empty for an empty / cleared value", () => {
    expect(isoToDateTimeLocal("")).toBe("");
    expect(isoToDateTimeLocal("   ")).toBe("");
  });

  it("returns empty for an unparseable value", () => {
    expect(isoToDateTimeLocal("not-a-date")).toBe("");
  });
});

describe("dateTimeLocalToIso", () => {
  it("expands a datetime-local value to a full ISO-8601 (UTC) string", () => {
    expect(dateTimeLocalToIso("2026-12-31T09:30")).toBe("2026-12-31T09:30:00.000Z");
  });

  it("accepts a value that already carries seconds", () => {
    expect(dateTimeLocalToIso("2026-12-31T09:30:45")).toBe("2026-12-31T09:30:45.000Z");
  });

  it("returns empty for an empty / cleared value", () => {
    expect(dateTimeLocalToIso("")).toBe("");
    expect(dateTimeLocalToIso("   ")).toBe("");
  });

  it("returns empty for an unparseable value", () => {
    expect(dateTimeLocalToIso("nonsense")).toBe("");
  });
});

describe("round-trip", () => {
  it("ISO -> datetime-local -> ISO is stable at minute precision", () => {
    const iso = "2026-06-09T14:00:00.000Z";
    expect(dateTimeLocalToIso(isoToDateTimeLocal(iso))).toBe(iso);
  });
});
