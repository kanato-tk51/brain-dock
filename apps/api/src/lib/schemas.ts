import { z } from "zod";

export const entryTypes = ["journal", "todo", "learning", "thought", "meeting"] as const;

export const sensitivityLevels = ["public", "internal", "sensitive"] as const;
export const openAiPeriods = ["day", "week", "month"] as const;
export const openAiRequestStatuses = ["ok", "error", "timeout", "canceled"] as const;
export const entryAnalysisStates = ["not_requested", "queued", "running", "succeeded", "failed", "blocked"] as const;
export const analysisJobStatuses = ["queued", "running", "succeeded", "failed"] as const;
export const analysisJobItemStatuses = ["queued", "running", "succeeded", "failed", "blocked", "queued_retry"] as const;
export const analysisReasoningEfforts = ["none", "low", "medium", "high"] as const;
export const analysisPriorities = ["low", "normal", "high"] as const;
export const factModalities = ["fact", "plan", "hypothesis", "request", "feeling"] as const;
export const factPolarities = ["affirm", "negate"] as const;
export const factClaimStatuses = ["active", "retracted", "superseded"] as const;
export const meRoles = ["actor", "experiencer", "observer", "recipient", "none"] as const;
export const dimensionTypes = [
  "person",
  "place",
  "activity",
  "emotion",
  "health",
  "topic",
  "project",
  "item",
  "reason",
  "time_hint",
] as const;
export const dimensionSources = ["llm", "rule", "manual"] as const;
export const claimFeedbackActions = ["revise", "supersede", "retract", "restore"] as const;
export const rollupScopeTypes = ["all", "entry_type", "topic", "project"] as const;
export const rollupPeriodTypes = ["daily", "weekly", "monthly", "custom"] as const;

export const entryTypeSchema = z.enum(entryTypes);
export const sensitivitySchema = z.enum(sensitivityLevels);
export const openAiPeriodSchema = z.enum(openAiPeriods);
export const openAiRequestStatusSchema = z.enum(openAiRequestStatuses);
export const entryAnalysisStateSchema = z.enum(entryAnalysisStates);
export const analysisJobStatusSchema = z.enum(analysisJobStatuses);
export const analysisJobItemStatusSchema = z.enum(analysisJobItemStatuses);
export const analysisReasoningEffortSchema = z.enum(analysisReasoningEfforts);
export const analysisPrioritySchema = z.enum(analysisPriorities);
export const factModalitySchema = z.enum(factModalities);
export const factPolaritySchema = z.enum(factPolarities);
export const factClaimStatusSchema = z.enum(factClaimStatuses);
export const meRoleSchema = z.enum(meRoles);
export const dimensionTypeSchema = z.enum(dimensionTypes);
export const dimensionSourceSchema = z.enum(dimensionSources);
export const claimFeedbackActionSchema = z.enum(claimFeedbackActions);
export const rollupScopeTypeSchema = z.enum(rollupScopeTypes);
export const rollupPeriodTypeSchema = z.enum(rollupPeriodTypes);

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
  analysisState: entryAnalysisStateSchema.default("not_requested"),
  latestAnalysisJobId: z.string().optional(),
  analysisStatus: analysisJobItemStatusSchema.optional(),
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
  replaceExisting: z.boolean().default(true),
  llmModel: z.string().trim().min(1).max(100).optional(),
  reasoningEffort: analysisReasoningEffortSchema.default("none"),
  priority: analysisPrioritySchema.default("normal"),
});

export const analysisEntryResultSchema = z.object({
  entryId: z.string().uuid(),
  documentId: z.string().optional(),
  jobItemId: z.string().optional(),
  extractionId: z.string().optional(),
  status: analysisJobItemStatusSchema.or(z.literal("error")),
  message: z.string().optional(),
  claimsInserted: z.number().int().min(0).default(0),
  attemptCount: z.number().int().min(0).default(0),
  model: z.string().optional(),
  reasoningEffort: analysisReasoningEffortSchema.optional(),
  errorCode: z.string().optional(),
  errorSummary: z.string().optional(),
  nextRetryAtUtc: z.string().datetime({ offset: true }).optional(),
});

export const runAnalysisResultSchema = z.object({
  jobId: z.string().uuid(),
  requested: z.number().int().min(0),
  succeeded: z.number().int().min(0),
  failed: z.number().int().min(0),
  replaceExisting: z.boolean(),
  results: z.array(analysisEntryResultSchema),
});

