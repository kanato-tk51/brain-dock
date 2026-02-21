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

export interface DataStore {
  kind(): "memory" | "postgres";
  createEntry(input: CreateEntryInput): Promise<Entry>;
  listEntries(query?: ListQuery): Promise<Entry[]>;
  searchEntries(query: SearchQuery): Promise<SearchResult[]>;
  listSyncQueue(): Promise<SyncQueueItem[]>;
  markSynced(queueId: string, remoteId: string): Promise<void>;
  markSyncFailed(queueId: string, error: string): Promise<void>;
  listHistory(entryId?: string): Promise<HistoryRecord[]>;
  listOpenAiRequests(query?: OpenAiRequestQuery): Promise<OpenAiRequestRecord[]>;
  getOpenAiCostSummary(query: OpenAiCostSummaryQuery): Promise<OpenAiCostSummary>;
  runAnalysisForEntries(input: RunAnalysisInput): Promise<RunAnalysisResult>;
  close?(): Promise<void>;
}
