import { z } from "zod";

export const entryTypes = [
  "journal",
  "todo",
  "learning",
  "thought",
  "meeting",
] as const;

export const sensitivityLevels = ["public", "internal", "sensitive"] as const;
export const syncStatuses = ["pending", "syncing", "synced", "failed"] as const;
export const openAiPeriods = ["day", "week", "month"] as const;
export const openAiRequestStatuses = ["ok", "error", "timeout", "canceled"] as const;
export const analysisExtractors = ["rules", "llm"] as const;

export const entryTypeSchema = z.enum(entryTypes);
export const sensitivitySchema = z.enum(sensitivityLevels);
export const syncStatusSchema = z.enum(syncStatuses);
export const openAiPeriodSchema = z.enum(openAiPeriods);
export const openAiRequestStatusSchema = z.enum(openAiRequestStatuses);
export const analysisExtractorSchema = z.enum(analysisExtractors);

const baseEntrySchema = z.object({
  id: z.string().uuid(),
  declaredType: entryTypeSchema,
  title: z.string().max(160).optional(),
  body: z.string().max(10000).optional(),
  tags: z.array(z.string().min(1).max(40)).default([]),
  occurredAtUtc: z.string().datetime({ offset: true }),
  sensitivity: sensitivitySchema.default("internal"),
  createdAtUtc: z.string().datetime({ offset: true }),
  updatedAtUtc: z.string().datetime({ offset: true }),
  syncStatus: syncStatusSchema.default("pending"),
  remoteId: z.string().optional(),
});

export const journalPayloadSchema = z.object({
  mood: z.number().int().min(1).max(5).optional(),
  energy: z.number().int().min(1).max(5).optional(),
  reflection: z.string().min(1),
});

export const todoPayloadSchema = z.object({
  status: z.enum(["todo", "in_progress", "done"]).default("todo"),
  priority: z.number().int().min(1).max(4).default(3),
  dueAtUtc: z.string().datetime({ offset: true }).optional(),
  context: z.string().max(200).optional(),
  details: z.string().min(1),
});

export const learningPayloadSchema = z.object({
  url: z.string().url().optional(),
  summary3Lines: z.string().max(400).optional(),
  takeaway: z.string().min(1),
});

export const thoughtPayloadSchema = z.object({
  hypothesis: z.string().max(400).optional(),
  question: z.string().max(400).optional(),
  note: z.string().min(1),
});

