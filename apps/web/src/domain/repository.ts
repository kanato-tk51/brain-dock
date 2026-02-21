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
  listSyncQueue(): Promise<SyncQueueItem[]>;
  markSynced(queueId: string, remoteId: string): Promise<void>;
  markSyncFailed(queueId: string, error: string): Promise<void>;
  listHistory(entryId?: string): Promise<HistoryRecord[]>;
  listOpenAiRequests(query?: OpenAiRequestQuery): Promise<OpenAiRequestRecord[]>;
  getOpenAiCostSummary(query: OpenAiCostSummaryQuery): Promise<OpenAiCostSummary>;
  runAnalysisForEntries(input: RunAnalysisInput): Promise<RunAnalysisResult>;
  listAnalysisJobs(query?: AnalysisJobQuery): Promise<AnalysisJob[]>;
  getAnalysisJob(jobId: string): Promise<AnalysisJob | null>;
  searchFacts(query?: FactSearchQuery): Promise<FactClaim[]>;
  listFactsByEntry(entryId: string, limit?: number): Promise<FactClaim[]>;
  lockWithPin(pin: string): Promise<void>;
  unlockWithPin(pin: string): Promise<boolean>;
  hasPin(): Promise<boolean>;
  isLocked(): Promise<boolean>;
  setLocked(locked: boolean): Promise<void>;
}
