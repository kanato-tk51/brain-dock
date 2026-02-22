import Dexie, { type Table } from "dexie";
import type { Draft, Entry, HistoryRecord, SecurityRecord } from "@/domain/schemas";

export type FtsIndexRow = {
  id: string;
  entryId: string;
  tokens: string;
  updatedAtUtc: string;
};

export class BrainDockDb extends Dexie {
  entries!: Table<Entry, string>;
  drafts!: Table<Draft, string>;
  history!: Table<HistoryRecord, string>;
  security!: Table<SecurityRecord, string>;
  ftsIndex!: Table<FtsIndexRow, string>;

  constructor() {
    super("brain_dock_web_v2");
    this.version(1).stores({
      entries: "id, declaredType, occurredAtUtc, updatedAtUtc, sensitivity, analysisState",
      drafts: "declaredType, updatedAtUtc",
      history: "id, entryId, createdAtUtc",
      security: "key, updatedAtUtc",
      ftsIndex: "id, entryId, updatedAtUtc",
    });
  }
}

let singleton: BrainDockDb | null = null;

export function getDb(): BrainDockDb {
  if (!singleton) {
    singleton = new BrainDockDb();
  }
  return singleton;
}

export async function resetDbForTests(): Promise<void> {
  if (singleton) {
    singleton.close();
  }
  await Dexie.delete("brain_dock_web_v2");
  singleton = null;
}
