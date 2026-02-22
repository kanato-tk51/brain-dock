PRAGMA foreign_keys = ON;

ALTER TABLE app_entries ADD COLUMN analysis_state TEXT NOT NULL DEFAULT 'not_requested';
ALTER TABLE app_entries ADD COLUMN latest_analysis_job_id TEXT;

ALTER TABLE fact_documents ADD COLUMN language TEXT;
ALTER TABLE fact_documents ADD COLUMN normalized_text TEXT;
ALTER TABLE fact_documents ADD COLUMN token_count INTEGER;
ALTER TABLE fact_documents ADD COLUMN analysis_state TEXT NOT NULL DEFAULT 'ready';
ALTER TABLE fact_documents ADD COLUMN last_analyzed_at TEXT;

CREATE TABLE IF NOT EXISTS fact_extractions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  job_id TEXT,
  job_item_id TEXT,
  model TEXT NOT NULL,
  reasoning_effort TEXT NOT NULL DEFAULT 'none' CHECK (reasoning_effort IN ('none', 'low', 'medium', 'high')),
  schema_version TEXT NOT NULL DEFAULT 'v2',
  prompt_version TEXT NOT NULL DEFAULT 'v2',
  status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'blocked', 'queued_retry')),
  request_tokens_in INTEGER NOT NULL DEFAULT 0,
  request_tokens_out INTEGER NOT NULL DEFAULT 0,
  request_cost_usd REAL NOT NULL DEFAULT 0,
  error_code TEXT,
  error_summary TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (document_id) REFERENCES fact_documents(id) ON DELETE CASCADE,
  FOREIGN KEY (entry_id) REFERENCES app_entries(id) ON DELETE CASCADE,
  FOREIGN KEY (job_id) REFERENCES fact_extraction_jobs(id) ON DELETE SET NULL,
  FOREIGN KEY (job_item_id) REFERENCES fact_extraction_job_items(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_fact_extractions_document ON fact_extractions(document_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fact_extractions_entry ON fact_extractions(entry_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fact_extractions_status ON fact_extractions(status, created_at DESC);

ALTER TABLE fact_claims ADD COLUMN extraction_id TEXT;
ALTER TABLE fact_claims ADD COLUMN object_text_raw TEXT;
ALTER TABLE fact_claims ADD COLUMN object_text_canonical TEXT;
ALTER TABLE fact_claims ADD COLUMN me_role TEXT NOT NULL DEFAULT 'none';
ALTER TABLE fact_claims ADD COLUMN quality_score REAL NOT NULL DEFAULT 0;
ALTER TABLE fact_claims ADD COLUMN quality_flags TEXT NOT NULL DEFAULT '[]';
ALTER TABLE fact_claims ADD COLUMN revision_note TEXT;

UPDATE fact_claims
SET object_text_raw = COALESCE(object_text_raw, object_text)
WHERE object_text_raw IS NULL;

UPDATE fact_claims
SET object_text_canonical = COALESCE(object_text_canonical, object_text_raw, object_text)
WHERE object_text_canonical IS NULL;

INSERT OR IGNORE INTO fact_extractions (
  id,
  document_id,
  entry_id,
  model,
  reasoning_effort,
  schema_version,
  prompt_version,
  status,
  request_tokens_in,
  request_tokens_out,
  request_cost_usd,
  started_at,
  finished_at,
  created_at,
  updated_at
)
SELECT
  'legacy-extraction-' || id,
  document_id,
  entry_id,
  COALESCE(NULLIF(extractor_version, ''), 'legacy'),
  'none',
  'v1',
  'legacy',
  'succeeded',
  0,
  0,
  0,
  created_at,
  updated_at,
  created_at,
  updated_at
FROM fact_claims
WHERE extraction_id IS NULL;

UPDATE fact_claims
SET extraction_id = 'legacy-extraction-' || id
WHERE extraction_id IS NULL;

CREATE TABLE IF NOT EXISTS fact_claim_dimensions (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  dimension_type TEXT NOT NULL CHECK (dimension_type IN ('person', 'place', 'activity', 'emotion', 'health', 'topic', 'project', 'item', 'reason', 'time_hint')),
  dimension_value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
  source TEXT NOT NULL DEFAULT 'llm' CHECK (source IN ('llm', 'rule', 'manual')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (claim_id, dimension_type, normalized_value, source),
  FOREIGN KEY (claim_id) REFERENCES fact_claims(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fact_claim_dimensions_type_norm
  ON fact_claim_dimensions(dimension_type, normalized_value, confidence DESC);
CREATE INDEX IF NOT EXISTS idx_fact_claim_dimensions_claim
  ON fact_claim_dimensions(claim_id);

CREATE TABLE IF NOT EXISTS fact_rollups (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('all', 'entry_type', 'topic', 'project')),
  scope_key TEXT NOT NULL,
  period_type TEXT NOT NULL CHECK (period_type IN ('daily', 'weekly', 'monthly', 'custom')),
  period_start_utc TEXT NOT NULL,
  period_end_utc TEXT NOT NULL,
  summary_text TEXT NOT NULL,
  key_claim_ids TEXT NOT NULL DEFAULT '[]',
  generated_by_model TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (scope_type, scope_key, period_type, period_start_utc, period_end_utc)
);

CREATE INDEX IF NOT EXISTS idx_fact_rollups_scope_period
  ON fact_rollups(scope_type, period_type, period_start_utc DESC);

CREATE TABLE IF NOT EXISTS fact_analysis_artifacts (
  id TEXT PRIMARY KEY,
  extraction_id TEXT NOT NULL,
  artifact_type TEXT NOT NULL CHECK (artifact_type IN ('prompt_meta', 'response_meta', 'validation_error')),
  sha256 TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  expires_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (extraction_id) REFERENCES fact_extractions(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fact_analysis_artifacts_extraction
  ON fact_analysis_artifacts(extraction_id, created_at DESC);

CREATE TABLE IF NOT EXISTS fact_claim_feedback (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('revise', 'supersede', 'retract', 'restore')),
  before_json TEXT NOT NULL,
  after_json TEXT NOT NULL,
  actor TEXT NOT NULL DEFAULT 'user',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY (claim_id) REFERENCES fact_claims(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fact_claim_feedback_claim
  ON fact_claim_feedback(claim_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fact_claims_entry_created
  ON fact_claims(entry_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fact_claims_pred_mod_cert
  ON fact_claims(predicate, modality, certainty DESC);
CREATE INDEX IF NOT EXISTS idx_fact_claims_object_canonical
  ON fact_claims(object_text_canonical);
