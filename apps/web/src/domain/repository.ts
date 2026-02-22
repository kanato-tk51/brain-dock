import type {
  AnalysisJob,
  AnalysisJobQuery,
  AnalysisModel,
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
  RebuildRollupsInput,
  Rollup,
  RollupQuery,
  RunAnalysisInput,
  RunAnalysisResult,
  SearchQuery,
  SearchResult,
} from "@/domain/schemas";

export type CaptureTextInput = {
  declaredType: EntryType;
  text: string;
  occurredAtUtc?: string;
};

export interface EntryRepository {
  captureText(input: CaptureTextInput): Promise<Entry>;
  listEntries(query?: ListQuery): Promise<Entry[]>;
  searchEntries(query: SearchQuery): Promise<SearchResult[]>;
  saveDraft(type: EntryType, draft: Record<string, unknown>): Promise<void>;
  loadDraft(type: EntryType): Promise<Draft | null>;
  listHistory(entryId?: string): Promise<HistoryRecord[]>;
  listOpenAiRequests(query?: OpenAiRequestQuery): Promise<OpenAiRequestRecord[]>;
  getOpenAiCostSummary(query: OpenAiCostSummaryQuery): Promise<OpenAiCostSummary>;

  getAnalysisModels(): Promise<AnalysisModel[]>;
  runAnalysisForEntries(input: RunAnalysisInput): Promise<RunAnalysisResult>;
  listAnalysisJobs(query?: AnalysisJobQuery): Promise<AnalysisJob[]>;
  getAnalysisJob(jobId: string): Promise<AnalysisJob | null>;

  searchFacts(query?: FactSearchQuery): Promise<FactClaim[]>;
  listFactsByEntry(entryId: string, limit?: number): Promise<FactClaim[]>;
  getFactClaimById(claimId: string): Promise<FactClaim | null>;
  reviseFactClaim(claimId: string, input: { objectTextCanonical: string; revisionNote?: string }): Promise<FactClaim>;
  retractFactClaim(claimId: string, input?: { reason?: string }): Promise<FactClaim>;

  listRollups(query?: RollupQuery): Promise<Rollup[]>;
  rebuildRollups(input: RebuildRollupsInput): Promise<Rollup[]>;

  lockWithPin(pin: string): Promise<void>;
  unlockWithPin(pin: string): Promise<boolean>;
  hasPin(): Promise<boolean>;
  isLocked(): Promise<boolean>;
  setLocked(locked: boolean): Promise<void>;
}
