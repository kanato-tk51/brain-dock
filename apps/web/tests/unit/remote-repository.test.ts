import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteRepository } from "@/infra/remote-repository";

describe("remote repository", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  it("calls API to create/list/search entries", async () => {
    const repo = new RemoteRepository("http://localhost:8787");
    const baseEntry = {
      id: "018ecf2e-8f8a-7b94-a112-2f0a96d1d000",
      declaredType: "thought",
      title: "タイトル",
      body: "本文",
      tags: ["x"],
      occurredAtUtc: "2026-02-21T10:00:00.000Z",
      sensitivity: "internal",
      createdAtUtc: "2026-02-21T10:00:00.000Z",
      updatedAtUtc: "2026-02-21T10:00:00.000Z",
      syncStatus: "pending",
      payload: { note: "メモ" },
    };

    fetchMock
      .mockResolvedValueOnce(new Response(JSON.stringify(baseEntry), { status: 201 }))
      .mockResolvedValueOnce(new Response(JSON.stringify([baseEntry]), { status: 200 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify([{ entry: baseEntry, score: 1.2, matchedFields: ["payload"] }]), { status: 200 }),
      );

    const created = await repo.createEntry({
      declaredType: "thought",
      title: "タイトル",
      body: "本文",
      tags: ["x"],
      occurredAtUtc: "2026-02-21T10:00:00.000Z",
      sensitivity: "internal",
      payload: { note: "メモ" },
    });
    expect(created.id).toBe(baseEntry.id);

    const list = await repo.listEntries({ limit: 10 });
    expect(list).toHaveLength(1);

    const search = await repo.searchEntries({ text: "メモ", limit: 10 });
    expect(search).toHaveLength(1);
  });

  it("marks sync failure via API", async () => {
    const repo = new RemoteRepository("http://localhost:8787");
    fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
    await repo.markSyncFailed("018ecf2e-8f8a-7b94-a112-2f0a96d1d111", "network timeout");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://localhost:8787/sync-queue/018ecf2e-8f8a-7b94-a112-2f0a96d1d111/mark-failed",
      expect.objectContaining({
        method: "POST",
      }),
    );
  });
});
