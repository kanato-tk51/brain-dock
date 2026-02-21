PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL, -- cli, mobile, browser, import
  detail TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS captures_raw (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL,
  input_type TEXT NOT NULL, -- note, task, url, quick
  raw_text TEXT NOT NULL,
  occurred_at TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'internal', -- public, internal, sensitive
  pii_score REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'new', -- new, blocked, processed, archived
  parsed_note_id TEXT,
  parsed_task_id TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

CREATE TABLE IF NOT EXISTS notes (
  id TEXT PRIMARY KEY,
  source_capture_id TEXT,
  note_type TEXT NOT NULL, -- journal, learning, thought
  title TEXT,
  summary TEXT,
  body TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  journal_date TEXT, -- YYYY-MM-DD, journal only
  mood_score INTEGER, -- 1-5, optional for journal
  energy_score INTEGER, -- 1-5, optional for journal
  source_url TEXT, -- for learning notes
  source_id TEXT,
  sensitivity TEXT NOT NULL DEFAULT 'internal',
  review_status TEXT NOT NULL DEFAULT 'active', -- active, archived
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  CHECK (note_type IN ('journal', 'learning', 'thought')),
  CHECK (mood_score IS NULL OR mood_score BETWEEN 1 AND 5),
  CHECK (energy_score IS NULL OR energy_score BETWEEN 1 AND 5),
  FOREIGN KEY (source_capture_id) REFERENCES captures_raw(id),
  FOREIGN KEY (source_id) REFERENCES sources(id)
);

CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  source_capture_id TEXT,
  source_note_id TEXT,
  title TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'todo', -- todo, next, doing, done, canceled, someday
  priority INTEGER NOT NULL DEFAULT 3,
  due_at TEXT,
  scheduled_at TEXT,
  done_at TEXT,
  source TEXT NOT NULL DEFAULT 'manual', -- manual, extracted
  sensitivity TEXT NOT NULL DEFAULT 'internal',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  CHECK (status IN ('todo', 'next', 'doing', 'done', 'canceled', 'someday')),
  CHECK (priority BETWEEN 1 AND 4),
  FOREIGN KEY (source_capture_id) REFERENCES captures_raw(id),
  FOREIGN KEY (source_note_id) REFERENCES notes(id)
);

CREATE TABLE IF NOT EXISTS tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS note_tags (
  note_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (note_id, tag_id),
  FOREIGN KEY (note_id) REFERENCES notes(id),
  FOREIGN KEY (tag_id) REFERENCES tags(id)
);

CREATE TABLE IF NOT EXISTS task_tags (
  task_id TEXT NOT NULL,
  tag_id TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, tag_id),
  FOREIGN KEY (task_id) REFERENCES tasks(id),
  FOREIGN KEY (tag_id) REFERENCES tags(id)
);

CREATE TABLE IF NOT EXISTS note_links (
  from_note_id TEXT NOT NULL,
  to_note_id TEXT NOT NULL,
  relation_type TEXT NOT NULL DEFAULT 'related', -- related, caused_by, follow_up
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (from_note_id, to_note_id, relation_type),
  FOREIGN KEY (from_note_id) REFERENCES notes(id),
  FOREIGN KEY (to_note_id) REFERENCES notes(id)
);

