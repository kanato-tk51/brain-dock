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
  CreateEntryInput,
  Entry,
  FactClaim,
  FactSearchQuery,
  HistoryRecord,
  ListQuery,
  OpenAiCostSummary,
  OpenAiCostSummaryQuery,
  OpenAiRequestQuery,
  OpenAiRequestRecord,
  RunAnalysisInput,
  RunAnalysisResult,
  SearchQuery,
  SearchResult,
  SyncQueueItem,
} from "../lib/schemas.js";
import {
  analysisEntryResultSchema,
  analysisJobItemSchema,
  analysisJobQuerySchema,
  analysisJobSchema,
  createEntryInputSchema,
  entrySchema,
  factClaimSchema,
  factSearchQuerySchema,
  openAiCostBucketSchema,
  openAiCostSummarySchema,
  openAiRequestQuerySchema,
  openAiRequestRecordSchema,
  runAnalysisInputSchema,
  runAnalysisResultSchema,
  syncQueueSchema,
  validatePayload,
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

function normalizeLegacyType(rawType: unknown): Entry["declaredType"] {
  if (rawType === "journal" || rawType === "todo" || rawType === "learning" || rawType === "thought" || rawType === "meeting") {
    return rawType;
  }
  if (rawType === "wishlist") {
    return "thought";
  }
  throw new Error(`unsupported declared_type in app_entries: ${String(rawType)}`);
}

function normalizeLegacyPayload(type: Entry["declaredType"], payload: unknown, body?: string): Record<string, unknown> {
  if (type !== "thought") {
    return (payload as Record<string, unknown>) ?? {};
  }
  const rowPayload = (payload as Record<string, unknown>) ?? {};
  if (typeof rowPayload.note === "string" && rowPayload.note.trim()) {
    return rowPayload;
  }
  const item = typeof rowPayload.item === "string" ? rowPayload.item.trim() : "";
  const reason = typeof rowPayload.reason === "string" ? rowPayload.reason.trim() : "";
  const merged = [item, reason, body?.trim() ?? ""].filter(Boolean).join(" / ");
  return { note: merged || "legacy wishlist entry" };
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
    syncStatus: row.sync_status,
    remoteId: row.remote_id ?? undefined,
    analysisStatus: analysisStatus as Entry["analysisStatus"] | undefined,
    payload: normalizeLegacyPayload(normalizedType, row.payload, body),
  });
}

