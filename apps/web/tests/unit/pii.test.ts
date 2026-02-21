import { describe, expect, it } from "vitest";
import { scanPii } from "@/domain/pii";

describe("pii scanner", () => {
  it("detects high risk secrets", () => {
    const result = scanPii(["api_key=abcdefg1234567890"]);
    expect(result.risk).toBe("high");
  });

  it("detects medium risk contacts", () => {
    const result = scanPii(["mail me: user@example.com"]);
    expect(result.risk).toBe("medium");
  });

  it("allows low risk text", () => {
    const result = scanPii(["today I reviewed notes"]);
    expect(result.risk).toBe("low");
  });
});
