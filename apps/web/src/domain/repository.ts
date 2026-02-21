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
  lockWithPin(pin: string): Promise<void>;
  unlockWithPin(pin: string): Promise<boolean>;
  hasPin(): Promise<boolean>;
  isLocked(): Promise<boolean>;
  setLocked(locked: boolean): Promise<void>;
}
