import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Pool, type QueryResultRow } from "pg";
import type {
  AnalysisEntryResult,
  AnalysisJob,
  AnalysisJobQuery,
  AnalysisJobStatus,
  AnalysisModel,
  CreateEntryInput,
  Entry,
  FactClaim,
  FactClaimDimension,
  FactClaimFeedback,
  FactSearchQuery,
  HistoryRecord,
  ListQuery,
  OpenAiCostSummary,
  OpenAiCostSummaryQuery,
  OpenAiRequestQuery,
  OpenAiRequestRecord,
  RebuildRollupsInput,
  Rollup,
  RollupQuery,
  RunAnalysisInput,
  RunAnalysisResult,
  SearchQuery,
  SearchResult,
} from "../lib/schemas.js";
import {
  analysisEntryResultSchema,
  analysisJobItemSchema,
  analysisJobQuerySchema,
  analysisJobSchema,
  createEntryInputSchema,
  entrySchema,
  factClaimDimensionSchema,
  factClaimFeedbackSchema,
  factClaimSchema,
  factSearchQuerySchema,
  openAiCostBucketSchema,
  openAiCostSummarySchema,
  openAiRequestQuerySchema,
  openAiRequestRecordSchema,
  rebuildRollupsInputSchema,
  rollupQuerySchema,
  rollupSchema,
  runAnalysisInputSchema,
  runAnalysisResultSchema,
  validatePayload,
  type AnalysisReasoningEffort,
} from "../lib/schemas.js";
import { filterEntries, newId, nowUtcIso, searchEntries as rankSearch } from "../lib/utils.js";
import type { DataStore } from "./store.js";

const execFile = promisify(execFileCb);

const SECRET_PATTERNS = [
  /\bsk-[A-Za-z0-9]{20,}\b/g,
  /\b(?:api[_-]?key|secret|token|password|passwd)\b\s*[:=]\s*['"]?[A-Za-z0-9_\-]{12,}/gi,
];
const EMAIL_RE = /\b[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}\b/g;
const PHONE_RE = /\+?\d[\d\-()\s]{8,}\d/g;
const POSTAL_RE = /\b\d{3}-\d{4}\b/g;

const DEFAULT_ANALYSIS_MODEL_IDS = [
  "gpt-5",
  "gpt-5.1",
  "gpt-5.2",
  "gpt-5-mini",
  "gpt-5-nano",
  "gpt-4.1",
  "gpt-4.1-mini",
  "gpt-4.1-nano",
  "gpt-4o",
  "gpt-4o-mini",
] as const;

function isReasoningCapableModel(model: string): boolean {
  const normalized = model.toLowerCase().trim();
  return normalized.startsWith("o") || normalized.startsWith("gpt-5");
}

function resolveAnalysisModelIds(): string[] {
  const configured = process.env.BRAIN_DOCK_ANALYSIS_MODELS;
  if (!configured) {
    return [...DEFAULT_ANALYSIS_MODEL_IDS];
  }
  const ids = configured
    .split(",")
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  return ids.length > 0 ? ids : [...DEFAULT_ANALYSIS_MODEL_IDS];
}

function toModelLabel(modelId: string): string {
  return modelId.toUpperCase().replace(/MINI/g, "mini").replace(/NANO/g, "nano");
}

function buildAnalysisModels(): AnalysisModel[] {
  const models: AnalysisModel[] = [];
  const used = new Set<string>();
  for (const modelId of resolveAnalysisModelIds()) {
    if (used.has(modelId)) {
      continue;
    }
    used.add(modelId);
    const supportsReasoningEffort = isReasoningCapableModel(modelId);
    models.push({
      id: modelId,
      label: toModelLabel(modelId),
      supportsReasoningEffort,
      defaultReasoningEffort: supportsReasoningEffort ? "low" : "none",
    });
  }
  return models;
}

const ANALYSIS_MODELS: AnalysisModel[] = buildAnalysisModels();

function normalizeLegacyType(rawType: unknown): Entry["declaredType"] {
  if (rawType === "journal" || rawType === "todo" || rawType === "learning" || rawType === "thought" || rawType === "meeting") {
    return rawType;
  }
  throw new Error(`unsupported declared_type in app_entries: ${String(rawType)}`);
}

function normalizeLegacyPayload(type: Entry["declaredType"], payload: unknown, body?: string): Record<string, unknown> {
  const rowPayload = (payload as Record<string, unknown>) ?? {};
  if (type !== "thought") {
    return rowPayload;
  }
  if (typeof rowPayload.note === "string" && rowPayload.note.trim()) {
    return rowPayload;
  }
  const merged = [typeof rowPayload.item === "string" ? rowPayload.item : "", body ?? ""].filter(Boolean).join(" / ");
  return { note: merged || "legacy thought entry" };
}

function toSafeInt(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return Math.trunc(parsed);
    }
  }
  return 0;
}

function toSafeNumber(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return 0;
}

function toUtcIsoFromPgTimestamp(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "string") {
    const normalized = /z$/i.test(value) || /[+-]\d{2}:\d{2}$/.test(value) ? value : `${value}Z`;
    return new Date(normalized).toISOString();
  }
  return new Date(String(value)).toISOString();
}

function mapJobItemToEntryAnalysisState(status?: string): Entry["analysisState"] {
  switch (status) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "succeeded":
      return "succeeded";
    case "failed":
      return "failed";
    case "blocked":
      return "blocked";
    default:
      return "not_requested";
  }
}

function toEntry(row: QueryResultRow, analysisStatus?: string): Entry {
  const normalizedType = normalizeLegacyType(row.declared_type);
  const body = row.body ?? undefined;
  return entrySchema.parse({
    id: row.id,
    declaredType: normalizedType,
    title: row.title ?? undefined,
    body,
    tags: Array.isArray(row.tags) ? row.tags : [],
    occurredAtUtc: new Date(row.occurred_at_utc).toISOString(),
    sensitivity: row.sensitivity,
    createdAtUtc: new Date(row.created_at).toISOString(),
    updatedAtUtc: new Date(row.updated_at).toISOString(),
    analysisState: mapJobItemToEntryAnalysisState(analysisStatus ?? row.analysis_state),
    latestAnalysisJobId: row.latest_analysis_job_id ?? undefined,
    analysisStatus: analysisStatus as Entry["analysisStatus"] | undefined,
    payload: normalizeLegacyPayload(normalizedType, row.payload, body),
  });
}