CREATE TABLE IF NOT EXISTS key_facts (
  id TEXT PRIMARY KEY,
  note_id TEXT,
  task_id TEXT,
  subject TEXT NOT NULL,
  predicate TEXT NOT NULL,
  object_text TEXT NOT NULL,
  object_type TEXT NOT NULL DEFAULT 'text', -- text, number, date, bool, json
  object_json TEXT,
  evidence_excerpt TEXT,
  occurred_at TEXT,
  confidence REAL NOT NULL DEFAULT 0.80,
  sensitivity TEXT NOT NULL DEFAULT 'internal',
  extractor_version TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  deleted_at TEXT,
  CHECK ((note_id IS NOT NULL AND task_id IS NULL) OR (note_id IS NULL AND task_id IS NOT NULL)),
  CHECK (object_type IN ('text', 'number', 'date', 'bool', 'json')),
  CHECK (confidence BETWEEN 0 AND 1),
  FOREIGN KEY (note_id) REFERENCES notes(id),
  FOREIGN KEY (task_id) REFERENCES tasks(id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  action TEXT NOT NULL, -- read, search, export, delete, block
  target_type TEXT,
  target_id TEXT,
  result TEXT,
  meta_json TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts USING fts5(
  note_id UNINDEXED,
  title,
  summary,
  body
);

CREATE VIRTUAL TABLE IF NOT EXISTS tasks_fts USING fts5(
  task_id UNINDEXED,
  title,
  details
);

CREATE VIRTUAL TABLE IF NOT EXISTS key_facts_fts USING fts5(
  fact_id UNINDEXED,
  subject,
  predicate,
  object_text,
  evidence_excerpt
);

CREATE TRIGGER IF NOT EXISTS trg_notes_ai AFTER INSERT ON notes BEGIN
  INSERT INTO notes_fts(note_id, title, summary, body)
  VALUES (new.id, coalesce(new.title, ''), coalesce(new.summary, ''), new.body);
END;

CREATE TRIGGER IF NOT EXISTS trg_notes_au AFTER UPDATE ON notes BEGIN
  DELETE FROM notes_fts WHERE note_id = old.id;
  INSERT INTO notes_fts(note_id, title, summary, body)
  VALUES (new.id, coalesce(new.title, ''), coalesce(new.summary, ''), new.body);
END;

CREATE TRIGGER IF NOT EXISTS trg_notes_ad AFTER DELETE ON notes BEGIN
  DELETE FROM notes_fts WHERE note_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_ai AFTER INSERT ON tasks BEGIN
  INSERT INTO tasks_fts(task_id, title, details)
  VALUES (new.id, new.title, coalesce(new.details, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_au AFTER UPDATE ON tasks BEGIN
  DELETE FROM tasks_fts WHERE task_id = old.id;
  INSERT INTO tasks_fts(task_id, title, details)
  VALUES (new.id, new.title, coalesce(new.details, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_ad AFTER DELETE ON tasks BEGIN
  DELETE FROM tasks_fts WHERE task_id = old.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_key_facts_ai AFTER INSERT ON key_facts BEGIN
  INSERT INTO key_facts_fts(fact_id, subject, predicate, object_text, evidence_excerpt)
  VALUES (new.id, new.subject, new.predicate, new.object_text, coalesce(new.evidence_excerpt, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_key_facts_au AFTER UPDATE ON key_facts BEGIN
  DELETE FROM key_facts_fts WHERE fact_id = old.id;
  INSERT INTO key_facts_fts(fact_id, subject, predicate, object_text, evidence_excerpt)
  VALUES (new.id, new.subject, new.predicate, new.object_text, coalesce(new.evidence_excerpt, ''));
END;

CREATE TRIGGER IF NOT EXISTS trg_key_facts_ad AFTER DELETE ON key_facts BEGIN
  DELETE FROM key_facts_fts WHERE fact_id = old.id;
END;

CREATE VIEW IF NOT EXISTS v_ai_memory_items AS
SELECT
  'note' AS item_type,
  n.id AS item_id,
  n.note_type AS subtype,
  coalesce(n.title, '') AS title,
  coalesce(n.summary, '') AS summary,
  n.body AS content,
  n.occurred_at AS occurred_at,
  '' AS status,
  NULL AS priority,
  n.sensitivity AS sensitivity
FROM notes n
WHERE n.deleted_at IS NULL
UNION ALL
SELECT
  'task' AS item_type,
  t.id AS item_id,
  t.status AS subtype,
  t.title AS title,
  coalesce(t.details, '') AS summary,
  coalesce(t.details, t.title) AS content,
  coalesce(t.done_at, t.due_at, t.scheduled_at, t.created_at) AS occurred_at,
  t.status AS status,
  t.priority AS priority,
  t.sensitivity AS sensitivity
FROM tasks t
WHERE t.deleted_at IS NULL;

CREATE VIEW IF NOT EXISTS v_ai_key_facts AS
SELECT
  k.id AS fact_id,
  CASE WHEN k.note_id IS NOT NULL THEN 'note' ELSE 'task' END AS source_type,
  coalesce(k.note_id, k.task_id) AS source_id,
  k.subject,
  k.predicate,
  k.object_text,
  k.object_type,
  k.object_json,
  k.evidence_excerpt,
  k.occurred_at,
  k.confidence,
  k.sensitivity
FROM key_facts k
LEFT JOIN notes n ON n.id = k.note_id
LEFT JOIN tasks t ON t.id = k.task_id
WHERE k.deleted_at IS NULL
  AND (k.note_id IS NULL OR n.deleted_at IS NULL)
  AND (k.task_id IS NULL OR t.deleted_at IS NULL);

CREATE INDEX IF NOT EXISTS idx_notes_type_time ON notes(note_type, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_notes_journal_date ON notes(journal_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notes_source_capture_active
  ON notes(source_capture_id)
  WHERE source_capture_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_captures_status_created ON captures_raw(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_tasks_status_due ON tasks(status, due_at);
CREATE INDEX IF NOT EXISTS idx_tasks_priority ON tasks(priority, status);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tasks_source_capture_active
  ON tasks(source_capture_id)
  WHERE source_capture_id IS NOT NULL AND deleted_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_key_facts_subject_predicate ON key_facts(subject, predicate);
CREATE INDEX IF NOT EXISTS idx_key_facts_object_text ON key_facts(object_text);
CREATE INDEX IF NOT EXISTS idx_key_facts_note ON key_facts(note_id);
CREATE INDEX IF NOT EXISTS idx_key_facts_task ON key_facts(task_id);
CREATE INDEX IF NOT EXISTS idx_key_facts_occurred_confidence ON key_facts(occurred_at DESC, confidence DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_key_facts_note_unique_active
  ON key_facts(note_id, subject, predicate, object_text)
  WHERE note_id IS NOT NULL AND deleted_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_key_facts_task_unique_active
  ON key_facts(task_id, subject, predicate, object_text)
  WHERE task_id IS NOT NULL AND deleted_at IS NULL;
