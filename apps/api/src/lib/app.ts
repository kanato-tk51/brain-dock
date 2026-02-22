import cors from "@fastify/cors";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";
import {
  analysisJobQuerySchema,
  captureTextInputSchema,
  entryTypeSchema,
  factSearchQuerySchema,
  listQuerySchema,
  openAiCostSummaryQuerySchema,
  openAiRequestQuerySchema,
  rebuildRollupsInputSchema,
  retractFactClaimInputSchema,
  reviseFactClaimInputSchema,
  rollupQuerySchema,
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

function parseAnalysisJobQuery(query: Record<string, unknown>) {
  const limitRaw = typeof query.limit === "string" ? Number(query.limit) : undefined;
  const parsed = analysisJobQuerySchema.safeParse({
    status: typeof query.status === "string" ? query.status : undefined,
    limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
  });
  if (!parsed.success) {
    throw new Error("invalid analysis job query");
  }
  return parsed.data;
}

function parseFactSearchQuery(query: Record<string, unknown>) {
  const limitRaw = typeof query.limit === "string" ? Number(query.limit) : undefined;
  const parsed = factSearchQuerySchema.safeParse({
    text: typeof query.text === "string" ? query.text : undefined,
    type: typeof query.type === "string" ? query.type : undefined,
    modality: typeof query.modality === "string" ? query.modality : undefined,
    predicate: typeof query.predicate === "string" ? query.predicate : undefined,
    meRole: typeof query.meRole === "string" ? query.meRole : undefined,
    dimensionType: typeof query.dimensionType === "string" ? query.dimensionType : undefined,
    dimensionValue: typeof query.dimensionValue === "string" ? query.dimensionValue : undefined,
    fromUtc: typeof query.fromUtc === "string" ? query.fromUtc : undefined,
    toUtc: typeof query.toUtc === "string" ? query.toUtc : undefined,
    limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
  });
  if (!parsed.success) {
    throw new Error("invalid fact search query");
  }
  return parsed.data;
}

function parseRollupQuery(query: Record<string, unknown>) {
  const limitRaw = typeof query.limit === "string" ? Number(query.limit) : undefined;
  const parsed = rollupQuerySchema.safeParse({
    scopeType: typeof query.scopeType === "string" ? query.scopeType : undefined,
    scopeKey: typeof query.scopeKey === "string" ? query.scopeKey : undefined,
    periodType: typeof query.periodType === "string" ? query.periodType : undefined,
    fromUtc: typeof query.fromUtc === "string" ? query.fromUtc : undefined,
    toUtc: typeof query.toUtc === "string" ? query.toUtc : undefined,
    limit: Number.isFinite(limitRaw) ? limitRaw : undefined,
  });
  if (!parsed.success) {
    throw new Error("invalid rollup query");
  }
  return parsed.data;
}

export async function buildApp(store: DataStore): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

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

  app.get("/analysis/models", async () => {
    return store.getAnalysisModels();
  });

  app.post("/analysis/jobs", async (request, reply) => {
    const parsed = runAnalysisInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid body", detail: parsed.error.issues });
    }
    const result = await store.runAnalysisForEntries(parsed.data);
    return reply.status(200).send(result);
  });

  app.post("/analysis/run", async (request, reply) => {
    const parsed = runAnalysisInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: "invalid body", detail: parsed.error.issues });
    }
    const result = await store.runAnalysisForEntries(parsed.data);
    return reply.status(200).send(result);
  });

  app.get("/analysis/jobs", async (request, reply) => {
    try {
      const query = parseAnalysisJobQuery((request.query as Record<string, unknown>) ?? {});
      return store.listAnalysisJobs(query);
    } catch {
      return reply.status(400).send({ error: "invalid query" });
    }
  });

  app.get("/analysis/jobs/:id", async (request, reply) => {
    const params = z.object({ id: z.string().uuid() }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "invalid id" });
    }
    const job = await store.getAnalysisJob(params.data.id);
    if (!job) {
      return reply.status(404).send({ error: "job not found" });
    }
    return job;
  });

  app.get("/facts/claims", async (request, reply) => {
    try {
      const query = parseFactSearchQuery((request.query as Record<string, unknown>) ?? {});
      return store.searchFacts(query);
    } catch {
      return reply.status(400).send({ error: "invalid query" });
    }
  });

  app.get("/facts/search", async (request, reply) => {
    try {
      const query = parseFactSearchQuery((request.query as Record<string, unknown>) ?? {});
      return store.searchFacts(query);
    } catch {
      return reply.status(400).send({ error: "invalid query" });
    }
  });

  app.get("/facts/claims/:id", async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    if (!params.success) {
      return reply.status(400).send({ error: "invalid id" });
    }
    const claim = await store.getFactClaimById(params.data.id);
    if (!claim) {
      return reply.status(404).send({ error: "claim not found" });
    }
    return claim;
  });

  app.post("/facts/claims/:id/revise", async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    const body = reviseFactClaimInputSchema.safeParse(request.body);
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: "invalid request" });
    }
    try {
      const claim = await store.reviseFactClaim(params.data.id, body.data);
      return reply.status(200).send(claim);
    } catch (error) {
      return reply.status(404).send({ error: error instanceof Error ? error.message : "claim not found" });
    }
  });

  app.post("/facts/claims/:id/retract", async (request, reply) => {
    const params = z.object({ id: z.string() }).safeParse(request.params);
    const body = retractFactClaimInputSchema.safeParse(request.body ?? {});
    if (!params.success || !body.success) {
      return reply.status(400).send({ error: "invalid request" });
    }
    try {
      const claim = await store.retractFactClaim(params.data.id, body.data);
      return reply.status(200).send(claim);
    } catch (error) {
      return reply.status(404).send({ error: error instanceof Error ? error.message : "claim not found" });
    }
  });

  app.get("/facts/by-entry/:entryId", async (request, reply) => {
    const params = z.object({ entryId: z.string().uuid() }).safeParse(request.params);
    const query = z.object({ limit: z.coerce.number().int().min(1).max(500).optional() }).safeParse(request.query ?? {});
    if (!params.success || !query.success) {
      return reply.status(400).send({ error: "invalid request" });
    }
    return store.listFactsByEntry(params.data.entryId, query.data.limit);
  });

  app.get("/rollups", async (request, reply) => {
    try {
      const query = parseRollupQuery((request.query as Record<string, unknown>) ?? {});
      return store.listRollups(query);
    } catch {
      return reply.status(400).send({ error: "invalid query" });
    }
  });

  app.post("/rollups/rebuild", async (request, reply) => {
    const body = rebuildRollupsInputSchema.safeParse(request.body);
    if (!body.success) {
      return reply.status(400).send({ error: "invalid body", detail: body.error.issues });
    }
    const rollups = await store.rebuildRollups(body.data);
    return reply.status(200).send(rollups);
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
