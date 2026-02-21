import { z } from "zod";

export const entryTypes = [
  "journal",
  "todo",
  "learning",
  "thought",
  "meeting",
] as const;

export const sensitivityLevels = ["public", "internal", "sensitive"] as const;

export const entryTypeSchema = z.enum(entryTypes);
export const sensitivitySchema = z.enum(sensitivityLevels);

export const baseEntrySchema = z.object({
  id: z.string().uuid(),
  declaredType: entryTypeSchema,
  title: z.string().max(160).optional(),
  body: z.string().max(10000).optional(),
  tags: z.array(z.string().min(1).max(40)).default([]),
  occurredAtUtc: z.string().datetime({ offset: true }),
  sensitivity: sensitivitySchema.default("internal"),
  createdAtUtc: z.string().datetime({ offset: true }),
  updatedAtUtc: z.string().datetime({ offset: true }),
  syncStatus: z.enum(["pending", "syncing", "synced", "failed"]).default("pending"),
  remoteId: z.string().optional(),
});

export const journalPayloadSchema = z.object({
  mood: z.number().int().min(1).max(5).optional(),
  energy: z.number().int().min(1).max(5).optional(),
  reflection: z.string().min(1, "振り返りは必須です"),
});

export const todoPayloadSchema = z.object({
  status: z.enum(["todo", "in_progress", "done"]).default("todo"),
  priority: z.number().int().min(1).max(4).default(3),
  dueAtUtc: z.string().datetime({ offset: true }).optional(),
  context: z.string().max(200).optional(),
  details: z.string().min(1, "内容は必須です"),
});

export const learningPayloadSchema = z.object({
  url: z.string().url().optional(),
  summary3Lines: z.string().max(400).optional(),
  takeaway: z.string().min(1, "学びは必須です"),
});

export const thoughtPayloadSchema = z.object({
  hypothesis: z.string().max(400).optional(),
  question: z.string().max(400).optional(),
  note: z.string().min(1, "メモは必須です"),
});

export const meetingPayloadSchema = z.object({
  context: z.string().min(1, "背景は必須です"),
  notes: z.string().min(1, "議事メモは必須です"),
  decisions: z.array(z.string().min(1)).default([]),
  actions: z.array(z.string().min(1)).default([]),
});

export const payloadByTypeSchema = {
  journal: journalPayloadSchema,
  todo: todoPayloadSchema,
  learning: learningPayloadSchema,
  thought: thoughtPayloadSchema,
  meeting: meetingPayloadSchema,
} as const;

export const entrySchema = z.discriminatedUnion("declaredType", [
  baseEntrySchema.extend({ declaredType: z.literal("journal"), payload: journalPayloadSchema }),
  baseEntrySchema.extend({ declaredType: z.literal("todo"), payload: todoPayloadSchema }),
  baseEntrySchema.extend({ declaredType: z.literal("learning"), payload: learningPayloadSchema }),
  baseEntrySchema.extend({ declaredType: z.literal("thought"), payload: thoughtPayloadSchema }),
  baseEntrySchema.extend({ declaredType: z.literal("meeting"), payload: meetingPayloadSchema }),
]);

export const draftSchema = z.object({
  declaredType: entryTypeSchema,
  value: z.record(z.string(), z.unknown()),
  updatedAtUtc: z.string().datetime({ offset: true }),
});

export const syncQueueSchema = z.object({
  id: z.string().uuid(),
  entryId: z.string().uuid(),
  status: z.enum(["pending", "syncing", "synced", "failed"]),
  createdAtUtc: z.string().datetime({ offset: true }),
  updatedAtUtc: z.string().datetime({ offset: true }),
  lastError: z.string().optional(),
});

export const historySchema = z.object({
  id: z.string().uuid(),
  entryId: z.string().uuid(),
  source: z.enum(["local", "remote"]),
  beforeJson: z.string(),
  afterJson: z.string(),
  createdAtUtc: z.string().datetime({ offset: true }),
});

export const securityRecordSchema = z.object({
  key: z.literal("pin"),
  pinHash: z.string(),
  salt: z.string(),
  locked: z.boolean(),
  updatedAtUtc: z.string().datetime({ offset: true }),
});

export type EntryType = z.infer<typeof entryTypeSchema>;
export type Sensitivity = z.infer<typeof sensitivitySchema>;
export type Entry = z.infer<typeof entrySchema>;
export type Draft = z.infer<typeof draftSchema>;
export type SyncQueueItem = z.infer<typeof syncQueueSchema>;
export type HistoryRecord = z.infer<typeof historySchema>;
export type SecurityRecord = z.infer<typeof securityRecordSchema>;

export type EntryPayloadMap = {
  journal: z.infer<typeof journalPayloadSchema>;
  todo: z.infer<typeof todoPayloadSchema>;
  learning: z.infer<typeof learningPayloadSchema>;
  thought: z.infer<typeof thoughtPayloadSchema>;
  meeting: z.infer<typeof meetingPayloadSchema>;
};

export const createEntryInputSchema = z.object({
  declaredType: entryTypeSchema,
  title: z.string().max(160).optional(),
  body: z.string().max(10000).optional(),
  tags: z.array(z.string().min(1).max(40)).default([]),
  occurredAtUtc: z.string().datetime({ offset: true }),
  sensitivity: sensitivitySchema.default("internal"),
  payload: z.record(z.string(), z.unknown()),
});

export type CreateEntryInput = z.infer<typeof createEntryInputSchema>;

export const listQuerySchema = z.object({
  types: z.array(entryTypeSchema).optional(),
  fromUtc: z.string().datetime({ offset: true }).optional(),
  toUtc: z.string().datetime({ offset: true }).optional(),
  tags: z.array(z.string()).optional(),
  sensitivity: sensitivitySchema.optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});

export const searchQuerySchema = listQuerySchema.extend({
  text: z.string().min(1),
});

export type ListQuery = z.infer<typeof listQuerySchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;

export const searchResultSchema = z.object({
  entry: entrySchema,
  score: z.number(),
  matchedFields: z.array(z.string()),
});

export type SearchResult = z.infer<typeof searchResultSchema>;

export function validatePayload(type: EntryType, payload: unknown) {
  return payloadByTypeSchema[type].parse(payload);
}
