import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  captureTextInputSchema,
  entryTypeSchema,
  listQuerySchema,
  openAiCostSummaryQuerySchema,
  openAiRequestQuerySchema,
  runAnalysisInputSchema,
  searchQuerySchema,
  type CreateEntryInput,
  type EntryType,
  type ListQuery,
} from "./schemas.js";
import type { DataStore } from "../services/store.js";
import { nowUtcIso } from "./utils.js";

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

function parseOpenAiRequestQuery(query: Record<string, unknown>) {
  const limitRaw = typeof query.limit === "string" ? Number(query.limit) : undefined;
  const parsed = openAiRequestQuerySchema.safeParse({
    fromUtc: typeof query.fromUtc === "string" ? query.fromUtc : undefined,
    toUtc: typeof query.toUtc === "string" ? query.toUtc : undefined,
    status: typeof query.status === "string" ? query.status : undefined,
    model: typeof query.model === "string" ? query.model : undefined,
    operation: typeof query.operation === "string" ? query.operation : undefined,
    workflow: typeof query.workflow === "string" ? query.workflow : undefined,
    limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
  });
  if (!parsed.success) {
    throw new Error("invalid openai request query");
  }
  return parsed.data;
}

function parseOpenAiCostSummaryQuery(query: Record<string, unknown>) {
  const limitRaw = typeof query.limit === "string" ? Number(query.limit) : undefined;
  const parsed = openAiCostSummaryQuerySchema.safeParse({
    period: typeof query.period === "string" ? query.period : undefined,
    fromUtc: typeof query.fromUtc === "string" ? query.fromUtc : undefined,
    toUtc: typeof query.toUtc === "string" ? query.toUtc : undefined,
    limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
  });
  if (!parsed.success) {
    throw new Error("invalid openai cost query");
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

  app.post("/entries/:type", async (request, reply) => {
    const params = z.object({ type: entryTypeSchema }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "invalid type" });
    }

    const parsed = captureTextInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid body", detail: parsed.error.issues });
    }

    const entryInput = buildTextCaptureInput(params.data.type, parsed.data.text, parsed.data.occurredAtUtc);
    const entry = await store.createEntry(entryInput);
    return reply.status(201).send(entry);
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

  app.get("/openai/requests", async (request, reply) => {
    try {
      const query = parseOpenAiRequestQuery((request.query as Record<string, unknown>) ?? {});
      return store.listOpenAiRequests(query);
    } catch {
      return reply.status(400).send({ error: "invalid query" });
    }
  });

  app.get("/openai/costs/summary", async (request, reply) => {
    try {
      const query = parseOpenAiCostSummaryQuery((request.query as Record<string, unknown>) ?? {});
      return store.getOpenAiCostSummary(query);
    } catch {
      return reply.status(400).send({ error: "invalid query" });
    }
  });

  app.post("/analysis/run", async (request, reply) => {
    const parsed = runAnalysisInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid body", detail: parsed.error.issues });
    }
    const result = await store.runAnalysisForEntries(parsed.data);
    return reply.status(200).send(result);
  });

  return app;
}

function buildTextCaptureInput(type: EntryType, text: string, occurredAtUtc?: string): CreateEntryInput {
  const normalizedText = text.trim();
  const payload = buildMinimalPayload(type, normalizedText);
  return {
    declaredType: type,
    body: normalizedText,
    tags: [],
    occurredAtUtc: occurredAtUtc ?? nowUtcIso(),
    sensitivity: "internal",
    payload,
  };
}

function buildMinimalPayload(type: EntryType, text: string): Record<string, unknown> {
  switch (type) {
    case "journal":
      return { reflection: text };
    case "todo":
      return { details: text, status: "todo", priority: 3 };
    case "learning":
      return { takeaway: text };
    case "thought":
      return { note: text };
    case "meeting":
      return { context: text, notes: text, decisions: [], actions: [] };
    default: {
      const unreachableType: never = type;
      throw new Error(`unsupported entry type: ${String(unreachableType)}`);
    }
  }
}
