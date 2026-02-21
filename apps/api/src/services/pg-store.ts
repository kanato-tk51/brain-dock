import { Pool, type QueryResultRow } from "pg";
import type {
  CreateEntryInput,
  Entry,
  HistoryRecord,
  ListQuery,
  SearchQuery,
  SearchResult,
  SyncQueueItem,
} from "../lib/schemas.js";
import { createEntryInputSchema, entrySchema, syncQueueSchema, validatePayload } from "../lib/schemas.js";
import { filterEntries, newId, nowUtcIso, searchEntries as rankSearch } from "../lib/utils.js";
import type { DataStore } from "./store.js";

function toEntry(row: QueryResultRow): Entry {
  return entrySchema.parse({
    id: row.id,
    declaredType: row.declared_type,
    title: row.title ?? undefined,
    body: row.body ?? undefined,
    tags: Array.isArray(row.tags) ? row.tags : [],
    occurredAtUtc: new Date(row.occurred_at_utc).toISOString(),
    sensitivity: row.sensitivity,
    createdAtUtc: new Date(row.created_at).toISOString(),
    updatedAtUtc: new Date(row.updated_at).toISOString(),
    syncStatus: row.sync_status,
    remoteId: row.remote_id ?? undefined,
    payload: row.payload ?? {},
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
  constructor(private readonly pool: Pool) {}

  kind(): "postgres" {
    return "postgres";
  }

  async close(): Promise<void> {
    await this.pool.end();
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
        [newId(), mapCaptureInputType(entry), buildCaptureRawText(entry), entry.occurredAtUtc, entry.sensitivity],
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

  async updateEntry(id: string, patch: Partial<Entry>): Promise<Entry> {
    const currentRow = await this.pool.query("select * from public.app_entries where id = $1", [id]);
    if (currentRow.rowCount === 0) {
      throw new Error(`entry not found: ${id}`);
    }
    const current = toEntry(currentRow.rows[0]);
    const next = entrySchema.parse({
      ...current,
      ...patch,
      id,
      updatedAtUtc: nowUtcIso(),
    });

    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await client.query(
        `
        update public.app_entries
        set declared_type = $2,
            title = $3,
            body = $4,
            tags = $5::jsonb,
            occurred_at_utc = $6::timestamptz,
            sensitivity = $7,
            payload = $8::jsonb,
            sync_status = $9,
            remote_id = $10,
            updated_at = now()
        where id = $1
        `,
        [
          id,
          next.declaredType,
          next.title ?? null,
          next.body ?? null,
          JSON.stringify(next.tags),
          next.occurredAtUtc,
          next.sensitivity,
          JSON.stringify(next.payload),
          next.syncStatus,
          next.remoteId ?? null,
        ],
      );
      await client.query(
        `
        insert into public.app_history (id, entry_id, source, before_json, after_json, created_at)
        values ($1, $2, 'remote', $3::jsonb, $4::jsonb, now())
        `,
        [newId(), id, JSON.stringify(current), JSON.stringify(next)],
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }

    return next;
  }

  async listEntries(query?: ListQuery): Promise<Entry[]> {
    const rows = await this.pool.query("select * from public.app_entries order by occurred_at_utc desc limit 1000");
    return filterEntries(rows.rows.map(toEntry), query);
  }

  async searchEntries(query: SearchQuery): Promise<SearchResult[]> {
    const entries = await this.listEntries(query);
    return rankSearch(entries, query.text);
  }

  async enqueueSync(entryId: string): Promise<void> {
    await this.pool.query(
      `
      insert into public.app_sync_queue (id, entry_id, status, created_at, updated_at)
      values ($1, $2, 'pending', now(), now())
      on conflict do nothing
      `,
      [newId(), entryId],
    );
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
}

export function createPgStore(dsn: string): PgStore {
  const pool = new Pool({
    connectionString: dsn,
    ssl: { rejectUnauthorized: false },
    max: 10,
  });
  return new PgStore(pool);
}
