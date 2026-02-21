PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS fact_documents (
  id TEXT PRIMARY KEY,
  entry_id TEXT NOT NULL,
  capture_id TEXT,
  declared_type TEXT NOT NULL CHECK (declared_type IN ('journal', 'todo', 'learning', 'thought', 'meeting')),
  raw_text TEXT NOT NULL,
  occurred_at_utc TEXT NOT NULL,
  sensitivity TEXT NOT NULL DEFAULT 'internal' CHECK (sensitivity IN ('public', 'internal', 'sensitive')),
  pii_score REAL NOT NULL DEFAULT 0 CHECK (pii_score >= 0 AND pii_score <= 1),
  redaction_state TEXT NOT NULL DEFAULT 'none' CHECK (redaction_state IN ('none', 'masked', 'blocked')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS fact_entities (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL CHECK (entity_type IN ('person', 'organization', 'project', 'place', 'concept', 'other')),
  canonical_name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_type, canonical_name)
);

CREATE TABLE IF NOT EXISTS fact_entity_aliases (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  alias TEXT NOT NULL,
  normalized_alias TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_id, normalized_alias),
  FOREIGN KEY (entity_id) REFERENCES fact_entities(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fact_claims (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  subject_text TEXT NOT NULL,
  subject_entity_id TEXT,
  predicate TEXT NOT NULL,
  object_text TEXT NOT NULL,
  object_entity_id TEXT,
  modality TEXT NOT NULL CHECK (modality IN ('fact', 'plan', 'hypothesis', 'request', 'feeling')),
  polarity TEXT NOT NULL DEFAULT 'affirm' CHECK (polarity IN ('affirm', 'negate')),
  certainty REAL NOT NULL DEFAULT 0.8 CHECK (certainty >= 0 AND certainty <= 1),
  time_start_utc TEXT,
  time_end_utc TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retracted', 'superseded')),
  supersedes_claim_id TEXT,
  extractor_version TEXT NOT NULL DEFAULT 'llm-gpt-4.1-mini',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  FOREIGN KEY (document_id) REFERENCES fact_documents(id) ON DELETE CASCADE,
  FOREIGN KEY (subject_entity_id) REFERENCES fact_entities(id) ON DELETE SET NULL,
  FOREIGN KEY (object_entity_id) REFERENCES fact_entities(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS fact_evidence_spans (
  id TEXT PRIMARY KEY,
  claim_id TEXT NOT NULL,
  document_id TEXT NOT NULL,
  char_start INTEGER,
  char_end INTEGER,
  excerpt TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (
    (char_start IS NULL AND char_end IS NULL) OR
    (char_start IS NOT NULL AND char_end IS NOT NULL AND char_start >= 0 AND char_end > char_start)
  ),
  FOREIGN KEY (claim_id) REFERENCES fact_claims(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES fact_documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fact_claim_links (
  id TEXT PRIMARY KEY,
  from_claim_id TEXT NOT NULL,
  to_claim_id TEXT NOT NULL,
  relation_type TEXT NOT NULL CHECK (relation_type IN ('supports', 'contradicts', 'caused_by', 'follow_up', 'same_event')),
  confidence REAL NOT NULL DEFAULT 0.8 CHECK (confidence >= 0 AND confidence <= 1),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (from_claim_id, to_claim_id, relation_type),
  FOREIGN KEY (from_claim_id) REFERENCES fact_claims(id) ON DELETE CASCADE,
  FOREIGN KEY (to_claim_id) REFERENCES fact_claims(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS fact_extraction_jobs (
  id TEXT PRIMARY KEY,
  trigger_mode TEXT NOT NULL CHECK (trigger_mode IN ('manual', 'retry', 'system')),
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
  requested_by TEXT NOT NULL DEFAULT 'user',
  extractor_version TEXT NOT NULL DEFAULT 'llm-gpt-4.1-mini',
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  finished_at TEXT,
  total_items INTEGER NOT NULL DEFAULT 0,
  succeeded_items INTEGER NOT NULL DEFAULT 0,
  failed_items INTEGER NOT NULL DEFAULT 0,
  error_summary TEXT
);

CREATE TABLE IF NOT EXISTS fact_extraction_job_items (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  entry_id TEXT NOT NULL,
  document_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'blocked')),
  attempt_count INTEGER NOT NULL DEFAULT 0,
  next_retry_at TEXT,
  last_error TEXT,
  claims_inserted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (job_id, entry_id),
  FOREIGN KEY (job_id) REFERENCES fact_extraction_jobs(id) ON DELETE CASCADE,
  FOREIGN KEY (document_id) REFERENCES fact_documents(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_fact_documents_entry ON fact_documents(entry_id);
CREATE INDEX IF NOT EXISTS idx_fact_claims_entry ON fact_claims(entry_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_fact_claims_predicate ON fact_claims(predicate, modality, certainty DESC);
CREATE INDEX IF NOT EXISTS idx_fact_evidence_claim ON fact_evidence_spans(claim_id);
CREATE INDEX IF NOT EXISTS idx_fact_job_status ON fact_extraction_jobs(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS idx_fact_job_item_status ON fact_extraction_job_items(status, next_retry_at);
