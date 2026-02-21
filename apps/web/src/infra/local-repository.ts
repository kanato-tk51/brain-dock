import type { CaptureTextInput, EntryRepository } from "@/domain/repository";
import {
  createEntryInputSchema,
  type CreateEntryInput,
  draftSchema,
  entrySchema,
  type Entry,
  type EntryType,
  type HistoryRecord,
  historySchema,
  listQuerySchema,
  type ListQuery,
  searchQuerySchema,
  type SearchQuery,
  type SearchResult,
  securityRecordSchema,
  syncQueueSchema,
  type SyncQueueItem,
  validatePayload,
} from "@/domain/schemas";
import { getDb } from "@/infra/indexeddb";
import { nowUtcIso } from "@/shared/utils/time";
import { newUuidV7 } from "@/shared/utils/uuid";

async function hashPin(pin: string, salt: string): Promise<string> {
  const encoder = new TextEncoder();
  if (globalThis.crypto?.subtle) {
    const bytes = encoder.encode(`${salt}:${pin}`);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  return btoa(`${salt}:${pin}`);
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^0-9a-z\u3040-\u30ff\u4e00-\u9faf\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 1);
}

function buildSearchableText(entry: Entry): string {
  const fields: string[] = [entry.title ?? "", entry.body ?? "", entry.tags.join(" ")];
  Object.values(entry.payload as Record<string, unknown>).forEach((v) => {
    if (Array.isArray(v)) {
      fields.push(v.join(" "));
    } else if (typeof v === "string" || typeof v === "number") {
      fields.push(String(v));
    }
  });
  return fields.join(" ").trim();
}

function filterEntries(entries: Entry[], query?: ListQuery): Entry[] {
  if (!query) {
    return [...entries].sort((a, b) => b.occurredAtUtc.localeCompare(a.occurredAtUtc));
  }

  const validated = listQuerySchema.parse(query);
  let out = [...entries];
  if (validated.types?.length) {
    out = out.filter((e) => validated.types?.includes(e.declaredType));
  }
  if (validated.fromUtc) {
    out = out.filter((e) => e.occurredAtUtc >= validated.fromUtc!);
  }
  if (validated.toUtc) {
    out = out.filter((e) => e.occurredAtUtc <= validated.toUtc!);
  }
  if (validated.tags?.length) {
    out = out.filter((e) => validated.tags!.every((tag) => e.tags.includes(tag)));
  }
  if (validated.sensitivity) {
    out = out.filter((e) => e.sensitivity === validated.sensitivity);
  }
  out.sort((a, b) => b.occurredAtUtc.localeCompare(a.occurredAtUtc));
  if (validated.limit) {
    out = out.slice(0, validated.limit);
  }
  return out;
}

function searchScore(haystack: string, query: string, occurredAtUtc: string): number {
  const lower = haystack.toLowerCase();
  const q = query.toLowerCase();
  let base = 0;

  if (lower.includes(` ${q} `) || lower === q) {
    base += 3;
  } else if (lower.split(/\s+/).some((token) => token.startsWith(q))) {
    base += 2;
  } else if (lower.includes(q)) {
    base += 1;
  }

  const ageHours = Math.max((Date.now() - new Date(occurredAtUtc).getTime()) / (1000 * 60 * 60), 1);
  const recencyBoost = 1 / Math.log2(ageHours + 2);
  return base + recencyBoost;
}

export class LocalRepository implements EntryRepository {
  private db = getDb();

  async captureText(input: CaptureTextInput): Promise<Entry> {
    const text = input.text.trim();
    if (!text) {
      throw new Error("入力内容は必須です");
    }
    const occurredAtUtc = input.occurredAtUtc ?? nowUtcIso();
    return this.createEntry({
      declaredType: input.declaredType,
      body: text,
      tags: [],
      occurredAtUtc,
      sensitivity: "internal",
      payload: buildMinimalPayload(input.declaredType, text),
    });
  }

  async createEntry(input: CreateEntryInput): Promise<Entry> {
    const parsedInput = createEntryInputSchema.parse(input);
    const payload = validatePayload(parsedInput.declaredType, parsedInput.payload);
    const now = nowUtcIso();

    const entry = entrySchema.parse({
      id: newUuidV7(),
      declaredType: parsedInput.declaredType,
      title: parsedInput.title,
      body: parsedInput.body,
      tags: parsedInput.tags,
      occurredAtUtc: parsedInput.occurredAtUtc,
      sensitivity: parsedInput.sensitivity,
      createdAtUtc: now,
      updatedAtUtc: now,
      payload,
      syncStatus: "pending",
    });

    await this.db.transaction("rw", this.db.entries, this.db.syncQueue, this.db.ftsIndex, async () => {
      await this.db.entries.put(entry);
      await this.enqueueSync(entry.id);
      await this.db.ftsIndex.put({
        id: entry.id,
        entryId: entry.id,
        tokens: tokenize(buildSearchableText(entry)).join(" "),
        updatedAtUtc: now,
      });
    });

    return entry;
  }

  async listEntries(query?: ListQuery): Promise<Entry[]> {
    const entries = await this.db.entries.toArray();
    return filterEntries(entries, query);
  }

