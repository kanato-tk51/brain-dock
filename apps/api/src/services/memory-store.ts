import type {
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
import { createEntryInputSchema, entrySchema, validatePayload } from "../lib/schemas.js";
import { filterEntries, newId, nowUtcIso, searchEntries as rankSearch } from "../lib/utils.js";
import type { DataStore } from "./store.js";

export class MemoryStore implements DataStore {
  private entries = new Map<string, Entry>();
  private syncQueue = new Map<string, SyncQueueItem>();
  private history = new Map<string, HistoryRecord>();

  kind(): "memory" {
    return "memory";
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
    this.entries.set(entry.id, entry);
    const existing = [...this.syncQueue.values()].find((v) => v.entryId === entry.id && v.status === "pending");
    if (!existing) {
      const item: SyncQueueItem = {
        id: newId(),
        entryId: entry.id,
        status: "pending",
        createdAtUtc: now,
        updatedAtUtc: now,
      };
      this.syncQueue.set(item.id, item);
    }
    return entry;
  }

  async listEntries(query?: ListQuery): Promise<Entry[]> {
    return filterEntries([...this.entries.values()], query);
  }

  async searchEntries(query: SearchQuery): Promise<SearchResult[]> {
    const filtered = filterEntries([...this.entries.values()], query);
    return rankSearch(filtered, query.text);
  }

  async listSyncQueue(): Promise<SyncQueueItem[]> {
    return [...this.syncQueue.values()].sort((a, b) => b.createdAtUtc.localeCompare(a.createdAtUtc));
  }

  async markSynced(queueId: string, remoteId: string): Promise<void> {
    const queueItem = this.syncQueue.get(queueId);
    if (!queueItem) {
      throw new Error(`sync queue not found: ${queueId}`);
    }
    const entry = this.entries.get(queueItem.entryId);
    if (!entry) {
      throw new Error(`entry not found: ${queueItem.entryId}`);
    }

    const now = nowUtcIso();
    this.syncQueue.set(queueId, {
      ...queueItem,
      status: "synced",
      updatedAtUtc: now,
      lastError: undefined,
    });

    const next = entrySchema.parse({
      ...entry,
      syncStatus: "synced",
      remoteId,
      updatedAtUtc: now,
    });
    this.entries.set(entry.id, next);
    const historyId = newId();
    this.history.set(historyId, {
      id: historyId,
      entryId: entry.id,
      source: "remote",
      beforeJson: JSON.stringify(entry),
      afterJson: JSON.stringify(next),
      createdAtUtc: now,
    });
  }

  async markSyncFailed(queueId: string, error: string): Promise<void> {
    const queueItem = this.syncQueue.get(queueId);
    if (!queueItem) {
      throw new Error(`sync queue not found: ${queueId}`);
    }
    const entry = this.entries.get(queueItem.entryId);
    if (!entry) {
      throw new Error(`entry not found: ${queueItem.entryId}`);
    }
    const now = nowUtcIso();
    this.syncQueue.set(queueId, {
      ...queueItem,
      status: "failed",
      updatedAtUtc: now,
      lastError: error,
    });
    const next = entrySchema.parse({
      ...entry,
      syncStatus: "failed",
      updatedAtUtc: now,
    });
    this.entries.set(entry.id, next);
    const historyId = newId();
    this.history.set(historyId, {
      id: historyId,
      entryId: entry.id,
      source: "remote",
      beforeJson: JSON.stringify(entry),
      afterJson: JSON.stringify(next),
      createdAtUtc: now,
    });
  }

  async listHistory(entryId?: string): Promise<HistoryRecord[]> {
    const rows = [...this.history.values()].sort((a, b) => b.createdAtUtc.localeCompare(a.createdAtUtc));
    if (!entryId) {
      return rows;
    }
    return rows.filter((row) => row.entryId === entryId);
  }

  async listOpenAiRequests(_query?: OpenAiRequestQuery): Promise<OpenAiRequestRecord[]> {
    return [];
  }

  async getOpenAiCostSummary(query: OpenAiCostSummaryQuery): Promise<OpenAiCostSummary> {
    return {
      period: query.period,
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
    };
  }

  async runAnalysisForEntries(input: RunAnalysisInput): Promise<RunAnalysisResult> {
    return {
      requested: input.entryIds.length,
      succeeded: 0,
      failed: input.entryIds.length,
      extractor: input.extractor,
      replaceExisting: input.replaceExisting,
      results: input.entryIds.map((entryId) => ({
        entryId,
        status: "error",
        message: "analysis is available only with postgres backend",
        extractResults: [],
      })),
    };
  }
}
