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

  it("creates entries via typed text capture route", async () => {
    const app = await buildApp(store);

    const thought = await app.inject({
      method: "POST",
      url: "/entries/thought",
      payload: {
        text: "設計の仮説をメモした",
      },
    });
    expect(thought.statusCode).toBe(201);
    expect(thought.json().declaredType).toBe("thought");
    expect(thought.json().body).toBe("設計の仮説をメモした");
    expect(thought.json().payload.note).toBe("設計の仮説をメモした");

    const todo = await app.inject({
      method: "POST",
      url: "/entries/todo",
      payload: {
        text: "API接続の検証をする",
      },
    });
    expect(todo.statusCode).toBe(201);
    expect(todo.json().declaredType).toBe("todo");
    expect(todo.json().payload.details).toBe("API接続の検証をする");
    expect(todo.json().payload.status).toBe("todo");

    const meeting = await app.inject({
      method: "POST",
      url: "/entries/meeting",
      payload: {
        text: "次回までに見積もりを出す",
      },
    });
    expect(meeting.statusCode).toBe(201);
    expect(meeting.json().declaredType).toBe("meeting");
    expect(meeting.json().payload.context).toBe("次回までに見積もりを出す");
    expect(meeting.json().payload.notes).toBe("次回までに見積もりを出す");

    const list = await app.inject({ method: "GET", url: "/entries?limit=20" });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toHaveLength(3);
  });

  it("returns 400 on invalid typed text capture request", async () => {
    const app = await buildApp(store);

    const invalidType = await app.inject({
      method: "POST",
      url: "/entries/unknown",
      payload: { text: "x" },
    });
    expect(invalidType.statusCode).toBe(400);

    const invalidBody = await app.inject({
      method: "POST",
      url: "/entries/journal",
      payload: { text: "   " },
    });
    expect(invalidBody.statusCode).toBe(400);
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
