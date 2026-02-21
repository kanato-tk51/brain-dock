import type { CaptureTextInput, EntryRepository } from "@/domain/repository";
import type {
  Draft,
  Entry,
  EntryType,
  HistoryRecord,
  ListQuery,
  SearchQuery,
  SearchResult,
  SyncQueueItem,
} from "@/domain/schemas";
import {
  entrySchema,
  historySchema,
  listQuerySchema,
  searchQuerySchema,
  searchResultSchema,
  syncQueueSchema,
} from "@/domain/schemas";
import { LocalRepository } from "@/infra/local-repository";

type HttpMethod = "GET" | "POST" | "PATCH";

function encodeQuery(params: Record<string, unknown>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null) {
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length > 0) {
        search.set(key, value.join(","));
      }
      continue;
    }
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `?${query}` : "";
}

export class RemoteRepository implements EntryRepository {
  private readonly localSecurity = new LocalRepository();
  private readonly baseUrl: string;

  constructor(baseUrl = process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:8787") {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async request<T>(path: string, method: HttpMethod, body?: unknown): Promise<T> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "content-type": "application/json",
      },
      body: body ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    if (!response.ok) {
      let detail = `${response.status} ${response.statusText}`;
      try {
        const parsed = (await response.json()) as { error?: string };
        if (parsed?.error) {
          detail = `${detail}: ${parsed.error}`;
        }
      } catch {
        // ignore response parse errors
      }
      throw new Error(`remote request failed (${method} ${path}): ${detail}`);
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  async captureText(input: CaptureTextInput): Promise<Entry> {
    const text = input.text.trim();
    if (!text) {
      throw new Error("入力内容は必須です");
    }
    const raw = await this.request<unknown>(`/entries/${input.declaredType}`, "POST", {
      text,
      occurredAtUtc: input.occurredAtUtc,
    });
    return entrySchema.parse(raw);
  }

  async listEntries(query?: ListQuery): Promise<Entry[]> {
    const validated = query ? listQuerySchema.parse(query) : undefined;
    const raw = await this.request<unknown[]>(
      `/entries${encodeQuery({
        types: validated?.types,
        fromUtc: validated?.fromUtc,
        toUtc: validated?.toUtc,
        tags: validated?.tags,
        sensitivity: validated?.sensitivity,
        limit: validated?.limit,
      })}`,
      "GET",
    );
    return raw.map((row) => entrySchema.parse(row));
  }

  async searchEntries(query: SearchQuery): Promise<SearchResult[]> {
    const validated = searchQuerySchema.parse(query);
    const raw = await this.request<unknown[]>(
      `/entries/search${encodeQuery({
        text: validated.text,
        types: validated.types,
        fromUtc: validated.fromUtc,
        toUtc: validated.toUtc,
        tags: validated.tags,
        sensitivity: validated.sensitivity,
        limit: validated.limit,
      })}`,
      "GET",
    );
    return raw.map((row) => searchResultSchema.parse(row));
  }

  async saveDraft(type: EntryType, draft: Record<string, unknown>): Promise<void> {
    await this.localSecurity.saveDraft(type, draft);
  }

  async loadDraft(type: EntryType): Promise<Draft | null> {
    return this.localSecurity.loadDraft(type);
  }

  async listSyncQueue(): Promise<SyncQueueItem[]> {
    const raw = await this.request<unknown[]>("/sync-queue", "GET");
    return raw.map((row) => syncQueueSchema.parse(row));
  }

  async markSynced(queueId: string, remoteId: string): Promise<void> {
    await this.request(`/sync-queue/${queueId}/mark-synced`, "POST", { remoteId });
  }

  async markSyncFailed(queueId: string, error: string): Promise<void> {
    await this.request(`/sync-queue/${queueId}/mark-failed`, "POST", { error });
  }

  async listHistory(entryId?: string): Promise<HistoryRecord[]> {
    const raw = await this.request<unknown[]>(
      `/history${encodeQuery({
        entryId,
      })}`,
      "GET",
    );
    return raw.map((row) => historySchema.parse(row));
  }

  async lockWithPin(pin: string): Promise<void> {
    await this.localSecurity.lockWithPin(pin);
  }

  async unlockWithPin(pin: string): Promise<boolean> {
    return this.localSecurity.unlockWithPin(pin);
  }

  async hasPin(): Promise<boolean> {
    return this.localSecurity.hasPin();
  }

  async isLocked(): Promise<boolean> {
    return this.localSecurity.isLocked();
  }

  async setLocked(locked: boolean): Promise<void> {
    await this.localSecurity.setLocked(locked);
  }
}
