import { beforeEach, describe, expect, it } from "vitest";
import { LocalRepository } from "@/infra/local-repository";
import { resetDbForTests } from "@/infra/indexeddb";

describe("local repository integration", () => {
  beforeEach(async () => {
    await resetDbForTests();
  });

  it("creates entry then lists and searches it", async () => {
    const repo = new LocalRepository();
    const created = await repo.createEntry({
      declaredType: "learning",
      title: "Retry strategy",
      body: "",
      tags: ["backend"],
      occurredAtUtc: "2026-02-21T10:00:00.000Z",
      sensitivity: "internal",
      payload: {
        takeaway: "Use exponential backoff",
      },
    });

    const listed = await repo.listEntries();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(created.id);
    expect(listed[0].analysisState).toBe("not_requested");

    const searched = await repo.searchEntries({ text: "exponential", limit: 50 });
    expect(searched.length).toBeGreaterThan(0);
    expect(searched[0].entry.id).toBe(created.id);
  });

  it("stores and restores drafts", async () => {
    const repo = new LocalRepository();
    await repo.saveDraft("thought", {
      title: "draft",
      payload: { note: "unfinished" },
    });

    const loaded = await repo.loadDraft("thought");
    expect(loaded?.declaredType).toBe("thought");
    expect((loaded?.value as any).title).toBe("draft");
  });

  it("history is empty by default", async () => {
    const repo = new LocalRepository();
    const history = await repo.listHistory();
    expect(history).toEqual([]);
  });
});