function toSyncQueue(row: QueryResultRow): SyncQueueItem {
  return syncQueueSchema.parse({
    id: row.id,
    entryId: row.entry_id,
    status: row.status,
    createdAtUtc: new Date(row.created_at).toISOString(),
    updatedAtUtc: new Date(row.updated_at).toISOString(),
    lastError: row.last_error ?? undefined,
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

function toFactClaim(row: QueryResultRow, evidenceSpans: QueryResultRow[] = []): FactClaim {
  return factClaimSchema.parse({
    id: row.id,
    documentId: row.document_id,
    entryId: row.entry_id,
    subjectText: row.subject_text,
    subjectEntityId: row.subject_entity_id ?? undefined,
    predicate: row.predicate,
    objectText: row.object_text,
    objectEntityId: row.object_entity_id ?? undefined,
    modality: row.modality,
    polarity: row.polarity,
    certainty: toSafeNumber(row.certainty),
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
        maxBuffer: 4 * 1024 * 1024,
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

  private async ensureCaptureForEntry(client: any, entry: Entry): Promise<{ captureId: string; piiScore: number }> {
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

  private async ensureFactDocumentForEntry(client: any, entry: Entry, captureId: string, piiScore: number): Promise<string> {
    try {
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
        return String(existing.rows[0].id);
      }
    } catch (error) {
      if (isMissingRelationError(error)) {
        return entry.id;
      }
      throw error;
    }

    const rawText = buildCaptureRawText(entry);
    const redactionState = redactionStateFromPii(piiScore);
    await client.query(
      `
      insert into public.fact_documents (
        id, entry_id, capture_id, declared_type, raw_text, occurred_at_utc,
        sensitivity, pii_score, redaction_state, created_at, updated_at
      ) values (
        $1, $2, $3, $4, $5, $6::timestamptz, $7, $8, $9, now(), now()
      )
      on conflict (entry_id) do update set
        capture_id = excluded.capture_id,
        declared_type = excluded.declared_type,
        raw_text = excluded.raw_text,
        occurred_at_utc = excluded.occurred_at_utc,
        sensitivity = excluded.sensitivity,
        pii_score = excluded.pii_score,
        redaction_state = excluded.redaction_state,
        updated_at = now()
      `,
      [entry.id, entry.id, captureId, entry.declaredType, rawText, entry.occurredAtUtc, entry.sensitivity, piiScore, redactionState],
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
      syncStatus: "pending",
      payload,
    });

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `
        insert into public.app_entries (
          id, declared_type, title, body, tags, occurred_at_utc, sensitivity, payload, sync_status, created_at, updated_at
        ) values ($1, $2, $3, $4, $5::jsonb, $6::timestamptz, $7, $8::jsonb, 'pending', now(), now())
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
      await client.query(
        `
        insert into public.app_sync_queue (id, entry_id, status, created_at, updated_at)
        values ($1, $2, 'pending', now(), now())
        `,
        [newId(), entry.id],
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

  async listSyncQueue(): Promise<SyncQueueItem[]> {
    const rows = await this.pool.query("select * from public.app_sync_queue order by created_at desc limit 1000");
    return rows.rows.map(toSyncQueue);
  }

  async markSynced(queueId: string, remoteId: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const queueRes = await client.query("select * from public.app_sync_queue where id = $1", [queueId]);
      if (queueRes.rowCount === 0) {
        throw new Error(`sync queue not found: ${queueId}`);
      }
      const queue = queueRes.rows[0];

      const entryRes = await client.query("select * from public.app_entries where id = $1", [queue.entry_id]);
      if (entryRes.rowCount === 0) {
        throw new Error(`entry not found: ${queue.entry_id}`);
      }
      const before = toEntry(entryRes.rows[0]);
      const after = entrySchema.parse({
        ...before,
        syncStatus: "synced",
        remoteId,
        updatedAtUtc: nowUtcIso(),
      });

      await client.query(
        "update public.app_sync_queue set status='synced', last_error=null, updated_at=now() where id = $1",
        [queueId],
      );
      await client.query(
        "update public.app_entries set sync_status='synced', remote_id=$2, updated_at=now() where id = $1",
        [before.id, remoteId],
      );
      await client.query(
        `
        insert into public.app_history (id, entry_id, source, before_json, after_json, created_at)
        values ($1, $2, 'remote', $3::jsonb, $4::jsonb, now())
        `,
        [newId(), before.id, JSON.stringify(before), JSON.stringify(after)],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async markSyncFailed(queueId: string, error: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const queueRes = await client.query("select entry_id from public.app_sync_queue where id = $1", [queueId]);
      if (queueRes.rowCount === 0) {
        throw new Error(`sync queue not found: ${queueId}`);
      }
      const entryId = queueRes.rows[0].entry_id as string;
      const entryRes = await client.query("select * from public.app_entries where id = $1", [entryId]);
      if (entryRes.rowCount === 0) {
        throw new Error(`entry not found: ${entryId}`);
      }
      const before = toEntry(entryRes.rows[0]);
      const after = entrySchema.parse({
        ...before,
        syncStatus: "failed",
        updatedAtUtc: nowUtcIso(),
      });
      await client.query(
        "update public.app_sync_queue set status='failed', last_error=$2, updated_at=now() where id = $1",
        [queueId, error.slice(0, 1000)],
      );
      await client.query("update public.app_entries set sync_status='failed', updated_at=now() where id = $1", [entryId]);
      await client.query(
        `
        insert into public.app_history (id, entry_id, source, before_json, after_json, created_at)
        values ($1, $2, 'remote', $3::jsonb, $4::jsonb, now())
        `,
        [newId(), entryId, JSON.stringify(before), JSON.stringify(after)],
      );
      await client.query("commit");
    } catch (err) {
      await client.query("rollback");
      throw err;
    } finally {
      client.release();
    }
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

  async runAnalysisForEntries(input: RunAnalysisInput): Promise<RunAnalysisResult> {
    const parsed = runAnalysisInputSchema.parse(input);
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
        [jobId, `llm-${process.env.BRAIN_DOCK_LLM_MODEL ?? "gpt-4.1-mini"}`, parsed.entryIds.length],
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
      try {
        const entry = await this.getEntryById(entryId);
        if (!entry) {
          failed += 1;
          await this.pool.query(
            "update public.fact_extraction_job_items set status='failed', last_error=$2, updated_at=now() where id=$1",
            [item.id, "entry not found"],
          );
          results.push(
            analysisEntryResultSchema.parse({
              entryId,
              jobItemId: item.id,
              status: "error",
              message: "entry not found",
            }),
          );
          continue;
        }

        await this.pool.query(
          "update public.fact_extraction_job_items set status='running', attempt_count=attempt_count+1, updated_at=now() where id=$1",
          [item.id],
        );
        const capture = await this.ensureCaptureForEntry(this.pool, entry);
        const documentId = await this.ensureFactDocumentForEntry(this.pool, entry, capture.captureId, capture.piiScore);
        await this.pool.query(
          "update public.fact_extraction_job_items set document_id=$2, updated_at=now() where id=$1",
          [item.id, documentId],
        );

        const workerArgs = ["--entry-id", entry.id, "--document-id", documentId, "--job-id", jobId, "--job-item-id", item.id];
        if (parsed.replaceExisting) {
          workerArgs.push("--replace-existing");
        }
        const workerResult = await this.runWorkerScript("extract_claims_llm.py", workerArgs);
        const workerStatus = String(workerResult.status ?? "failed");
        const claimsInserted = toSafeInt(workerResult.claims_inserted);
        const attemptCount = toSafeInt(workerResult.attempt_count) || toSafeInt(item.attempt_count) + 1;
        const nextRetryAt = workerResult.next_retry_at ? String(workerResult.next_retry_at) : null;
        const errorText = workerResult.error ? String(workerResult.error) : null;

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
        }

        results.push(
          analysisEntryResultSchema.parse({
            entryId,
            documentId,
            jobItemId: String(item.id),
            status: workerStatus === "failed" ? "error" : workerStatus,
            message: errorText ?? (workerStatus === "succeeded" ? "analysis completed" : "analysis pending"),
            claimsInserted,
            attemptCount,
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
        results.push(
          analysisEntryResultSchema.parse({
            entryId,
            jobItemId: String(item.id),
            status: "error",
            message: error instanceof Error ? error.message : "analysis failed",
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
        select *
        from public.fact_extraction_job_items
        where job_id = any($1::text[])
        order by created_at asc
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
              status: item.status,
              attemptCount: toSafeInt(item.attempt_count),
              nextRetryAtUtc: item.next_retry_at ? toUtcIsoFromPgTimestamp(item.next_retry_at) : undefined,
              lastError: item.last_error ?? undefined,
              claimsInserted: toSafeInt(item.claims_inserted),
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
    const jobs = await this.listAnalysisJobs({ limit: 1 });
    const match = jobs.find((job) => job.id === jobId);
    if (match) {
      return match;
    }
    try {
      const row = await this.pool.query("select * from public.fact_extraction_jobs where id = $1 limit 1", [jobId]);
      if (!row.rowCount) {
        return null;
      }
      const itemsRes = await this.pool.query(
        "select * from public.fact_extraction_job_items where job_id = $1 order by created_at asc",
        [jobId],
      );
      return analysisJobSchema.parse({
        id: row.rows[0].id,
        triggerMode: row.rows[0].trigger_mode,
        status: row.rows[0].status,
        requestedBy: row.rows[0].requested_by,
        extractorVersion: row.rows[0].extractor_version,
        requestedAtUtc: toUtcIsoFromPgTimestamp(row.rows[0].requested_at),
        startedAtUtc: row.rows[0].started_at ? toUtcIsoFromPgTimestamp(row.rows[0].started_at) : undefined,
        finishedAtUtc: row.rows[0].finished_at ? toUtcIsoFromPgTimestamp(row.rows[0].finished_at) : undefined,
        totalItems: toSafeInt(row.rows[0].total_items),
        succeededItems: toSafeInt(row.rows[0].succeeded_items),
        failedItems: toSafeInt(row.rows[0].failed_items),
        errorSummary: row.rows[0].error_summary ?? undefined,
        items: itemsRes.rows.map((item) =>
          analysisJobItemSchema.parse({
            id: item.id,
            jobId: item.job_id,
            entryId: item.entry_id,
            documentId: item.document_id ?? undefined,
            status: item.status,
            attemptCount: toSafeInt(item.attempt_count),
            nextRetryAtUtc: item.next_retry_at ? toUtcIsoFromPgTimestamp(item.next_retry_at) : undefined,
            lastError: item.last_error ?? undefined,
            claimsInserted: toSafeInt(item.claims_inserted),
            createdAtUtc: toUtcIsoFromPgTimestamp(item.created_at),
            updatedAtUtc: toUtcIsoFromPgTimestamp(item.updated_at),
          }),
        ),
      });
    } catch (error) {
      if (isMissingRelationError(error)) {
        return null;
      }
      throw error;
    }
  }

  async searchFacts(query?: FactSearchQuery): Promise<FactClaim[]> {
    const parsed = factSearchQuerySchema.parse(query ?? {});
    try {
      const rows = await this.pool.query(
        `
        select c.*, d.declared_type
        from public.fact_claims c
        join public.fact_documents d on d.id = c.document_id
        where c.deleted_at is null
          and ($1::text is null or c.subject_text ilike '%' || $1 || '%' or c.object_text ilike '%' || $1 || '%' or c.predicate ilike '%' || $1 || '%')
          and ($2::text is null or d.declared_type = $2)
          and ($3::text is null or c.modality = $3)
          and ($4::text is null or c.predicate = $4)
          and ($5::timestamptz is null or coalesce(c.time_start_utc, d.occurred_at_utc) >= $5)
          and ($6::timestamptz is null or coalesce(c.time_end_utc, c.time_start_utc, d.occurred_at_utc) <= $6)
        order by coalesce(c.time_start_utc, d.occurred_at_utc) desc, c.created_at desc
        limit $7
        `,
        [
          parsed.text ?? null,
          parsed.type ?? null,
          parsed.modality ?? null,
          parsed.predicate ?? null,
          parsed.fromUtc ?? null,
          parsed.toUtc ?? null,
          parsed.limit ?? 100,
        ],
      );
      if (rows.rowCount === 0) {
        return [];
      }
      const claimIds = rows.rows.map((row) => row.id);
      const spans = await this.pool.query(
        `
        select *
        from public.fact_evidence_spans
        where claim_id = any($1::text[])
        order by created_at asc
        `,
        [claimIds],
      );
      const spansByClaim = new Map<string, QueryResultRow[]>();
      for (const span of spans.rows) {
        const key = String(span.claim_id);
        const list = spansByClaim.get(key) ?? [];
        list.push(span);
        spansByClaim.set(key, list);
      }
      return rows.rows.map((row) => toFactClaim(row, spansByClaim.get(String(row.id)) ?? []));
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
      if (rows.rowCount === 0) {
        return [];
      }
      const claimIds = rows.rows.map((row) => row.id);
      const spans = await this.pool.query(
        "select * from public.fact_evidence_spans where claim_id = any($1::text[]) order by created_at asc",
        [claimIds],
      );
      const spansByClaim = new Map<string, QueryResultRow[]>();
      for (const span of spans.rows) {
        const key = String(span.claim_id);
        const list = spansByClaim.get(key) ?? [];
        list.push(span);
        spansByClaim.set(key, list);
      }
      return rows.rows.map((row) => toFactClaim(row, spansByClaim.get(String(row.id)) ?? []));
    } catch (error) {
      if (isMissingRelationError(error)) {
        return [];
      }
      throw error;
    }
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
}

export function createPgStore(dsn: string): PgStore {
  const pool = new Pool({
    connectionString: dsn,
    ssl: { rejectUnauthorized: false },
    max: 10,
  });
  return new PgStore(pool, dsn);
}
