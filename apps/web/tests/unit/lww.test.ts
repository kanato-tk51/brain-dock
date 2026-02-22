import { describe, expect, it } from "vitest";
import { resolveLww } from "@/domain/lww";
import type { Entry } from "@/domain/schemas";

function makeEntry(updatedAtUtc: string, title: string): Entry {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    declaredType: "thought",
    title,
    body: "",
    tags: [],
    occurredAtUtc: "2026-02-21T00:00:00.000Z",
    sensitivity: "internal",
    createdAtUtc: "2026-02-21T00:00:00.000Z",
    updatedAtUtc,
    payload: { note: "memo" },
    analysisState: "not_requested",
  };
}

describe("LWW merge", () => {
  it("picks newer record", () => {
    const local = makeEntry("2026-02-21T01:00:00.000Z", "old");
    const incoming = makeEntry("2026-02-21T02:00:00.000Z", "new");
    const out = resolveLww(local, incoming);
    expect(out.title).toBe("new");
  });

  it("keeps local when incoming older", () => {
    const local = makeEntry("2026-02-21T02:00:00.000Z", "local");
    const incoming = makeEntry("2026-02-21T01:00:00.000Z", "incoming");
    const out = resolveLww(local, incoming);
    expect(out.title).toBe("local");
  });
});