export const analysisJobItemSchema = z.object({
  id: z.string().uuid(),
  jobId: z.string().uuid(),
  entryId: z.string().uuid(),
  documentId: z.string().optional(),
  extractionId: z.string().optional(),
  status: analysisJobItemStatusSchema,
  attemptCount: z.number().int().min(0),
  claimsInserted: z.number().int().min(0),
  model: z.string().optional(),
  reasoningEffort: analysisReasoningEffortSchema.optional(),
  errorCode: z.string().optional(),
  errorSummary: z.string().optional(),
  nextRetryAtUtc: z.string().datetime({ offset: true }).optional(),
  lastError: z.string().optional(),
  createdAtUtc: z.string().datetime({ offset: true }),
  updatedAtUtc: z.string().datetime({ offset: true }),
});

export const analysisJobSchema = z.object({
  id: z.string().uuid(),
  triggerMode: z.enum(["manual", "retry", "system"]),
  status: analysisJobStatusSchema,
  requestedBy: z.string(),
  extractorVersion: z.string(),
  requestedAtUtc: z.string().datetime({ offset: true }),
  startedAtUtc: z.string().datetime({ offset: true }).optional(),
  finishedAtUtc: z.string().datetime({ offset: true }).optional(),
  totalItems: z.number().int().min(0),
  succeededItems: z.number().int().min(0),
  failedItems: z.number().int().min(0),
  errorSummary: z.string().optional(),
  items: z.array(analysisJobItemSchema).default([]),
});

