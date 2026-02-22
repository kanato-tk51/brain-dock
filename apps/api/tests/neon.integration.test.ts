import { describe, expect, it } from "vitest";
import { createPgStore } from "../src/services/pg-store.js";

const dsn = process.env.NEON_DATABASE_URL;

const maybeDescribe = dsn ? describe : describe.skip;

maybeDescribe("neon integration", () => {
  it("writes and reads entry + analysis state", async () => {
    const store = createPgStore(dsn!);
    try {
      const created = await store.createEntry({
        declaredType: "thought",
        title: "neon integration test",
        body: "worker連携の前提確認",
        tags: ["integration", "neon"],
        occurredAtUtc: new Date().toISOString(),
        sensitivity: "internal",
        payload: {
          note: "roundtrip check",
        },
      });

      const listed = await store.listEntries({ tags: ["integration"], limit: 50 });
      expect(listed.some((e) => e.id === created.id)).toBe(true);

      expect(created.analysisState).toBe("not_requested");

      const models = await store.getAnalysisModels();
      expect(models.length).toBeGreaterThan(0);

      const history = await store.listHistory(created.id);
      expect(history.length).toBeGreaterThanOrEqual(0);
    } finally {
      await store.close();
    }
  });
});