export const meetingPayloadSchema = z.object({
  context: z.string().min(1),
  notes: z.string().min(1),
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

export const createEntryInputSchema = z.object({
  id: z.string().uuid().optional(),
  declaredType: entryTypeSchema,
  title: z.string().max(160).optional(),
  body: z.string().max(10000).optional(),
  tags: z.array(z.string().min(1).max(40)).default([]),
  occurredAtUtc: z.string().datetime({ offset: true }),
  sensitivity: sensitivitySchema.default("internal"),
  payload: z.record(z.string(), z.unknown()),
});

export const captureTextInputSchema = z.object({
  text: z.string().trim().min(1).max(10000),
  occurredAtUtc: z.string().datetime({ offset: true }).optional(),
});

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

export const searchResultSchema = z.object({
  entry: entrySchema,
  score: z.number(),
  matchedFields: z.array(z.string()),
});

export const syncQueueSchema = z.object({
  id: z.string().uuid(),
  entryId: z.string().uuid(),
  status: syncStatusSchema,
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

export const openAiRequestQuerySchema = z.object({
  fromUtc: z.string().datetime({ offset: true }).optional(),
  toUtc: z.string().datetime({ offset: true }).optional(),
  status: openAiRequestStatusSchema.optional(),
  model: z.string().min(1).max(100).optional(),
  operation: z.string().min(1).max(100).optional(),
  workflow: z.string().min(1).max(100).optional(),
  limit: z.number().int().min(1).max(1000).optional(),
});

export const openAiCostSummaryQuerySchema = z.object({
  period: openAiPeriodSchema.default("day"),
  fromUtc: z.string().datetime({ offset: true }).optional(),
  toUtc: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(366).optional(),
});

export const openAiRequestRecordSchema = z.object({
  id: z.string(),
  createdAtUtc: z.string().datetime({ offset: true }),
  requestStartedAtUtc: z.string().datetime({ offset: true }),
  requestFinishedAtUtc: z.string().datetime({ offset: true }).optional(),
  status: openAiRequestStatusSchema,
  environment: z.enum(["local", "staging", "production"]),
  endpoint: z.string(),
  model: z.string(),
  operation: z.string().optional(),
  workflow: z.string().optional(),
  correlationId: z.string().optional(),
  actor: z.string(),
  sourceRefType: z.enum(["none", "capture", "note", "task", "entry", "other"]),
  sourceRefId: z.string().optional(),
  openaiRequestId: z.string().optional(),
  inputTokens: z.number().int().min(0),
  cachedInputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  reasoningOutputTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  inputChars: z.number().int().min(0).optional(),
  outputChars: z.number().int().min(0).optional(),
  requestCostUsd: z.number().min(0),
  costSource: z.enum(["estimated", "provider_reported", "manual"]),
  errorType: z.string().optional(),
  errorMessage: z.string().optional(),
});

export const openAiCostBucketSchema = z.object({
  period: openAiPeriodSchema,
  periodStartUtc: z.string().datetime({ offset: true }),
  requestCount: z.number().int().min(0),
  okCount: z.number().int().min(0),
  errorCount: z.number().int().min(0),
  inputTokens: z.number().int().min(0),
  cachedInputTokens: z.number().int().min(0),
  outputTokens: z.number().int().min(0),
  totalTokens: z.number().int().min(0),
  totalCostUsd: z.number().min(0),
});

export const openAiCostSummarySchema = z.object({
  period: openAiPeriodSchema,
  fromUtc: z.string().datetime({ offset: true }).optional(),
  toUtc: z.string().datetime({ offset: true }).optional(),
  totals: z.object({
    requestCount: z.number().int().min(0),
    okCount: z.number().int().min(0),
    errorCount: z.number().int().min(0),
    inputTokens: z.number().int().min(0),
    cachedInputTokens: z.number().int().min(0),
    outputTokens: z.number().int().min(0),
    totalTokens: z.number().int().min(0),
    totalCostUsd: z.number().min(0),
  }),
  buckets: z.array(openAiCostBucketSchema),
});

export const runAnalysisInputSchema = z.object({
  entryIds: z.array(z.string().uuid()).min(1).max(200),
  extractor: analysisExtractorSchema.default("rules"),
  replaceExisting: z.boolean().default(true),
});

export const analysisEntryResultSchema = z.object({
  entryId: z.string().uuid(),
  captureId: z.string().optional(),
  noteId: z.string().optional(),
  taskId: z.string().optional(),
  status: z.enum(["ok", "skipped", "error"]),
  message: z.string().optional(),
  processResult: z.record(z.string(), z.unknown()).optional(),
  extractResults: z.array(z.record(z.string(), z.unknown())).default([]),
});

export const runAnalysisResultSchema = z.object({
  requested: z.number().int().min(0),
  succeeded: z.number().int().min(0),
  failed: z.number().int().min(0),
  extractor: analysisExtractorSchema,
  replaceExisting: z.boolean(),
  results: z.array(analysisEntryResultSchema),
});

export type EntryType = z.infer<typeof entryTypeSchema>;
export type Entry = z.infer<typeof entrySchema>;
export type CreateEntryInput = z.infer<typeof createEntryInputSchema>;
export type CaptureTextInput = z.infer<typeof captureTextInputSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type SyncQueueItem = z.infer<typeof syncQueueSchema>;
export type HistoryRecord = z.infer<typeof historySchema>;
export type OpenAiRequestQuery = z.infer<typeof openAiRequestQuerySchema>;
export type OpenAiCostSummaryQuery = z.infer<typeof openAiCostSummaryQuerySchema>;
export type OpenAiRequestRecord = z.infer<typeof openAiRequestRecordSchema>;
export type OpenAiCostBucket = z.infer<typeof openAiCostBucketSchema>;
export type OpenAiCostSummary = z.infer<typeof openAiCostSummarySchema>;
export type RunAnalysisInput = z.infer<typeof runAnalysisInputSchema>;
export type AnalysisEntryResult = z.infer<typeof analysisEntryResultSchema>;
export type RunAnalysisResult = z.infer<typeof runAnalysisResultSchema>;

export function validatePayload(type: EntryType, payload: unknown) {
  return payloadByTypeSchema[type].parse(payload);
}
