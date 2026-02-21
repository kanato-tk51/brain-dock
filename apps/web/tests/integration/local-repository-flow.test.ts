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

  it("enqueues sync and marks synced", async () => {
    const repo = new LocalRepository();
    const entry = await repo.createEntry({
      declaredType: "todo",
      title: "Send report",
      body: "",
      tags: [],
      occurredAtUtc: "2026-02-21T10:00:00.000Z",
      sensitivity: "internal",
      payload: {
        details: "send report",
        status: "todo",
        priority: 2,
      },
    });

    const queue = await repo.listSyncQueue();
    expect(queue.some((q) => q.entryId === entry.id && q.status === "pending")).toBe(true);

    const target = queue.find((q) => q.entryId === entry.id)!;
    await repo.markSynced(target.id, "remote-1");

    const updated = await repo.listEntries();
    expect(updated[0].syncStatus).toBe("synced");
  });

  it("marks sync failure and keeps queue error", async () => {
    const repo = new LocalRepository();
    const entry = await repo.createEntry({
      declaredType: "todo",
      title: "Retry sync",
      body: "",
      tags: [],
      occurredAtUtc: "2026-02-21T10:00:00.000Z",
      sensitivity: "internal",
      payload: {
        details: "retry after network error",
        status: "todo",
        priority: 2,
      },
    });

    const queue = await repo.listSyncQueue();
    const target = queue.find((q) => q.entryId === entry.id)!;
    await repo.markSyncFailed(target.id, "network timeout");

    const queueAfter = await repo.listSyncQueue();
    expect(queueAfter.find((q) => q.id === target.id)?.status).toBe("failed");
    expect(queueAfter.find((q) => q.id === target.id)?.lastError).toContain("network");

    const updated = await repo.listEntries();
    expect(updated[0].syncStatus).toBe("failed");
  });
});