  async searchEntries(query: SearchQuery): Promise<SearchResult[]> {
    const parsed = searchQuerySchema.parse(query);
    const entries = filterEntries(await this.db.entries.toArray(), parsed);
    const q = parsed.text.toLowerCase();

    const results = entries
      .map((entry) => {
        const searchable = buildSearchableText(entry);
        const score = searchScore(searchable, parsed.text, entry.occurredAtUtc);
        if (score < 1) {
          return null;
        }
        const matchedFields: string[] = [];
        if ((entry.title ?? "").toLowerCase().includes(q)) {
          matchedFields.push("title");
        }
        if ((entry.body ?? "").toLowerCase().includes(q)) {
          matchedFields.push("body");
        }
        if (entry.tags.some((t) => t.toLowerCase().includes(q))) {
          matchedFields.push("tags");
        }
        if (matchedFields.length === 0) {
          matchedFields.push("payload");
        }
        return { entry, score, matchedFields };
      })
      .filter((v): v is SearchResult => Boolean(v))
      .sort((a, b) => b.score - a.score);

    return results;
  }

  async saveDraft(type: EntryType, draft: Record<string, unknown>): Promise<void> {
    await this.db.drafts.put(
      draftSchema.parse({
        declaredType: type,
        value: draft,
        updatedAtUtc: nowUtcIso(),
      }),
    );
  }

  async loadDraft(type: EntryType) {
    const item = await this.db.drafts.get(type);
    return item ?? null;
  }

  async enqueueSync(entryId: string): Promise<void> {
    const now = nowUtcIso();
    const existing = await this.db.syncQueue.where("entryId").equals(entryId).and((q) => q.status === "pending").first();
    if (existing) {
      return;
    }

    await this.db.syncQueue.put(
      syncQueueSchema.parse({
        id: newUuidV7(),
        entryId,
        status: "pending",
        createdAtUtc: now,
        updatedAtUtc: now,
      }),
    );
  }

  async listSyncQueue(): Promise<SyncQueueItem[]> {
    const list = await this.db.syncQueue.orderBy("createdAtUtc").reverse().toArray();
    return list;
  }

  async markSynced(queueId: string, remoteId: string): Promise<void> {
    const queueItem = await this.db.syncQueue.get(queueId);
    if (!queueItem) {
      throw new Error(`sync queue not found: ${queueId}`);
    }

    const entry = await this.db.entries.get(queueItem.entryId);
    if (!entry) {
      throw new Error(`entry not found for sync queue: ${queueItem.entryId}`);
    }

    await this.db.transaction("rw", this.db.syncQueue, this.db.entries, this.db.history, async () => {
      await this.db.syncQueue.put({
        ...queueItem,
        status: "synced",
        updatedAtUtc: nowUtcIso(),
        lastError: undefined,
      });

      const next = entrySchema.parse({
        ...entry,
        syncStatus: "synced",
        remoteId,
        updatedAtUtc: nowUtcIso(),
      });
      await this.db.entries.put(next);
      await this.db.history.put(
        historySchema.parse({
          id: newUuidV7(),
          entryId: entry.id,
          source: "remote",
          beforeJson: JSON.stringify(entry),
          afterJson: JSON.stringify(next),
          createdAtUtc: nowUtcIso(),
        }),
      );
    });
  }

  async markSyncFailed(queueId: string, error: string): Promise<void> {
    const queueItem = await this.db.syncQueue.get(queueId);
    if (!queueItem) {
      throw new Error(`sync queue not found: ${queueId}`);
    }
    const entry = await this.db.entries.get(queueItem.entryId);
    if (!entry) {
      throw new Error(`entry not found for sync queue: ${queueItem.entryId}`);
    }

    await this.db.transaction("rw", this.db.syncQueue, this.db.entries, this.db.history, async () => {
      await this.db.syncQueue.put({
        ...queueItem,
        status: "failed",
        lastError: error.slice(0, 400),
        updatedAtUtc: nowUtcIso(),
      });
      const next = entrySchema.parse({
        ...entry,
        syncStatus: "failed",
        updatedAtUtc: nowUtcIso(),
      });
      await this.db.entries.put(next);
      await this.db.history.put(
        historySchema.parse({
          id: newUuidV7(),
          entryId: entry.id,
          source: "remote",
          beforeJson: JSON.stringify(entry),
          afterJson: JSON.stringify(next),
          createdAtUtc: nowUtcIso(),
        }),
      );
    });
  }

  async listHistory(entryId?: string): Promise<HistoryRecord[]> {
    if (!entryId) {
      return this.db.history.orderBy("createdAtUtc").reverse().toArray();
    }
    return this.db.history.where("entryId").equals(entryId).reverse().sortBy("createdAtUtc");
  }

  async lockWithPin(pin: string): Promise<void> {
    if (pin.length < 4) {
      throw new Error("PINは4桁以上必要です");
    }
    const now = nowUtcIso();
    const salt = newUuidV7();
    const pinHash = await hashPin(pin, salt);
    await this.db.security.put(
      securityRecordSchema.parse({
        key: "pin",
        pinHash,
        salt,
        locked: true,
        updatedAtUtc: now,
      }),
    );
  }

  async unlockWithPin(pin: string): Promise<boolean> {
    const current = await this.db.security.get("pin");
    if (!current) {
      return true;
    }

    const candidate = await hashPin(pin, current.salt);
    const ok = candidate === current.pinHash;
    if (!ok) {
      return false;
    }

    await this.db.security.put({
      ...current,
      locked: false,
      updatedAtUtc: nowUtcIso(),
    });
    return true;
  }

  async hasPin(): Promise<boolean> {
    const current = await this.db.security.get("pin");
    return Boolean(current?.pinHash);
  }

  async isLocked(): Promise<boolean> {
    const current = await this.db.security.get("pin");
    return Boolean(current?.locked);
  }

  async setLocked(locked: boolean): Promise<void> {
    const current = await this.db.security.get("pin");
    if (!current) {
      return;
    }
    await this.db.security.put({
      ...current,
      locked,
      updatedAtUtc: nowUtcIso(),
    });
  }
}

function buildMinimalPayload(type: Entry["declaredType"], text: string): Record<string, unknown> {
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
