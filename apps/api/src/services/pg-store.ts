import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { Pool, type QueryResultRow } from "pg";
import type {
  AnalysisEntryResult,
  CreateEntryInput,
  Entry,
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
  createEntryInputSchema,
  entrySchema,
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

function toEntry(row: QueryResultRow): Entry {
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

function isMissingRelationError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }
  return "code" in error && (error as { code?: string }).code === "42P01";
}

function resolveRepoRoot(): string {
  if (process.env.BRAIN_DOCK_ROOT) {
    return path.resolve(process.env.BRAIN_DOCK_ROOT);
  }
  const cwd = process.cwd();
  const workerFromCwd = path.resolve(cwd, "apps/worker/process_captures.py");
  if (existsSync(workerFromCwd)) {
    return cwd;
  }
  const fromApiPackage = path.resolve(cwd, "../..");
  const workerFromApi = path.resolve(fromApiPackage, "apps/worker/process_captures.py");
  if (existsSync(workerFromApi)) {
    return fromApiPackage;
  }
  return fromApiPackage;
}

type CaptureBinding = {
  captureId: string;
  status: string;
  parsedNoteId?: string;
  parsedTaskId?: string;
};

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

  private async runWorkerScript(scriptName: "process_captures.py" | "extract_key_facts.py", args: string[]): Promise<WorkerJson> {
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

  private toCaptureBinding(row: QueryResultRow): CaptureBinding {
    return {
      captureId: String(row.id),
      status: String(row.status ?? "new"),
      parsedNoteId: row.parsed_note_id ? String(row.parsed_note_id) : undefined,
      parsedTaskId: row.parsed_task_id ? String(row.parsed_task_id) : undefined,
    };
  }

  private async getEntryById(entryId: string): Promise<Entry | null> {
    const row = await this.pool.query("select * from public.app_entries where id = $1", [entryId]);
    if (!row.rowCount) {
      return null;
    }
    return toEntry(row.rows[0]);
  }

  private async getCaptureById(captureId: string): Promise<CaptureBinding | null> {
    const row = await this.pool.query(
      `
      select id, status, parsed_note_id, parsed_task_id
      from public.captures_raw
      where id = $1
      limit 1
      `,
      [captureId],
    );
    if (!row.rowCount) {
      return null;
    }
    return this.toCaptureBinding(row.rows[0]);
  }

  private async ensureCaptureForEntry(entry: Entry): Promise<CaptureBinding> {
    const captureText = buildCaptureRawText(entry);
    const found = await this.pool.query(
      `
      select id, status, parsed_note_id, parsed_task_id
      from public.captures_raw
      where id = $1
         or (source_id = 'source-web-api' and raw_text = $2 and occurred_at = $3::timestamptz)
      order by created_at desc
      limit 1
      `,
      [entry.id, captureText, entry.occurredAtUtc],
    );
    if (found.rowCount) {
      return this.toCaptureBinding(found.rows[0]);
    }

    await this.pool.query(
      `
      insert into public.sources (id, kind, detail, created_at)
      values ('source-web-api', 'web_ui', 'apps/api', now())
      on conflict (id) do nothing
      `,
    );
    await this.pool.query(
      `
      insert into public.captures_raw (
        id, source_id, input_type, raw_text, occurred_at, sensitivity, pii_score, status, created_at, updated_at
      ) values ($1, 'source-web-api', $2, $3, $4::timestamptz, $5, 0, 'new', now(), now())
      `,
      [entry.id, mapCaptureInputType(entry), captureText, entry.occurredAtUtc, entry.sensitivity],
    );
    return {
      captureId: entry.id,
      status: "new",
    };
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
        ) values ($1, 'source-web-api', $2, $3, $4::timestamptz, $5, 0, 'new', now(), now())
        `,
        [entry.id, mapCaptureInputType(entry), buildCaptureRawText(entry), entry.occurredAtUtc, entry.sensitivity],
      );
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
    return filterEntries(rows.rows.map(toEntry), query);
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

    for (const entryId of parsed.entryIds) {
      try {
        const entry = await this.getEntryById(entryId);
        if (!entry) {
          results.push(
            analysisEntryResultSchema.parse({
              entryId,
              status: "error",
              message: "entry not found",
              extractResults: [],
            }),
          );
          continue;
        }

        let capture = await this.ensureCaptureForEntry(entry);
        let processResult: WorkerJson | undefined;
        const extractResults: WorkerJson[] = [];

        if (capture.status === "blocked") {
          results.push(
            analysisEntryResultSchema.parse({
              entryId,
              captureId: capture.captureId,
              status: "skipped",
              message: "capture is blocked by safety policy",
              extractResults,
            }),
          );
          continue;
        }

        const hasParsedTarget = Boolean(capture.parsedNoteId || capture.parsedTaskId);
        if (!hasParsedTarget) {
          processResult = await this.runWorkerScript("process_captures.py", [
            "--capture-id",
            capture.captureId,
            "--limit",
            "1",
          ]);
          capture = (await this.getCaptureById(capture.captureId)) ?? capture;
        }

        if (capture.parsedNoteId) {
          const args = [
            "--source",
            "notes",
            "--note-id",
            capture.parsedNoteId,
            "--extractor",
            parsed.extractor,
            "--limit",
            "1",
          ];
          if (parsed.replaceExisting) {
            args.push("--replace-existing");
          }
          extractResults.push(await this.runWorkerScript("extract_key_facts.py", args));
        }

        if (capture.parsedTaskId) {
          const args = [
            "--source",
            "tasks",
            "--task-id",
            capture.parsedTaskId,
            "--extractor",
            parsed.extractor,
            "--limit",
            "1",
          ];
          if (parsed.replaceExisting) {
            args.push("--replace-existing");
          }
          extractResults.push(await this.runWorkerScript("extract_key_facts.py", args));
        }

        if (!capture.parsedNoteId && !capture.parsedTaskId) {
          results.push(
            analysisEntryResultSchema.parse({
              entryId,
              captureId: capture.captureId,
              status: "skipped",
              message: "no parsed note/task generated",
              processResult,
              extractResults,
            }),
          );
          continue;
        }

        results.push(
          analysisEntryResultSchema.parse({
            entryId,
            captureId: capture.captureId,
            noteId: capture.parsedNoteId,
            taskId: capture.parsedTaskId,
            status: "ok",
            message: "analysis completed",
            processResult,
            extractResults,
          }),
        );
      } catch (error) {
        results.push(
          analysisEntryResultSchema.parse({
            entryId,
            status: "error",
            message: error instanceof Error ? error.message : "analysis failed",
            extractResults: [],
          }),
        );
      }
    }

    const succeeded = results.filter((r) => r.status === "ok").length;
    const failed = results.filter((r) => r.status === "error").length;
    return runAnalysisResultSchema.parse({
      requested: parsed.entryIds.length,
      succeeded,
      failed,
      extractor: parsed.extractor,
      replaceExisting: parsed.replaceExisting,
      results,
    });
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