function toOpenAiRequest(row: QueryResultRow): OpenAiRequestRecord {
  return openAiRequestRecordSchema.parse({
    id: row.id,
    createdAtUtc: new Date(row.created_at).toISOString(),
    requestStartedAtUtc: new Date(row.request_started_at).toISOString(),
    requestFinishedAtUtc: row.request_finished_at ? new Date(row.request_finished_at).toISOString() : undefined,
    status: row.status,
    environment: row.environment,
    endpoint: row.endpoint,
    model: row.model,
    operation: row.operation ?? undefined,
    workflow: row.workflow ?? undefined,
    correlationId: row.correlation_id ?? undefined,
    actor: row.actor,
    sourceRefType: row.source_ref_type,
    sourceRefId: row.source_ref_id ?? undefined,
    openaiRequestId: row.openai_request_id ?? undefined,
    inputTokens: toSafeInt(row.input_tokens),
    cachedInputTokens: toSafeInt(row.cached_input_tokens),
    outputTokens: toSafeInt(row.output_tokens),
    reasoningOutputTokens: toSafeInt(row.reasoning_output_tokens),
    totalTokens: toSafeInt(row.total_tokens),
    inputChars: row.input_chars == null ? undefined : toSafeInt(row.input_chars),
    outputChars: row.output_chars == null ? undefined : toSafeInt(row.output_chars),
    requestCostUsd: toSafeNumber(row.request_cost_usd),
    costSource: row.cost_source,
    errorType: row.error_type ?? undefined,
    errorMessage: row.error_message ?? undefined,
  });
}

function toFactDimension(row: QueryResultRow): FactClaimDimension {
  return factClaimDimensionSchema.parse({
    id: row.id,
    claimId: row.claim_id,
    dimensionType: row.dimension_type,
    dimensionValue: row.dimension_value,
    normalizedValue: row.normalized_value,
    confidence: toSafeNumber(row.confidence),
    source: row.source,
    createdAtUtc: toUtcIsoFromPgTimestamp(row.created_at),
  });
}

function toFactFeedback(row: QueryResultRow): FactClaimFeedback {
  return factClaimFeedbackSchema.parse({
    id: row.id,
    claimId: row.claim_id,
    action: row.action,
    actor: row.actor,
    beforeJson: JSON.stringify(row.before_json),
    afterJson: JSON.stringify(row.after_json),
    createdAtUtc: toUtcIsoFromPgTimestamp(row.created_at),
  });
}

function toFactClaim(
  row: QueryResultRow,
  evidenceSpans: QueryResultRow[] = [],
  dimensions: QueryResultRow[] = [],
  feedback: QueryResultRow[] = [],
): FactClaim {
  return factClaimSchema.parse({
    id: row.id,
    documentId: row.document_id,
    entryId: row.entry_id,
    extractionId: row.extraction_id ?? undefined,
    subjectText: row.subject_text,
    subjectEntityId: row.subject_entity_id ?? undefined,
    predicate: row.predicate,
    objectTextRaw: row.object_text_raw ?? row.object_text,
    objectTextCanonical: row.object_text_canonical ?? row.object_text,
    objectEntityId: row.object_entity_id ?? undefined,
    meRole: row.me_role ?? "none",
    modality: row.modality,
    polarity: row.polarity,
    certainty: toSafeNumber(row.certainty),
    qualityScore: row.quality_score == null ? toSafeNumber(row.certainty) : toSafeNumber(row.quality_score),
    qualityFlags: Array.isArray(row.quality_flags) ? row.quality_flags : [],
    revisionNote: row.revision_note ?? undefined,
    timeStartUtc: row.time_start_utc ? toUtcIsoFromPgTimestamp(row.time_start_utc) : undefined,
    timeEndUtc: row.time_end_utc ? toUtcIsoFromPgTimestamp(row.time_end_utc) : undefined,
    status: row.status,
    extractorVersion: row.extractor_version ?? "llm-gpt-4.1-mini",
    createdAtUtc: toUtcIsoFromPgTimestamp(row.created_at),
    updatedAtUtc: toUtcIsoFromPgTimestamp(row.updated_at),
    evidenceSpans: evidenceSpans.map((span) => ({
      id: span.id,
      claimId: span.claim_id,
      documentId: span.document_id,
      charStart: span.char_start == null ? undefined : toSafeInt(span.char_start),
      charEnd: span.char_end == null ? undefined : toSafeInt(span.char_end),
      excerpt: span.excerpt,
      createdAtUtc: toUtcIsoFromPgTimestamp(span.created_at),
    })),
    dimensions: dimensions.map(toFactDimension),
    feedback: feedback.map(toFactFeedback),
  });
}

function isMissingRelationError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return "code" in error && (error as { code?: string }).code === "42P01";
}

function estimatePiiScore(text: string): number {
  let score = 0;
  for (const pattern of SECRET_PATTERNS) {
    if (pattern.test(text)) {
      score = Math.max(score, 0.95);
    }
  }
  if (EMAIL_RE.test(text)) {
    score = Math.max(score, 0.55);
  }
  if (PHONE_RE.test(text)) {
    score = Math.max(score, 0.65);
  }
  if (POSTAL_RE.test(text)) {
    score = Math.max(score, 0.7);
  }
  return Math.min(score, 1);
}

function redactionStateFromPii(piiScore: number): "none" | "masked" | "blocked" {
  if (piiScore >= 0.9) {
    return "blocked";
  }
  if (piiScore >= 0.5) {
    return "masked";
  }
  return "none";
}

function resolveRepoRoot(): string {
  if (process.env.BRAIN_DOCK_ROOT) {
    return path.resolve(process.env.BRAIN_DOCK_ROOT);
  }
  const cwd = process.cwd();
  const workerFromCwd = path.resolve(cwd, "apps/worker/extract_claims_llm.py");
  if (existsSync(workerFromCwd)) {
    return cwd;
  }
  const fromApiPackage = path.resolve(cwd, "../..");
  const workerFromApi = path.resolve(fromApiPackage, "apps/worker/extract_claims_llm.py");
  if (existsSync(workerFromApi)) {
    return fromApiPackage;
  }
  return fromApiPackage;
}

type WorkerJson = Record<string, unknown>;

function mapCaptureInputType(entry: Entry): "task" | "note" | "url" | "quick" {
  if (entry.declaredType === "todo") {
    return "task";
  }
  if (entry.declaredType === "learning" && typeof entry.payload.url === "string" && entry.payload.url.length > 0) {
    return "url";
  }
  return "note";
}

function buildCaptureRawText(entry: Entry): string {
  const parts: string[] = [];
  if (entry.title) {
    parts.push(entry.title);
  }
  if (entry.body) {
    parts.push(entry.body);
  }
  for (const [key, value] of Object.entries(entry.payload as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      if (value.length > 0) {
        parts.push(`${key}: ${value.join(" / ")}`);
      }
      continue;
    }
    if (value === undefined || value === null || value === "") {
      continue;
    }
    parts.push(`${key}: ${String(value)}`);
  }
  return parts.join("\n").slice(0, 10000);
}

function normalizeReasoningEffort(model: string, effort: AnalysisReasoningEffort): AnalysisReasoningEffort {
  return isReasoningCapableModel(model) ? effort : "none";
}

export class PgStore implements DataStore {
  constructor(
    private readonly pool: Pool,
    private readonly dsn: string,
  ) {}

