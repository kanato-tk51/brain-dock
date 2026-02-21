import { describe, expect, it } from "vitest";
import { nowUtcIso, toLocalInputValue, toUtcIso } from "@/shared/utils/time";
import { newUuidV7 } from "@/shared/utils/uuid";

describe("time and uuid utils", () => {
  it("returns valid utc iso", () => {
    const now = nowUtcIso();
    expect(() => new Date(now)).not.toThrow();
    expect(now.endsWith("Z")).toBe(true);
  });

  it("converts local input string to utc and back", () => {
    const utc = toUtcIso("2026-02-21T08:15");
    expect(utc.endsWith("Z")).toBe(true);
    const local = toLocalInputValue(utc);
    expect(local).toMatch(/2026-02-21T\d{2}:\d{2}/);
  });

  it("generates unique ids", () => {
    const a = newUuidV7();
    const b = newUuidV7();
    expect(a).not.toBe(b);
    expect(a).toHaveLength(36);
  });
});
