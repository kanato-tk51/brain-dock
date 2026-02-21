import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  createEntryInputSchema,
  listQuerySchema,
  searchQuerySchema,
  type EntryType,
  type ListQuery,
} from "./schemas.js";
import type { DataStore } from "../services/store.js";

function parseListQuery(query: Record<string, unknown>): ListQuery {
  const typesRaw = typeof query.types === "string" ? query.types.split(",").map((v) => v.trim()) : undefined;
  const tagsRaw = typeof query.tags === "string" ? query.tags.split(",").map((v) => v.trim()) : undefined;
  const limitRaw = typeof query.limit === "string" ? Number(query.limit) : undefined;

  const parsed = listQuerySchema.safeParse({
    types: typesRaw?.filter(Boolean) as EntryType[] | undefined,
    tags: tagsRaw?.filter(Boolean),
    fromUtc: typeof query.fromUtc === "string" ? query.fromUtc : undefined,
    toUtc: typeof query.toUtc === "string" ? query.toUtc : undefined,
    sensitivity: typeof query.sensitivity === "string" ? query.sensitivity : undefined,
    limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
  });
  if (!parsed.success) {
    throw new Error("invalid list query");
  }
  return parsed.data;
}

export async function buildApp(store: DataStore): Promise<FastifyInstance> {
  const app = Fastify({
    logger: true,
  });

  await app.register(cors, {
    origin: true,
  });

  app.get("/health", async () => {
    return { ok: true, mode: store.kind() };
  });

  app.post("/entries", async (request, reply) => {
    const parsed = createEntryInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid body", detail: parsed.error.issues });
    }
    const entry = await store.createEntry(parsed.data);
    return reply.status(201).send(entry);
  });

  app.patch("/entries/:id", async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "invalid id" });
    }

    const patch = z.record(z.string(), z.unknown()).safeParse(request.body);
    if (!patch.success) {
      return reply.status(400).send({ error: "invalid patch body" });
    }
    const entry = await store.updateEntry(params.data.id, patch.data as Record<string, unknown>);
    return reply.send(entry);
  });

  app.get("/entries", async (request, reply) => {
    try {
      const query = parseListQuery((request.query as Record<string, unknown>) ?? {});
      return store.listEntries(query);
    } catch {
      return reply.status(400).send({ error: "invalid query" });
    }
  });

  app.get("/entries/search", async (request, reply) => {
    const raw = (request.query as Record<string, unknown>) ?? {};
    let list: ListQuery;
    try {
      list = parseListQuery(raw);
    } catch {
      return reply.status(400).send({ error: "invalid query" });
    }
    const query = searchQuerySchema.safeParse({
      ...list,
      text: typeof raw.text === "string" ? raw.text : "",
    });
    if (!query.success) {
      return reply.status(400).send({ error: "invalid query", detail: query.error.issues });
    }
    return store.searchEntries(query.data);
  });

  app.post("/sync-queue/enqueue", async (request, reply) => {
    const parsed = z.object({ entryId: z.string().uuid() }).safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid body" });
    }
    await store.enqueueSync(parsed.data.entryId);
    return reply.status(204).send();
  });

  app.get("/sync-queue", async () => {
    return store.listSyncQueue();
  });

  app.post("/sync-queue/:id/mark-synced", async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = z.object({ remoteId: z.string().optional() }).safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: "invalid request" });
    }
    await store.markSynced(params.data.id, body.data.remoteId ?? params.data.id);
    return reply.status(204).send();
  });

  app.post("/sync-queue/:id/mark-failed", async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    const body = z.object({ error: z.string().min(1) }).safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: "invalid request" });
    }
    await store.markSyncFailed(params.data.id, body.data.error);
    return reply.status(204).send();
  });

  app.get("/history", async (request, reply) => {
    const parsed = z
      .object({ entryId: z.string().uuid().optional() })
      .safeParse((request.query as Record<string, unknown>) ?? {});
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid query" });
    }
    return store.listHistory(parsed.data.entryId);
  });

  return app;
}