  kind(): "postgres" {
    return "postgres";
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async runWorkerScript(scriptName: "extract_claims_llm.py", args: string[]): Promise<WorkerJson> {
    const repoRoot = resolveRepoRoot();
    const scriptPath = path.resolve(repoRoot, "apps/worker", scriptName);
    const python = process.env.BRAIN_DOCK_PYTHON ?? "python3";
    const timeout = Number(process.env.BRAIN_DOCK_ANALYSIS_TIMEOUT_MS ?? 180000);
    const { stdout, stderr } = await execFile(
      python,
      [scriptPath, "--backend", "neon", "--neon-dsn", this.dsn, ...args],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          NEON_DATABASE_URL: this.dsn,
        },
        timeout,
        maxBuffer: 8 * 1024 * 1024,
      },
    );

    const lastLine = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1);
    if (!lastLine) {
      throw new Error(`worker output is empty: ${scriptName}; stderr=${stderr || ""}`);
    }
    try {
      const parsed = JSON.parse(lastLine) as WorkerJson;
      if (!parsed || typeof parsed !== "object") {
        throw new Error("worker json output is not object");
      }
      return parsed;
    } catch (error) {
      throw new Error(
        `worker output parse failed (${scriptName}): ${error instanceof Error ? error.message : String(error)}; stdout=${lastLine}; stderr=${stderr || ""}`,
      );
    }
  }

  private async getEntryById(entryId: string): Promise<Entry | null> {
    const row = await this.pool.query("select * from public.app_entries where id = $1", [entryId]);
    if (!row.rowCount) {
      return null;
    }
    return toEntry(row.rows[0]);
  }

  private async ensureCaptureForEntry(client: Pool | any, entry: Entry): Promise<{ captureId: string; piiScore: number }> {
    const captureText = buildCaptureRawText(entry);
    const piiScore = estimatePiiScore(captureText);
    const found = await client.query(
      `
      select id, pii_score
      from public.captures_raw
      where id = $1
         or (source_id = 'source-web-api' and raw_text = $2 and occurred_at = $3::timestamptz)
      order by created_at desc
      limit 1
      `,
      [entry.id, captureText, entry.occurredAtUtc],
    );
    if (found.rowCount) {
      const row = found.rows[0];
      return {
        captureId: String(row.id),
        piiScore: Math.max(piiScore, toSafeNumber(row.pii_score)),
      };
    }

    await client.query(
      `
      insert into public.sources (id, kind, detail, created_at)
      values ('source-web-api', 'web_ui', 'apps/api', now())
      on conflict (id) do nothing
      `,
    );
    await client.query(
      `
      insert into public.captures_raw (
        id, source_id, input_type, raw_text, occurred_at, sensitivity, pii_score, status, created_at, updated_at
      ) values ($1, 'source-web-api', $2, $3, $4::timestamptz, $5, $6, 'new', now(), now())
      `,
      [entry.id, mapCaptureInputType(entry), captureText, entry.occurredAtUtc, entry.sensitivity, piiScore],
    );
    return {
      captureId: entry.id,
      piiScore,
    };
  }

  private async ensureFactDocumentForEntry(client: Pool | any, entry: Entry, captureId: string, piiScore: number): Promise<string> {
    const existing = await client.query(
      `
      select id
      from public.fact_documents
      where entry_id = $1
      limit 1
      `,
      [entry.id],
    );
    if (existing.rowCount) {
      const existingId = String(existing.rows[0].id);
      await client.query(
        `
        update public.fact_documents
        set capture_id = $2,
            declared_type = $3,
            raw_text = $4,
            occurred_at_utc = $5::timestamptz,
            sensitivity = $6,
            pii_score = $7,
            redaction_state = $8,
            normalized_text = $9,
            token_count = $10,
            language = $11,
            analysis_state = 'ready',
            updated_at = now()
        where id = $1
        `,
        [
          existingId,
          captureId,
          entry.declaredType,
          buildCaptureRawText(entry),
          entry.occurredAtUtc,
          entry.sensitivity,
          piiScore,
          redactionStateFromPii(piiScore),
          (entry.body ?? "").toLowerCase(),
          (entry.body ?? "").length,
          "ja",
        ],
      );
      return existingId;
    }

    await client.query(
      `
      insert into public.fact_documents (
        id, entry_id, capture_id, declared_type, raw_text, occurred_at_utc,
        sensitivity, pii_score, redaction_state, language, normalized_text, token_count,
        analysis_state, created_at, updated_at
      ) values (
        $1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, $10, $11, $12, 'ready', now(), now()
      )
      `,
      [
        entry.id,
        entry.id,
        captureId,
        entry.declaredType,
        buildCaptureRawText(entry),
        entry.occurredAtUtc,
        entry.sensitivity,
        piiScore,
        redactionStateFromPii(piiScore),
        "ja",
        (entry.body ?? "").toLowerCase(),
        (entry.body ?? "").length,
      ],
    );
    return entry.id;
  }

  private async loadEntryAnalysisStatusMap(entryIds: string[]): Promise<Map<string, Entry["analysisStatus"]>> {
    const map = new Map<string, Entry["analysisStatus"]>();
    if (entryIds.length === 0) {
      return map;
    }
    try {
      const rows = await this.pool.query(
        `
        select distinct on (entry_id) entry_id, status
        from public.fact_extraction_job_items
        where entry_id = any($1::text[])
        order by entry_id, updated_at desc
        `,
        [entryIds],
      );
      for (const row of rows.rows) {
        map.set(String(row.entry_id), row.status as Entry["analysisStatus"]);
      }
      return map;
    } catch (error) {
      if (isMissingRelationError(error)) {
        return map;
      }
      throw error;
    }
  }

  private async hydrateClaims(rows: QueryResultRow[]): Promise<FactClaim[]> {
    if (rows.length === 0) {
      return [];
    }
    const claimIds = rows.map((row) => String(row.id));

    const [spansRes, dimensionsRes, feedbackRes] = await Promise.all([
      this.pool.query(
        `
        select *
        from public.fact_evidence_spans
        where claim_id = any($1::text[])
        order by created_at asc
        `,
        [claimIds],
      ),
      this.pool.query(
        `
        select *
        from public.fact_claim_dimensions
        where claim_id = any($1::text[])
        order by created_at asc
        `,
        [claimIds],
      ),
      this.pool.query(
        `
        select *
        from public.fact_claim_feedback
        where claim_id = any($1::text[])
        order by created_at desc
        `,
        [claimIds],
      ),
    ]);

    const spansByClaim = new Map<string, QueryResultRow[]>();
    for (const span of spansRes.rows) {
      const key = String(span.claim_id);
      const list = spansByClaim.get(key) ?? [];
      list.push(span);
      spansByClaim.set(key, list);
    }

    const dimensionsByClaim = new Map<string, QueryResultRow[]>();
    for (const dimension of dimensionsRes.rows) {
      const key = String(dimension.claim_id);
      const list = dimensionsByClaim.get(key) ?? [];
      list.push(dimension);
      dimensionsByClaim.set(key, list);
    }

    const feedbackByClaim = new Map<string, QueryResultRow[]>();
    for (const feedback of feedbackRes.rows) {
      const key = String(feedback.claim_id);
      const list = feedbackByClaim.get(key) ?? [];
      list.push(feedback);
      feedbackByClaim.set(key, list);
    }

    return rows.map((row) =>
      toFactClaim(
        row,
        spansByClaim.get(String(row.id)) ?? [],
        dimensionsByClaim.get(String(row.id)) ?? [],
        feedbackByClaim.get(String(row.id)) ?? [],
      ),
    );
  }

  async createEntry(input: CreateEntryInput): Promise<Entry> {
    const parsed = createEntryInputSchema.parse(input);
    const payload = validatePayload(parsed.declaredType, parsed.payload);
    const now = nowUtcIso();
    const id = parsed.id ?? newId();
    const entry = entrySchema.parse({
      id,
      declaredType: parsed.declaredType,
      title: parsed.title,
      body: parsed.body,
      tags: parsed.tags,
      occurredAtUtc: parsed.occurredAtUtc,
      sensitivity: parsed.sensitivity,
      createdAtUtc: now,
      updatedAtUtc: now,
      analysisState: "not_requested",
      payload,
    });

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `
        insert into public.app_entries (
          id, declared_type, title, body, tags, occurred_at_utc, sensitivity,
          payload, sync_status, remote_id, analysis_state, latest_analysis_job_id, created_at, updated_at
        ) values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, $7, $8::jsonb, 'synced', $1, 'not_requested', null, now(), now())
        `,
        [
          entry.id,
          entry.declaredType,
          entry.title ?? null,
          entry.body ?? null,
          JSON.stringify(entry.tags),
          entry.occurredAtUtc,
          entry.sensitivity,
          JSON.stringify(entry.payload),
        ],
      );

      const capture = await this.ensureCaptureForEntry(client, entry);
      await this.ensureFactDocumentForEntry(client, entry, capture.captureId, capture.piiScore);

      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    return entry;
  }

  async listEntries(query?: ListQuery): Promise<Entry[]> {
    const rows = await this.pool.query("select * from public.app_entries order by occurred_at_utc desc limit 1000");
    const statusMap = await this.loadEntryAnalysisStatusMap(rows.rows.map((row) => String(row.id)));
    return filterEntries(
      rows.rows.map((row) => toEntry(row, statusMap.get(String(row.id)))),
      query,
    );
  }

  async searchEntries(query: SearchQuery): Promise<SearchResult[]> {
    const entries = await this.listEntries(query);
    return rankSearch(entries, query.text);
  }

  async listHistory(entryId?: string): Promise<HistoryRecord[]> {
    const rows = entryId
      ? await this.pool.query(
          "select * from public.app_history where entry_id = $1 order by created_at desc limit 1000",
          [entryId],
        )
      : await this.pool.query("select * from public.app_history order by created_at desc limit 1000");

    return rows.rows.map((row) => ({
      id: row.id,
      entryId: row.entry_id,
      source: row.source,
      beforeJson: JSON.stringify(row.before_json),
      afterJson: JSON.stringify(row.after_json),
      createdAtUtc: new Date(row.created_at).toISOString(),
    }));
  }

  async listOpenAiRequests(query?: OpenAiRequestQuery): Promise<OpenAiRequestRecord[]> {
    const parsed = openAiRequestQuerySchema.parse(query ?? {});
    try {
      const rows = await this.pool.query(
        `
      SELECT
        id,
        created_at,
        request_started_at,
        request_finished_at,
        status,
        environment,
        endpoint,
        model,
        operation,
        workflow,
        correlation_id,
        actor,
        source_ref_type,
        source_ref_id,
        openai_request_id,
        input_tokens,
        cached_input_tokens,
        output_tokens,
        reasoning_output_tokens,
        total_tokens,
        input_chars,
        output_chars,
        request_cost_usd,
        cost_source,
        error_type,
        error_message
      FROM public.openai_api_requests
      WHERE ($1::timestamptz IS NULL OR created_at >= $1)
        AND ($2::timestamptz IS NULL OR created_at <= $2)
        AND ($3::text IS NULL OR status = $3)
        AND ($4::text IS NULL OR model = $4)
        AND ($5::text IS NULL OR operation = $5)
        AND ($6::text IS NULL OR workflow = $6)
      ORDER BY request_started_at DESC, created_at DESC
      LIMIT $7
      `,
        [
          parsed.fromUtc ?? null,
          parsed.toUtc ?? null,
          parsed.status ?? null,
          parsed.model ?? null,
          parsed.operation ?? null,
          parsed.workflow ?? null,
          parsed.limit ?? 200,
        ],
      );
      return rows.rows.map(toOpenAiRequest);
    } catch (error) {
      if (isMissingRelationError(error)) {
        return [];
      }
      throw error;
    }
  }

  async getOpenAiCostSummary(query: OpenAiCostSummaryQuery): Promise<OpenAiCostSummary> {
    const period = query.period;
    const fromUtc = query.fromUtc ?? null;
    const toUtc = query.toUtc ?? null;
    const limit = query.limit ?? 90;

    try {
      const bucketsResult = await this.pool.query(
        `
      SELECT
        date_trunc($1::text, created_at AT TIME ZONE 'UTC') AS period_start_utc,
        count(*)::int AS request_count,
        count(*) FILTER (WHERE status = 'ok')::int AS ok_count,
        count(*) FILTER (WHERE status <> 'ok')::int AS error_count,
        coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
        coalesce(sum(cached_input_tokens), 0)::bigint AS cached_input_tokens,
        coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
        coalesce(sum(total_tokens), 0)::bigint AS total_tokens,
        coalesce(sum(request_cost_usd), 0)::numeric AS total_cost_usd
      FROM public.openai_api_requests
      WHERE ($2::timestamptz IS NULL OR created_at >= $2)
        AND ($3::timestamptz IS NULL OR created_at <= $3)
      GROUP BY 1
      ORDER BY 1 DESC
      LIMIT $4
      `,
        [period, fromUtc, toUtc, limit],
      );

      const totalsResult = await this.pool.query(
        `
      SELECT
        count(*)::int AS request_count,
        count(*) FILTER (WHERE status = 'ok')::int AS ok_count,
        count(*) FILTER (WHERE status <> 'ok')::int AS error_count,
        coalesce(sum(input_tokens), 0)::bigint AS input_tokens,
        coalesce(sum(cached_input_tokens), 0)::bigint AS cached_input_tokens,
        coalesce(sum(output_tokens), 0)::bigint AS output_tokens,
        coalesce(sum(total_tokens), 0)::bigint AS total_tokens,
        coalesce(sum(request_cost_usd), 0)::numeric AS total_cost_usd
      FROM public.openai_api_requests
      WHERE ($1::timestamptz IS NULL OR created_at >= $1)
        AND ($2::timestamptz IS NULL OR created_at <= $2)
      `,
        [fromUtc, toUtc],
      );

      const buckets = bucketsResult.rows.map((row) =>
        openAiCostBucketSchema.parse({
          period,
          periodStartUtc: toUtcIsoFromPgTimestamp(row.period_start_utc),
          requestCount: toSafeInt(row.request_count),
          okCount: toSafeInt(row.ok_count),
          errorCount: toSafeInt(row.error_count),
          inputTokens: toSafeInt(row.input_tokens),
          cachedInputTokens: toSafeInt(row.cached_input_tokens),
          outputTokens: toSafeInt(row.output_tokens),
          totalTokens: toSafeInt(row.total_tokens),
          totalCostUsd: toSafeNumber(row.total_cost_usd),
        }),
      );

      const totalRow = totalsResult.rows[0] ?? {};
      return openAiCostSummarySchema.parse({
        period,
        fromUtc: query.fromUtc,
        toUtc: query.toUtc,
        totals: {
          requestCount: toSafeInt(totalRow.request_count),
          okCount: toSafeInt(totalRow.ok_count),
          errorCount: toSafeInt(totalRow.error_count),
          inputTokens: toSafeInt(totalRow.input_tokens),
          cachedInputTokens: toSafeInt(totalRow.cached_input_tokens),
          outputTokens: toSafeInt(totalRow.output_tokens),
          totalTokens: toSafeInt(totalRow.total_tokens),
          totalCostUsd: toSafeNumber(totalRow.total_cost_usd),
        },
        buckets,
      });
    } catch (error) {
      if (isMissingRelationError(error)) {
        return openAiCostSummarySchema.parse({
          period,
          fromUtc: query.fromUtc,
          toUtc: query.toUtc,
          totals: {
            requestCount: 0,
            okCount: 0,
            errorCount: 0,
            inputTokens: 0,
            cachedInputTokens: 0,
            outputTokens: 0,
            totalTokens: 0,
            totalCostUsd: 0,
          },
          buckets: [],
        });
      }
      throw error;
    }
  }

  async getAnalysisModels(): Promise<AnalysisModel[]> {
    return ANALYSIS_MODELS;
  }

  async runAnalysisForEntries(input: RunAnalysisInput): Promise<RunAnalysisResult> {
    const parsed = runAnalysisInputSchema.parse(input);
    const llmModel = parsed.llmModel ?? process.env.BRAIN_DOCK_LLM_MODEL ?? "gpt-4.1-mini";
    const reasoningEffort = normalizeReasoningEffort(llmModel, parsed.reasoningEffort ?? "none");

    const results: AnalysisEntryResult[] = [];
    const jobId = newId();

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `
        insert into public.fact_extraction_jobs (
          id, trigger_mode, status, requested_by, extractor_version, requested_at, total_items
        ) values ($1, 'manual', 'queued', 'user', $2, now(), $3)
        `,
        [jobId, `llm-${llmModel}-r:${reasoningEffort}`, parsed.entryIds.length],
      );

      for (const entryId of parsed.entryIds) {
        await client.query(
          `
          insert into public.fact_extraction_job_items (
            id, job_id, entry_id, status, attempt_count, created_at, updated_at
          ) values ($1, $2, $3, 'queued', 0, now(), now())
          `,
          [newId(), jobId, entryId],
        );
        await client.query(
          `
          update public.app_entries
          set analysis_state = 'queued', latest_analysis_job_id = $2, updated_at = now()
          where id = $1
          `,
          [entryId, jobId],
        );
      }

      await client.query(
        "update public.fact_extraction_jobs set status='running', started_at=now() where id = $1",
        [jobId],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    const jobItemsRows = await this.pool.query(
      "select * from public.fact_extraction_job_items where job_id = $1 order by created_at asc",
      [jobId],
    );
    const itemByEntry = new Map<string, QueryResultRow>();
    for (const row of jobItemsRows.rows) {
      itemByEntry.set(String(row.entry_id), row);
    }

    let succeeded = 0;
    let failed = 0;

    for (const entryId of parsed.entryIds) {
      const item = itemByEntry.get(entryId);
      if (!item) {
        failed += 1;
        results.push(
          analysisEntryResultSchema.parse({
            entryId,
            status: "error",
            message: "job item not found",
          }),
        );
        continue;
      }

      const extractionId = newId();
      try {
        const entry = await this.getEntryById(entryId);
        if (!entry) {
          failed += 1;
          await this.pool.query(
            "update public.fact_extraction_job_items set status='failed', last_error=$2, updated_at=now() where id=$1",
            [item.id, "entry not found"],
          );
          await this.pool.query(
            "update public.app_entries set analysis_state='failed', updated_at=now() where id=$1",
            [entryId],
          );
          results.push(
            analysisEntryResultSchema.parse({
              entryId,
              jobItemId: item.id,
              status: "error",
              message: "entry not found",
              extractionId,
              model: llmModel,
              reasoningEffort,
              errorCode: "entry_not_found",
              errorSummary: "entry not found",
            }),
          );
          continue;
        }

        await this.pool.query(
          "update public.fact_extraction_job_items set status='running', attempt_count=attempt_count+1, updated_at=now() where id=$1",
          [item.id],
        );
        await this.pool.query(
          "update public.app_entries set analysis_state='running', latest_analysis_job_id=$2, updated_at=now() where id=$1",
          [entry.id, jobId],
        );

        const capture = await this.ensureCaptureForEntry(this.pool, entry);
        const documentId = await this.ensureFactDocumentForEntry(this.pool, entry, capture.captureId, capture.piiScore);

        await this.pool.query(
          "update public.fact_extraction_job_items set document_id=$2, updated_at=now() where id=$1",
          [item.id, documentId],
        );

        await this.pool.query(
          `
          insert into public.fact_extractions (
            id, document_id, entry_id, job_id, job_item_id, model, reasoning_effort,
            schema_version, prompt_version, status, started_at, created_at, updated_at
          ) values ($1, $2, $3, $4, $5, $6, $7, 'v2', 'v2', 'running', now(), now(), now())
          `,
          [extractionId, documentId, entry.id, jobId, item.id, llmModel, reasoningEffort],
        );

        const workerArgs = [
          "--entry-id",
          entry.id,
          "--document-id",
          documentId,
          "--job-id",
          jobId,
          "--job-item-id",
          item.id,
          "--attempt-count",
          String(toSafeInt(item.attempt_count) + 1),
          "--llm-model",
          llmModel,
          "--llm-reasoning-effort",
          reasoningEffort,
          "--extraction-id",
          extractionId,
        ];
        if (parsed.replaceExisting) {
          workerArgs.push("--replace-existing");
        }

        const workerResult = await this.runWorkerScript("extract_claims_llm.py", workerArgs);
        const workerStatus = String(workerResult.status ?? "failed");
        const claimsInserted = toSafeInt(workerResult.claims_inserted);
        const attemptCount = toSafeInt(workerResult.attempt_count) || toSafeInt(item.attempt_count) + 1;
        const nextRetryAt = workerResult.next_retry_at ? String(workerResult.next_retry_at) : null;
        const errorText = workerResult.error ? String(workerResult.error) : null;
        const requestTokensIn = toSafeInt(workerResult.request_tokens_in);
        const requestTokensOut = toSafeInt(workerResult.request_tokens_out);
        const requestCostUsd = toSafeNumber(workerResult.request_cost_usd);
        const errorCode = workerResult.error_code ? String(workerResult.error_code) : null;

        if (workerStatus === "succeeded") {
          succeeded += 1;
          await this.pool.query(
            `
            update public.fact_extraction_job_items
            set status='succeeded', claims_inserted=$2, last_error=null, next_retry_at=null, attempt_count=$3, updated_at=now()
            where id=$1
            `,
            [item.id, claimsInserted, attemptCount],
          );
          await this.pool.query(
            "update public.app_entries set analysis_state='succeeded', latest_analysis_job_id=$2, updated_at=now() where id=$1",
            [entry.id, jobId],
          );
          await this.pool.query(
            "update public.fact_documents set analysis_state='ready', last_analyzed_at=now(), updated_at=now() where id=$1",
            [documentId],
          );
          await this.pool.query(
            `
            update public.fact_extractions
            set status='succeeded', request_tokens_in=$2, request_tokens_out=$3, request_cost_usd=$4,
                error_code=null, error_summary=null, finished_at=now(), updated_at=now()
            where id=$1
            `,
            [extractionId, requestTokensIn, requestTokensOut, requestCostUsd],
          );
        } else if (workerStatus === "blocked") {
          failed += 1;
          await this.pool.query(
            `
            update public.fact_extraction_job_items
            set status='blocked', claims_inserted=$2, last_error=$3, next_retry_at=null, attempt_count=$4, updated_at=now()
            where id=$1
            `,
            [item.id, claimsInserted, errorText ?? "blocked_sensitive", attemptCount],
          );
          await this.pool.query(
            "update public.app_entries set analysis_state='blocked', latest_analysis_job_id=$2, updated_at=now() where id=$1",
            [entry.id, jobId],
          );
          await this.pool.query(
            `
            update public.fact_extractions
            set status='blocked', request_tokens_in=$2, request_tokens_out=$3, request_cost_usd=$4,
                error_code=$5, error_summary=$6, finished_at=now(), updated_at=now()
            where id=$1
            `,
            [extractionId, requestTokensIn, requestTokensOut, requestCostUsd, errorCode, errorText ?? "blocked_sensitive"],
          );
        } else if (workerStatus === "queued") {
          failed += 1;
          await this.pool.query(
            `
            update public.fact_extraction_job_items
            set status='queued', claims_inserted=$2, last_error=$3, next_retry_at=$4::timestamptz, attempt_count=$5, updated_at=now()
            where id=$1
            `,
            [item.id, claimsInserted, errorText ?? "queued_retry", nextRetryAt, attemptCount],
          );
          await this.pool.query(
            "update public.app_entries set analysis_state='queued', latest_analysis_job_id=$2, updated_at=now() where id=$1",
            [entry.id, jobId],
          );
          await this.pool.query(
            `
            update public.fact_extractions
            set status='queued_retry', request_tokens_in=$2, request_tokens_out=$3, request_cost_usd=$4,
                error_code=$5, error_summary=$6, finished_at=now(), updated_at=now()
            where id=$1
            `,
            [extractionId, requestTokensIn, requestTokensOut, requestCostUsd, errorCode, errorText ?? "queued_retry"],
          );
        } else {
          failed += 1;
          await this.pool.query(
            `
            update public.fact_extraction_job_items
            set status='failed', claims_inserted=$2, last_error=$3, next_retry_at=null, attempt_count=$4, updated_at=now()
            where id=$1
            `,
            [item.id, claimsInserted, errorText ?? "analysis failed", attemptCount],
          );
          await this.pool.query(
            "update public.app_entries set analysis_state='failed', latest_analysis_job_id=$2, updated_at=now() where id=$1",
            [entry.id, jobId],
          );
          await this.pool.query(
            `
            update public.fact_extractions
            set status='failed', request_tokens_in=$2, request_tokens_out=$3, request_cost_usd=$4,
                error_code=$5, error_summary=$6, finished_at=now(), updated_at=now()
            where id=$1
            `,
            [extractionId, requestTokensIn, requestTokensOut, requestCostUsd, errorCode, errorText ?? "analysis failed"],
          );
        }

        results.push(
          analysisEntryResultSchema.parse({
            entryId,
            documentId,
            jobItemId: String(item.id),
            extractionId,
            status: workerStatus === "queued" ? "queued_retry" : workerStatus === "failed" ? "error" : workerStatus,
            message: errorText ?? (workerStatus === "succeeded" ? "analysis completed" : "analysis pending"),
            claimsInserted,
            attemptCount,
            model: llmModel,
            reasoningEffort,
            errorCode: errorCode ?? undefined,
            errorSummary: errorText ?? undefined,
            nextRetryAtUtc: nextRetryAt ?? undefined,
          }),
        );
      } catch (error) {
        failed += 1;
        await this.pool.query(
          `
          update public.fact_extraction_job_items
          set status='failed', last_error=$2, next_retry_at=null, attempt_count=attempt_count+1, updated_at=now()
          where id=$1
          `,
          [item.id, error instanceof Error ? error.message : "analysis failed"],
        );
        await this.pool.query(
          "update public.app_entries set analysis_state='failed', latest_analysis_job_id=$2, updated_at=now() where id=$1",
          [entryId, jobId],
        );
        await this.pool.query(
          `
          update public.fact_extractions
          set status='failed', error_code='runtime_error', error_summary=$2, finished_at=now(), updated_at=now()
          where id=$1
          `,
          [extractionId, error instanceof Error ? error.message : "analysis failed"],
        );

        results.push(
          analysisEntryResultSchema.parse({
            entryId,
            jobItemId: String(item.id),
            extractionId,
            status: "error",
            message: error instanceof Error ? error.message : "analysis failed",
            model: llmModel,
            reasoningEffort,
            errorCode: "runtime_error",
            errorSummary: error instanceof Error ? error.message : "analysis failed",
          }),
        );
      }
    }

    const finalStatus: AnalysisJobStatus = failed > 0 ? "failed" : "succeeded";
    await this.pool.query(
      `
      update public.fact_extraction_jobs
      set status=$2, finished_at=now(), succeeded_items=$3, failed_items=$4,
          error_summary=$5
      where id=$1
      `,
      [jobId, finalStatus, succeeded, failed, failed > 0 ? "one or more items failed" : null],
    );

    return runAnalysisResultSchema.parse({
      jobId,
      requested: parsed.entryIds.length,
      succeeded,
      failed,
      replaceExisting: parsed.replaceExisting,
      results,
    });
  }

  async listAnalysisJobs(query?: AnalysisJobQuery): Promise<AnalysisJob[]> {
    const parsed = analysisJobQuerySchema.parse(query ?? {});
    try {
      const rows = await this.pool.query(
        `
        select *
        from public.fact_extraction_jobs
        where ($1::text is null or status = $1)
        order by requested_at desc
        limit $2
        `,
        [parsed.status ?? null, parsed.limit ?? 50],
      );
      if (rows.rowCount === 0) {
        return [];
      }

      const jobIds = rows.rows.map((row) => row.id);
      const itemsRes = await this.pool.query(
        `
        select i.*, e.id as extraction_id, e.model, e.reasoning_effort, e.error_code, e.error_summary
        from public.fact_extraction_job_items i
        left join lateral (
          select *
          from public.fact_extractions x
          where x.job_item_id = i.id
          order by x.created_at desc
          limit 1
        ) e on true
        where i.job_id = any($1::text[])
        order by i.created_at asc
        `,
        [jobIds],
      );

      const itemsByJob = new Map<string, QueryResultRow[]>();
      for (const item of itemsRes.rows) {
        const jobId = String(item.job_id);
        const list = itemsByJob.get(jobId) ?? [];
        list.push(item);
        itemsByJob.set(jobId, list);
      }

      return rows.rows.map((row) =>
        analysisJobSchema.parse({
          id: row.id,
          triggerMode: row.trigger_mode,
          status: row.status,
          requestedBy: row.requested_by,
          extractorVersion: row.extractor_version,
          requestedAtUtc: toUtcIsoFromPgTimestamp(row.requested_at),
          startedAtUtc: row.started_at ? toUtcIsoFromPgTimestamp(row.started_at) : undefined,
          finishedAtUtc: row.finished_at ? toUtcIsoFromPgTimestamp(row.finished_at) : undefined,
          totalItems: toSafeInt(row.total_items),
          succeededItems: toSafeInt(row.succeeded_items),
          failedItems: toSafeInt(row.failed_items),
          errorSummary: row.error_summary ?? undefined,
          items: (itemsByJob.get(String(row.id)) ?? []).map((item) =>
            analysisJobItemSchema.parse({
              id: item.id,
              jobId: item.job_id,
              entryId: item.entry_id,
              documentId: item.document_id ?? undefined,
              extractionId: item.extraction_id ?? undefined,
              status: item.status === "queued" ? "queued_retry" : item.status,
              attemptCount: toSafeInt(item.attempt_count),
              claimsInserted: toSafeInt(item.claims_inserted),
              model: item.model ?? undefined,
              reasoningEffort: item.reasoning_effort ?? undefined,
              errorCode: item.error_code ?? undefined,
              errorSummary: item.error_summary ?? undefined,
              nextRetryAtUtc: item.next_retry_at ? toUtcIsoFromPgTimestamp(item.next_retry_at) : undefined,
              lastError: item.last_error ?? undefined,
              createdAtUtc: toUtcIsoFromPgTimestamp(item.created_at),
              updatedAtUtc: toUtcIsoFromPgTimestamp(item.updated_at),
            }),
          ),
        }),
      );
    } catch (error) {
      if (isMissingRelationError(error)) {
        return [];
      }
      throw error;
    }
  }

  async getAnalysisJob(jobId: string): Promise<AnalysisJob | null> {
    const rows = await this.listAnalysisJobs({ limit: 500 });
    return rows.find((job) => job.id === jobId) ?? null;
  }

  async searchFacts(query?: FactSearchQuery): Promise<FactClaim[]> {
    const parsed = factSearchQuerySchema.parse(query ?? {});
    try {
      const rows = await this.pool.query(
        `
        select distinct c.*, d.declared_type
        from public.fact_claims c
        join public.fact_documents d on d.id = c.document_id
        left join public.fact_claim_dimensions cd on cd.claim_id = c.id
        where c.deleted_at is null
          and ($1::text is null or c.subject_text ilike '%' || $1 || '%' or c.object_text_canonical ilike '%' || $1 || '%' or c.predicate ilike '%' || $1 || '%')
          and ($2::text is null or d.declared_type = $2)
          and ($3::text is null or c.modality = $3)
          and ($4::text is null or c.predicate = $4)
          and ($5::text is null or c.me_role = $5)
          and ($6::text is null or cd.dimension_type = $6)
          and ($7::text is null or cd.normalized_value ilike '%' || $7 || '%')
          and ($8::timestamptz is null or coalesce(c.time_start_utc, d.occurred_at_utc) >= $8)
          and ($9::timestamptz is null or coalesce(c.time_end_utc, c.time_start_utc, d.occurred_at_utc) <= $9)
        order by coalesce(c.time_start_utc, d.occurred_at_utc) desc, c.created_at desc
        limit $10
        `,
        [
          parsed.text ?? null,
          parsed.type ?? null,
          parsed.modality ?? null,
          parsed.predicate ?? null,
          parsed.meRole ?? null,
          parsed.dimensionType ?? null,
          parsed.dimensionValue ?? null,
          parsed.fromUtc ?? null,
          parsed.toUtc ?? null,
          parsed.limit ?? 100,
        ],
      );
      return this.hydrateClaims(rows.rows);
    } catch (error) {
      if (isMissingRelationError(error)) {
        return [];
      }
      throw error;
    }
  }

  async listFactsByEntry(entryId: string, limit = 100): Promise<FactClaim[]> {
    try {
      const rows = await this.pool.query(
        `
        select *
        from public.fact_claims
        where entry_id = $1 and deleted_at is null
        order by created_at desc
        limit $2
        `,
        [entryId, limit],
      );
      return this.hydrateClaims(rows.rows);
    } catch (error) {
      if (isMissingRelationError(error)) {
        return [];
      }
      throw error;
    }
  }

  async getFactClaimById(claimId: string): Promise<FactClaim | null> {
    const rows = await this.pool.query(
      `
      select *
      from public.fact_claims
      where id = $1 and deleted_at is null
      limit 1
      `,
      [claimId],
    );
    if (!rows.rowCount) {
      return null;
    }
    const hydrated = await this.hydrateClaims([rows.rows[0]]);
    return hydrated[0] ?? null;
  }

  async reviseFactClaim(claimId: string, input: { objectTextCanonical: string; revisionNote?: string }): Promise<FactClaim> {
    const now = nowUtcIso();
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const row = await client.query(
        "select * from public.fact_claims where id = $1 and deleted_at is null limit 1",
        [claimId],
      );
      if (!row.rowCount) {
        throw new Error("claim not found");
      }
      const prev = row.rows[0];
      const nextId = newId();

      await client.query(
        `
        update public.fact_claims
        set status='superseded', deleted_at=now(), updated_at=now()
        where id = $1
        `,
        [claimId],
      );

      await client.query(
        `
        insert into public.fact_claims (
          id, document_id, entry_id, extraction_id, subject_text, subject_entity_id,
          predicate, object_text, object_text_raw, object_text_canonical, object_entity_id,
          me_role, modality, polarity, certainty, quality_score, quality_flags,
          time_start_utc, time_end_utc, status, supersedes_claim_id,
          extractor_version, revision_note, created_at, updated_at
        ) values (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9, $10, $11,
          $12, $13, $14, $15, $16, $17::jsonb,
          $18, $19, 'active', $20,
          $21, $22, now(), now()
        )
        `,
        [
          nextId,
          prev.document_id,
          prev.entry_id,
          prev.extraction_id,
          prev.subject_text,
          prev.subject_entity_id,
          prev.predicate,
          input.objectTextCanonical,
          prev.object_text_raw ?? prev.object_text,
          input.objectTextCanonical,
          prev.object_entity_id,
          prev.me_role ?? "none",
          prev.modality,
          prev.polarity,
          prev.certainty,
          prev.quality_score ?? prev.certainty,
          JSON.stringify(prev.quality_flags ?? []),
          prev.time_start_utc,
          prev.time_end_utc,
          claimId,
          prev.extractor_version,
          input.revisionNote ?? null,
        ],
      );

      await client.query(
        `
        insert into public.fact_claim_feedback (
          id, claim_id, action, before_json, after_json, actor, created_at
        ) values ($1, $2, 'supersede', $3::jsonb, $4::jsonb, 'user', now())
        `,
        [newId(), claimId, JSON.stringify(prev), JSON.stringify({ supersededBy: nextId, at: now })],
      );

      if (input.revisionNote) {
        await client.query(
          `
          insert into public.fact_claim_feedback (
            id, claim_id, action, before_json, after_json, actor, created_at
          ) values ($1, $2, 'revise', $3::jsonb, $4::jsonb, 'user', now())
          `,
          [newId(), nextId, JSON.stringify({ id: claimId }), JSON.stringify({ revisionNote: input.revisionNote })],
        );
      }

      await client.query("commit");
      const revised = await this.getFactClaimById(nextId);
      if (!revised) {
        throw new Error("revised claim not found");
      }
      return revised;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async retractFactClaim(claimId: string, input?: { reason?: string }): Promise<FactClaim> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const row = await client.query(
        "select * from public.fact_claims where id = $1 and deleted_at is null limit 1",
        [claimId],
      );
      if (!row.rowCount) {
        throw new Error("claim not found");
      }
      const prev = row.rows[0];
      await client.query(
        `
        update public.fact_claims
        set status='retracted', revision_note=coalesce($2, revision_note), updated_at=now()
        where id = $1
        `,
        [claimId, input?.reason ?? null],
      );
      await client.query(
        `
        insert into public.fact_claim_feedback (
          id, claim_id, action, before_json, after_json, actor, created_at
        ) values ($1, $2, 'retract', $3::jsonb, $4::jsonb, 'user', now())
        `,
        [newId(), claimId, JSON.stringify(prev), JSON.stringify({ reason: input?.reason ?? null })],
      );
      await client.query("commit");
      const retracted = await this.getFactClaimById(claimId);
      if (!retracted) {
        throw new Error("claim not found");
      }
      return retracted;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async listRollups(query?: RollupQuery): Promise<Rollup[]> {
    const parsed = rollupQuerySchema.parse(query ?? {});
    try {
      const rows = await this.pool.query(
        `
        select *
        from public.fact_rollups
        where ($1::text is null or scope_type = $1)
          and ($2::text is null or scope_key = $2)
          and ($3::text is null or period_type = $3)
          and ($4::timestamptz is null or period_start_utc >= $4)
          and ($5::timestamptz is null or period_end_utc <= $5)
        order by period_start_utc desc
        limit $6
        `,
        [
          parsed.scopeType ?? null,
          parsed.scopeKey ?? null,
          parsed.periodType ?? null,
          parsed.fromUtc ?? null,
          parsed.toUtc ?? null,
          parsed.limit ?? 100,
        ],
      );

      return rows.rows.map((row) =>
        rollupSchema.parse({
          id: row.id,
          scopeType: row.scope_type,
          scopeKey: row.scope_key,
          periodType: row.period_type,
          periodStartUtc: toUtcIsoFromPgTimestamp(row.period_start_utc),
          periodEndUtc: toUtcIsoFromPgTimestamp(row.period_end_utc),
          summaryText: row.summary_text,
          keyClaimIds: Array.isArray(row.key_claim_ids) ? row.key_claim_ids : [],
          generatedByModel: row.generated_by_model ?? undefined,
          createdAtUtc: toUtcIsoFromPgTimestamp(row.created_at),
          updatedAtUtc: toUtcIsoFromPgTimestamp(row.updated_at),
        }),
      );
    } catch (error) {
      if (isMissingRelationError(error)) {
        return [];
      }
      throw error;
    }
  }

  async rebuildRollups(input: RebuildRollupsInput): Promise<Rollup[]> {
    const parsed = rebuildRollupsInputSchema.parse(input);
    const rows = await this.pool.query(
      `
      select id, subject_text, predicate, object_text_canonical, created_at
      from public.fact_claims
      where deleted_at is null
        and created_at >= $1::timestamptz
        and created_at <= $2::timestamptz
      order by created_at desc
      limit 200
      `,
      [parsed.fromUtc, parsed.toUtc],
    );

    const keyClaimIds = rows.rows.slice(0, 12).map((row) => String(row.id));
    const sentences = rows.rows
      .slice(0, 10)
      .map((row) => `${row.subject_text} ${row.predicate} ${row.object_text_canonical}`)
      .filter(Boolean);
    const summaryText = sentences.length > 0 ? sentences.join(" / ") : "期間内の事実データがありません。";
    const rollupId = newId();

    await this.pool.query(
      `
      insert into public.fact_rollups (
        id, scope_type, scope_key, period_type,
        period_start_utc, period_end_utc, summary_text,
        key_claim_ids, generated_by_model, created_at, updated_at
      ) values ($1, $2, $3, $4, $5::timestamptz, $6::timestamptz, $7, $8::jsonb, $9, now(), now())
      on conflict (scope_type, scope_key, period_type, period_start_utc, period_end_utc)
      do update set summary_text = excluded.summary_text,
                    key_claim_ids = excluded.key_claim_ids,
                    generated_by_model = excluded.generated_by_model,
                    updated_at = now()
      `,
      [
        rollupId,
        parsed.scopeType,
        parsed.scopeKey,
        parsed.periodType,
        parsed.fromUtc,
        parsed.toUtc,
        summaryText,
        JSON.stringify(keyClaimIds),
        parsed.llmModel ?? "rules-rollup-v1",
      ],
    );

    return this.listRollups({
      scopeType: parsed.scopeType,
      scopeKey: parsed.scopeKey,
      periodType: parsed.periodType,
      fromUtc: parsed.fromUtc,
      toUtc: parsed.toUtc,
      limit: 20,
    });
  }
}

export function createPgStore(dsn: string): PgStore {
  const pool = new Pool({
    connectionString: dsn,
    ssl: { rejectUnauthorized: false },
    max: 10,
  });
  return new PgStore(pool, dsn);
}
