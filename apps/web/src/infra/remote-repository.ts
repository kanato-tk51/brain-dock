import type { EntryRepository } from "@/domain/repository";
import type {
  CreateEntryInput,
  Draft,
  Entry,
  EntryType,
  HistoryRecord,
  ListQuery,
  SearchQuery,
  SearchResult,
  SyncQueueItem,
} from "@/domain/schemas";

function unsupported(): never {
  throw new Error("RemoteRepository is not implemented in UI v1");
}

export class RemoteRepository implements EntryRepository {
  createEntry(_input: CreateEntryInput): Promise<Entry> {
    return unsupported();
  }

  updateEntry(_id: string, _patch: Partial<Entry>): Promise<Entry> {
    return unsupported();
  }

  listEntries(_query?: ListQuery): Promise<Entry[]> {
    return unsupported();
  }

  searchEntries(_query: SearchQuery): Promise<SearchResult[]> {
    return unsupported();
  }

  saveDraft(_type: EntryType, _draft: Record<string, unknown>): Promise<void> {
    return unsupported();
  }

  loadDraft(_type: EntryType): Promise<Draft | null> {
    return unsupported();
  }

  enqueueSync(_entryId: string): Promise<void> {
    return unsupported();
  }

  listSyncQueue(): Promise<SyncQueueItem[]> {
    return unsupported();
  }

  markSynced(_queueId: string, _remoteId: string): Promise<void> {
    return unsupported();
  }

  listHistory(_entryId?: string): Promise<HistoryRecord[]> {
    return unsupported();
  }

  lockWithPin(_pin: string): Promise<void> {
    return unsupported();
  }

  unlockWithPin(_pin: string): Promise<boolean> {
    return unsupported();
  }

  hasPin(): Promise<boolean> {
    return unsupported();
  }

  isLocked(): Promise<boolean> {
    return unsupported();
  }

  setLocked(_locked: boolean): Promise<void> {
    return unsupported();
  }
}
