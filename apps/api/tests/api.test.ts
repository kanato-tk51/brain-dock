import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/lib/app.js";
import { MemoryStore } from "../src/services/memory-store.js";

describe("brain-dock-api", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  it("creates/lists/searches entries", async () => {
    const app = await buildApp(store);
    const created = await app.inject({
      method: "POST",
      url: "/entries",
      payload: {
        declaredType: "learning",
        title: "Retry policy",
        body: "ネットワークの再試行を見直す",
        tags: ["backend", "learning"],
        occurredAtUtc: "2026-02-21T10:00:00.000Z",
        sensitivity: "internal",
        payload: {
          takeaway: "指数バックオフを使う",
        },
      },
    });
    expect(created.statusCode).toBe(201);

    const list = await app.inject({ method: "GET", url: "/entries?limit=20" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(1);

    const search = await app.inject({ method: "GET", url: "/entries/search?text=%E6%8C%87%E6%95%B0" });
    expect(search.statusCode).toBe(200);
    expect(search.json().length).toBeGreaterThan(0);
  });

  it("sync queue transitions and history are recorded", async () => {
    const app = await buildApp(store);
    const created = await app.inject({
      method: "POST",
      url: "/entries",
      payload: {
        declaredType: "todo",
        title: "API実装",
        tags: [],
        occurredAtUtc: "2026-02-21T10:00:00.000Z",
        sensitivity: "internal",
        payload: {
          details: "sync queueを実装する",
          status: "todo",
          priority: 2,
        },
      },
    });
    const entry = created.json();
    const queue = await app.inject({ method: "GET", url: "/sync-queue" });
    const queueId = queue.json()[0].id as string;

    const synced = await app.inject({
      method: "POST",
      url: `/sync-queue/${queueId}/mark-synced`,
      payload: { remoteId: `remote-${entry.id}` },
    });
    expect(synced.statusCode).toBe(204);

    const history = await app.inject({ method: "GET", url: `/history?entryId=${entry.id}` });
    expect(history.statusCode).toBe(200);
    expect(history.json().length).toBeGreaterThan(0);

    const updated = await app.inject({ method: "GET", url: "/entries" });
    expect(updated.json()[0].syncStatus).toBe("synced");
  });
});
