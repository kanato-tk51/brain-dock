import type {
  CreateEntryInput,
  Entry,
  HistoryRecord,
  ListQuery,
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
    await this.enqueueSync(entry.id);
    return entry;
  }

  async updateEntry(id: string, patch: Partial<Entry>): Promise<Entry> {
    const current = this.entries.get(id);
    if (!current) {
      throw new Error(`entry not found: ${id}`);
    }
    const next = entrySchema.parse({
      ...current,
      ...patch,
      id,
      updatedAtUtc: nowUtcIso(),
    });
    this.entries.set(id, next);
    const historyId = newId();
    this.history.set(historyId, {
      id: historyId,
      entryId: id,
      source: "remote",
      beforeJson: JSON.stringify(current),
      afterJson: JSON.stringify(next),
      createdAtUtc: nowUtcIso(),
    });
    return next;
  }

  async listEntries(query?: ListQuery): Promise<Entry[]> {
    return filterEntries([...this.entries.values()], query);
  }

  async searchEntries(query: SearchQuery): Promise<SearchResult[]> {
    const filtered = filterEntries([...this.entries.values()], query);
    return rankSearch(filtered, query.text);
  }

  async enqueueSync(entryId: string): Promise<void> {
    const existing = [...this.syncQueue.values()].find((v) => v.entryId === entryId && v.status === "pending");
    if (existing) {
      return;
    }
    const now = nowUtcIso();
    const item: SyncQueueItem = {
      id: newId(),
      entryId,
      status: "pending",
      createdAtUtc: now,
      updatedAtUtc: now,
    };
    this.syncQueue.set(item.id, item);
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
}
