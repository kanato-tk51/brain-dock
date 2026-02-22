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

export interface DataStore {
  kind(): "memory" | "postgres";
  createEntry(input: CreateEntryInput): Promise<Entry>;
  listEntries(query?: ListQuery): Promise<Entry[]>;
  searchEntries(query: SearchQuery): Promise<SearchResult[]>;
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

  close?(): Promise<void>;
}
