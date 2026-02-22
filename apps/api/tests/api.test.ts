import { beforeEach, describe, expect, it } from "vitest";
import { buildApp } from "../src/lib/app.js";
import { MemoryStore } from "../src/services/memory-store.js";

describe("brain-dock-api", () => {
  let store: MemoryStore;

  beforeEach(() => {
    store = new MemoryStore();
  });

  it("creates/lists/searches entries via typed capture route", async () => {
    const app = await buildApp(store);
    const created = await app.inject({
      method: "POST",
      url: "/entries/learning",
      payload: {
        text: "指数バックオフを使う",
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

  it("returns openai usage history and aggregate summary", async () => {
    const app = await buildApp(store);

    const requests = await app.inject({ method: "GET", url: "/openai/requests?limit=20" });
    expect(requests.statusCode).toBe(200);
    expect(requests.json()).toEqual([]);

    const summary = await app.inject({ method: "GET", url: "/openai/costs/summary?period=week&limit=12" });
    expect(summary.statusCode).toBe(200);
    expect(summary.json().period).toBe("week");
    expect(summary.json().totals.totalCostUsd).toBe(0);

    const invalid = await app.inject({ method: "GET", url: "/openai/costs/summary?period=year" });
    expect(invalid.statusCode).toBe(400);
  });

  it("supports analysis job API", async () => {
    const app = await buildApp(store);
    const created = await app.inject({
      method: "POST",
      url: "/entries/thought",
      payload: { text: "分析ボタンから実行するテスト" },
    });
    const entryId = created.json().id as string;

    const models = await app.inject({ method: "GET", url: "/analysis/models" });
    expect(models.statusCode).toBe(200);
    expect(models.json().length).toBeGreaterThan(0);

    const run = await app.inject({
      method: "POST",
      url: "/analysis/jobs",
      payload: {
        entryIds: [entryId],
        replaceExisting: true,
        priority: "normal",
      },
    });
    expect(run.statusCode).toBe(200);
    expect(run.json().jobId).toBeTruthy();
    expect(run.json().requested).toBe(1);
    expect(run.json().results[0].entryId).toBe(entryId);

    const jobs = await app.inject({
      method: "GET",
      url: "/analysis/jobs?limit=10",
    });
    expect(jobs.statusCode).toBe(200);

    const invalid = await app.inject({
      method: "POST",
      url: "/analysis/jobs",
      payload: { entryIds: [] },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it("supports facts and rollups APIs", async () => {
    const app = await buildApp(store);

    const claims = await app.inject({ method: "GET", url: "/facts/claims?limit=10" });
    expect(claims.statusCode).toBe(200);
    expect(claims.json()).toEqual([]);

    const rollups = await app.inject({
      method: "POST",
      url: "/rollups/rebuild",
      payload: {
        periodType: "weekly",
        fromUtc: "2026-02-01T00:00:00.000Z",
        toUtc: "2026-02-28T00:00:00.000Z",
      },
    });
    expect(rollups.statusCode).toBe(200);
    expect(rollups.json()).toEqual([]);
  });
});
