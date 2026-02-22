import type {
  AnalysisJob,
  AnalysisJobQuery,
  AnalysisModel,
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
  RebuildRollupsInput,
  Rollup,
  RollupQuery,
  RunAnalysisInput,
  RunAnalysisResult,
  SearchQuery,
  SearchResult,
} from "../lib/schemas.js";
import { createEntryInputSchema, entrySchema, validatePayload } from "../lib/schemas.js";
import { filterEntries, newId, nowUtcIso, searchEntries as rankSearch } from "../lib/utils.js";
import type { DataStore } from "./store.js";

const MEMORY_MODELS: AnalysisModel[] = [
  { id: "gpt-5", label: "GPT-5", supportsReasoningEffort: true, defaultReasoningEffort: "low" },
  { id: "gpt-5.1", label: "GPT-5.1", supportsReasoningEffort: true, defaultReasoningEffort: "low" },
  { id: "gpt-5.2", label: "GPT-5.2", supportsReasoningEffort: true, defaultReasoningEffort: "low" },
  { id: "gpt-5-mini", label: "GPT-5 mini", supportsReasoningEffort: true, defaultReasoningEffort: "low" },
  { id: "gpt-5-nano", label: "GPT-5 nano", supportsReasoningEffort: true, defaultReasoningEffort: "low" },
  { id: "gpt-4.1", label: "GPT-4.1", supportsReasoningEffort: false, defaultReasoningEffort: "none" },
  { id: "gpt-4.1-mini", label: "GPT-4.1 mini", supportsReasoningEffort: false, defaultReasoningEffort: "none" },
  { id: "gpt-4.1-nano", label: "GPT-4.1 nano", supportsReasoningEffort: false, defaultReasoningEffort: "none" },
  { id: "gpt-4o", label: "GPT-4o", supportsReasoningEffort: false, defaultReasoningEffort: "none" },
  { id: "gpt-4o-mini", label: "GPT-4o mini", supportsReasoningEffort: false, defaultReasoningEffort: "none" },
];

export class MemoryStore implements DataStore {
  private entries = new Map<string, Entry>();
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
      analysisState: "not_requested",
      payload,
    });
    this.entries.set(entry.id, entry);
    return entry;
  }

  async listEntries(query?: ListQuery): Promise<Entry[]> {
    return filterEntries([...this.entries.values()], query);
  }

  async searchEntries(query: SearchQuery): Promise<SearchResult[]> {
    const filtered = filterEntries([...this.entries.values()], query);
    return rankSearch(filtered, query.text);
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

  async getAnalysisModels(): Promise<AnalysisModel[]> {
    return MEMORY_MODELS;
  }

  async runAnalysisForEntries(input: RunAnalysisInput): Promise<RunAnalysisResult> {
    return {
      jobId: newId(),
      requested: input.entryIds.length,
      succeeded: 0,
      failed: input.entryIds.length,
      replaceExisting: input.replaceExisting,
      results: input.entryIds.map((entryId) => ({
        entryId,
        status: "error",
        message: "analysis is available only with postgres backend",
        claimsInserted: 0,
        attemptCount: 0,
      })),
    };
  }

  async listAnalysisJobs(_query?: AnalysisJobQuery): Promise<AnalysisJob[]> {
    return [];
  }

  async getAnalysisJob(_jobId: string): Promise<AnalysisJob | null> {
    return null;
  }

  async searchFacts(_query?: FactSearchQuery): Promise<FactClaim[]> {
    return [];
  }

  async listFactsByEntry(_entryId: string, _limit?: number): Promise<FactClaim[]> {
    return [];
  }

  async getFactClaimById(_claimId: string): Promise<FactClaim | null> {
    return null;
  }

  async reviseFactClaim(_claimId: string, _input: { objectTextCanonical: string; revisionNote?: string }): Promise<FactClaim> {
    throw new Error("claim revision is available only with postgres backend");
  }

  async retractFactClaim(_claimId: string, _input?: { reason?: string }): Promise<FactClaim> {
    throw new Error("claim retract is available only with postgres backend");
  }

  async listRollups(_query?: RollupQuery): Promise<Rollup[]> {
    return [];
  }

  async rebuildRollups(_input: RebuildRollupsInput): Promise<Rollup[]> {
    return [];
  }
}
