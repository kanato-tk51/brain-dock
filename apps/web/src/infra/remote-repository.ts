import type { CaptureTextInput, EntryRepository } from "@/domain/repository";
import type {
  AnalysisJob,
  AnalysisJobQuery,
  Draft,
  Entry,
  EntryType,
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
} from "@/domain/schemas";
import {
  entrySchema,
  historySchema,
  listQuerySchema,
  analysisJobQuerySchema,
  analysisJobSchema,
  factClaimSchema,
  factSearchQuerySchema,
  openAiCostSummaryQuerySchema,
  openAiCostSummarySchema,
  openAiRequestQuerySchema,
  openAiRequestRecordSchema,
  runAnalysisInputSchema,
  runAnalysisResultSchema,
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

  async listOpenAiRequests(query?: OpenAiRequestQuery): Promise<OpenAiRequestRecord[]> {
    const validated = query ? openAiRequestQuerySchema.parse(query) : undefined;
    const raw = await this.request<unknown[]>(
      `/openai/requests${encodeQuery({
        fromUtc: validated?.fromUtc,
        toUtc: validated?.toUtc,
        status: validated?.status,
        model: validated?.model,
        operation: validated?.operation,
        workflow: validated?.workflow,
        limit: validated?.limit,
      })}`,
      "GET",
    );
    return raw.map((row) => openAiRequestRecordSchema.parse(row));
  }

  async getOpenAiCostSummary(query: OpenAiCostSummaryQuery): Promise<OpenAiCostSummary> {
    const validated = openAiCostSummaryQuerySchema.parse(query);
    const raw = await this.request<unknown>(
      `/openai/costs/summary${encodeQuery({
        period: validated.period,
        fromUtc: validated.fromUtc,
        toUtc: validated.toUtc,
        limit: validated.limit,
      })}`,
      "GET",
    );
    return openAiCostSummarySchema.parse(raw);
  }

  async runAnalysisForEntries(input: RunAnalysisInput): Promise<RunAnalysisResult> {
    const validated = runAnalysisInputSchema.parse(input);
    const raw = await this.request<unknown>("/analysis/run", "POST", validated);
    return runAnalysisResultSchema.parse(raw);
  }

  async listAnalysisJobs(query?: AnalysisJobQuery): Promise<AnalysisJob[]> {
    const validated = query ? analysisJobQuerySchema.parse(query) : undefined;
    const raw = await this.request<unknown[]>(
      `/analysis/jobs${encodeQuery({
        status: validated?.status,
        limit: validated?.limit,
      })}`,
      "GET",
    );
    return raw.map((row) => analysisJobSchema.parse(row));
  }

  async getAnalysisJob(jobId: string): Promise<AnalysisJob | null> {
    try {
      const raw = await this.request<unknown>(`/analysis/jobs/${jobId}`, "GET");
      return analysisJobSchema.parse(raw);
    } catch (error) {
      if (error instanceof Error && error.message.includes("404")) {
        return null;
      }
      throw error;
    }
  }

  async searchFacts(query?: FactSearchQuery): Promise<FactClaim[]> {
    const validated = query ? factSearchQuerySchema.parse(query) : undefined;
    const raw = await this.request<unknown[]>(
      `/facts/search${encodeQuery({
        text: validated?.text,
        type: validated?.type,
        modality: validated?.modality,
        predicate: validated?.predicate,
        fromUtc: validated?.fromUtc,
        toUtc: validated?.toUtc,
        limit: validated?.limit,
      })}`,
      "GET",
    );
    return raw.map((row) => factClaimSchema.parse(row));
  }

  async listFactsByEntry(entryId: string, limit?: number): Promise<FactClaim[]> {
    const raw = await this.request<unknown[]>(
      `/facts/by-entry/${entryId}${encodeQuery({
        limit,
      })}`,
      "GET",
    );
    return raw.map((row) => factClaimSchema.parse(row));
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