export const analysisJobQuerySchema = z.object({
  status: analysisJobStatusSchema.optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const analysisModelSchema = z.object({
  id: z.string(),
  label: z.string(),
  supportsReasoningEffort: z.boolean(),
  defaultReasoningEffort: analysisReasoningEffortSchema,
});

export const factEvidenceSpanSchema = z.object({
  id: z.string(),
  claimId: z.string(),
  documentId: z.string(),
  charStart: z.number().int().min(0).optional(),
  charEnd: z.number().int().min(0).optional(),
  excerpt: z.string(),
  createdAtUtc: z.string().datetime({ offset: true }),
});

export const factClaimDimensionSchema = z.object({
  id: z.string(),
  claimId: z.string(),
  dimensionType: dimensionTypeSchema,
  dimensionValue: z.string(),
  normalizedValue: z.string(),
  confidence: z.number().min(0).max(1),
  source: dimensionSourceSchema,
  createdAtUtc: z.string().datetime({ offset: true }),
});

export const factClaimFeedbackSchema = z.object({
  id: z.string(),
  claimId: z.string(),
  action: claimFeedbackActionSchema,
  actor: z.string(),
  beforeJson: z.string(),
  afterJson: z.string(),
  createdAtUtc: z.string().datetime({ offset: true }),
});

export const factClaimSchema = z.object({
  id: z.string(),
  documentId: z.string(),
  entryId: z.string().uuid(),
  extractionId: z.string().optional(),
  subjectText: z.string(),
  subjectEntityId: z.string().optional(),
  predicate: z.string(),
  objectTextRaw: z.string(),
  objectTextCanonical: z.string(),
  objectEntityId: z.string().optional(),
  meRole: meRoleSchema,
  modality: factModalitySchema,
  polarity: factPolaritySchema,
  certainty: z.number().min(0).max(1),
  qualityScore: z.number().min(0).max(1),
  qualityFlags: z.array(z.string()).default([]),
  revisionNote: z.string().optional(),
  timeStartUtc: z.string().datetime({ offset: true }).optional(),
  timeEndUtc: z.string().datetime({ offset: true }).optional(),
  status: factClaimStatusSchema,
  extractorVersion: z.string(),
  createdAtUtc: z.string().datetime({ offset: true }),
  updatedAtUtc: z.string().datetime({ offset: true }),
  evidenceSpans: z.array(factEvidenceSpanSchema).default([]),
  dimensions: z.array(factClaimDimensionSchema).default([]),
  feedback: z.array(factClaimFeedbackSchema).default([]),
});

export const factClaimQuerySchema = z.object({
  text: z.string().trim().min(1).optional(),
  type: entryTypeSchema.optional(),
  modality: factModalitySchema.optional(),
  predicate: z.string().trim().min(1).max(80).optional(),
  meRole: meRoleSchema.optional(),
  dimensionType: dimensionTypeSchema.optional(),
  dimensionValue: z.string().trim().min(1).optional(),
  fromUtc: z.string().datetime({ offset: true }).optional(),
  toUtc: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const factSearchQuerySchema = factClaimQuerySchema;

export const reviseFactClaimInputSchema = z.object({
  objectTextCanonical: z.string().trim().min(1).max(1000),
  revisionNote: z.string().trim().max(500).optional(),
});

export const retractFactClaimInputSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const rollupSchema = z.object({
  id: z.string(),
  scopeType: rollupScopeTypeSchema,
  scopeKey: z.string(),
  periodType: rollupPeriodTypeSchema,
  periodStartUtc: z.string().datetime({ offset: true }),
  periodEndUtc: z.string().datetime({ offset: true }),
  summaryText: z.string(),
  keyClaimIds: z.array(z.string()).default([]),
  generatedByModel: z.string().optional(),
  createdAtUtc: z.string().datetime({ offset: true }),
  updatedAtUtc: z.string().datetime({ offset: true }),
});

export const rollupQuerySchema = z.object({
  scopeType: rollupScopeTypeSchema.optional(),
  scopeKey: z.string().optional(),
  periodType: rollupPeriodTypeSchema.optional(),
  fromUtc: z.string().datetime({ offset: true }).optional(),
  toUtc: z.string().datetime({ offset: true }).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

export const rebuildRollupsInputSchema = z.object({
  periodType: rollupPeriodTypeSchema,
  fromUtc: z.string().datetime({ offset: true }),
  toUtc: z.string().datetime({ offset: true }),
  llmModel: z.string().trim().min(1).max(100).optional(),
  scopeType: rollupScopeTypeSchema.default("all"),
  scopeKey: z.string().default("all"),
});

export type EntryType = z.infer<typeof entryTypeSchema>;
export type Entry = z.infer<typeof entrySchema>;
export type CreateEntryInput = z.infer<typeof createEntryInputSchema>;
export type CaptureTextInput = z.infer<typeof captureTextInputSchema>;
export type ListQuery = z.infer<typeof listQuerySchema>;
export type SearchQuery = z.infer<typeof searchQuerySchema>;
export type SearchResult = z.infer<typeof searchResultSchema>;
export type HistoryRecord = z.infer<typeof historySchema>;
export type OpenAiRequestQuery = z.infer<typeof openAiRequestQuerySchema>;
export type OpenAiCostSummaryQuery = z.infer<typeof openAiCostSummaryQuerySchema>;
export type OpenAiRequestRecord = z.infer<typeof openAiRequestRecordSchema>;
export type OpenAiCostBucket = z.infer<typeof openAiCostBucketSchema>;
export type OpenAiCostSummary = z.infer<typeof openAiCostSummarySchema>;
export type RunAnalysisInput = z.infer<typeof runAnalysisInputSchema>;
export type AnalysisEntryResult = z.infer<typeof analysisEntryResultSchema>;
export type RunAnalysisResult = z.infer<typeof runAnalysisResultSchema>;
export type AnalysisJobStatus = z.infer<typeof analysisJobStatusSchema>;
export type AnalysisJobItemStatus = z.infer<typeof analysisJobItemStatusSchema>;
export type AnalysisReasoningEffort = z.infer<typeof analysisReasoningEffortSchema>;
export type AnalysisPriority = z.infer<typeof analysisPrioritySchema>;
export type AnalysisModel = z.infer<typeof analysisModelSchema>;
export type AnalysisJob = z.infer<typeof analysisJobSchema>;
export type AnalysisJobItem = z.infer<typeof analysisJobItemSchema>;
export type AnalysisJobQuery = z.infer<typeof analysisJobQuerySchema>;
export type FactModality = z.infer<typeof factModalitySchema>;
export type FactPolarity = z.infer<typeof factPolaritySchema>;
export type MeRole = z.infer<typeof meRoleSchema>;
export type DimensionType = z.infer<typeof dimensionTypeSchema>;
export type FactClaim = z.infer<typeof factClaimSchema>;
export type FactEvidenceSpan = z.infer<typeof factEvidenceSpanSchema>;
export type FactClaimDimension = z.infer<typeof factClaimDimensionSchema>;
export type FactClaimFeedback = z.infer<typeof factClaimFeedbackSchema>;
export type FactSearchQuery = z.infer<typeof factSearchQuerySchema>;
export type Rollup = z.infer<typeof rollupSchema>;
export type RollupQuery = z.infer<typeof rollupQuerySchema>;
export type RebuildRollupsInput = z.infer<typeof rebuildRollupsInputSchema>;

export function validatePayload(type: EntryType, payload: unknown) {
  return payloadByTypeSchema[type].parse(payload);
}
