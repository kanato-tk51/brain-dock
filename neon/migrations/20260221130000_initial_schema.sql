-- brain-dock initial schema for Neon (PostgreSQL)
-- This migration mirrors the current core model with PostgreSQL-compatible types.

begin;

create table if not exists public.sources (
  id text primary key,
  kind text not null,
  detail text,
  created_at timestamptz not null default now()
);

create table if not exists public.captures_raw (
  id text primary key,
  source_id text not null references public.sources(id),
  input_type text not null,
  raw_text text not null,
  occurred_at timestamptz,
  sensitivity text not null default 'internal',
  pii_score double precision not null default 0,
  status text not null default 'new',
  parsed_note_id text,
  parsed_task_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint captures_raw_input_type_check check (input_type in ('note', 'task', 'url', 'quick')),
  constraint captures_raw_sensitivity_check check (sensitivity in ('public', 'internal', 'sensitive')),
  constraint captures_raw_status_check check (status in ('new', 'blocked', 'processed', 'archived')),
  constraint captures_raw_pii_score_check check (pii_score >= 0 and pii_score <= 1)
);

create table if not exists public.notes (
  id text primary key,
  source_capture_id text references public.captures_raw(id),
  note_type text not null,
  title text,
  summary text,
  body text not null,
  occurred_at text not null,
  journal_date text,
  mood_score integer,
  energy_score integer,
  source_url text,
  source_id text references public.sources(id),
  sensitivity text not null default 'internal',
  review_status text not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint notes_note_type_check check (note_type in ('journal', 'learning', 'thought')),
  constraint notes_mood_score_check check (mood_score is null or mood_score between 1 and 5),
  constraint notes_energy_score_check check (energy_score is null or energy_score between 1 and 5),
  constraint notes_sensitivity_check check (sensitivity in ('public', 'internal', 'sensitive')),
  constraint notes_review_status_check check (review_status in ('active', 'archived'))
);

create table if not exists public.tasks (
  id text primary key,
  source_capture_id text references public.captures_raw(id),
  source_note_id text references public.notes(id),
  title text not null,
  details text,
  status text not null default 'todo',
  priority integer not null default 3,
  due_at text,
  scheduled_at text,
  done_at text,
  source text not null default 'manual',
  sensitivity text not null default 'internal',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint tasks_status_check check (status in ('todo', 'next', 'doing', 'done', 'canceled', 'someday')),
  constraint tasks_priority_check check (priority between 1 and 4),
  constraint tasks_source_check check (source in ('manual', 'extracted')),
  constraint tasks_sensitivity_check check (sensitivity in ('public', 'internal', 'sensitive'))
);

create table if not exists public.tags (
  id text primary key,
  name text not null unique,
  created_at timestamptz not null default now()
);

create table if not exists public.note_tags (
  note_id text not null references public.notes(id),
  tag_id text not null references public.tags(id),
  created_at timestamptz not null default now(),
  primary key (note_id, tag_id)
);

create table if not exists public.task_tags (
  task_id text not null references public.tasks(id),
  tag_id text not null references public.tags(id),
  created_at timestamptz not null default now(),
  primary key (task_id, tag_id)
);

create table if not exists public.note_links (
  from_note_id text not null references public.notes(id),
  to_note_id text not null references public.notes(id),
  relation_type text not null default 'related',
  created_at timestamptz not null default now(),
  primary key (from_note_id, to_note_id, relation_type),
  constraint note_links_relation_type_check check (relation_type in ('related', 'caused_by', 'follow_up'))
);

create table if not exists public.key_facts (
  id text primary key,
  note_id text references public.notes(id),
  task_id text references public.tasks(id),
  subject text not null,
  predicate text not null,
  object_text text not null,
  object_type text not null default 'text',
  object_json text,
  evidence_excerpt text,
  occurred_at text,
  confidence double precision not null default 0.80,
  sensitivity text not null default 'internal',
  extractor_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  constraint key_facts_source_check check (
    (note_id is not null and task_id is null) or
    (note_id is null and task_id is not null)
  ),
  constraint key_facts_object_type_check check (object_type in ('text', 'number', 'date', 'bool', 'json')),
  constraint key_facts_confidence_check check (confidence >= 0 and confidence <= 1),
  constraint key_facts_sensitivity_check check (sensitivity in ('public', 'internal', 'sensitive'))
);

create table if not exists public.audit_events (
  id text primary key,
  actor text not null,
  action text not null,
  target_type text,
  target_id text,
  result text,
  meta_json text,
  created_at timestamptz not null default now()
);

create or replace view public.v_ai_memory_items as
select
  'note'::text as item_type,
  n.id as item_id,
  n.note_type as subtype,
  coalesce(n.title, '') as title,
  coalesce(n.summary, '') as summary,
  n.body as content,
  n.occurred_at as occurred_at,
  ''::text as status,
  null::integer as priority,
  n.sensitivity as sensitivity
from public.notes n
where n.deleted_at is null
union all
select
  'task'::text as item_type,
  t.id as item_id,
  t.status as subtype,
  t.title as title,
  coalesce(t.details, '') as summary,
  coalesce(t.details, t.title) as content,
  coalesce(t.done_at, t.due_at, t.scheduled_at, t.created_at::text) as occurred_at,
  t.status as status,
  t.priority as priority,
  t.sensitivity as sensitivity
from public.tasks t
where t.deleted_at is null;

create or replace view public.v_ai_key_facts as
select
  k.id as fact_id,
  case when k.note_id is not null then 'note' else 'task' end as source_type,
  coalesce(k.note_id, k.task_id) as source_id,
  k.subject,
  k.predicate,
  k.object_text,
  k.object_type,
  k.object_json,
  k.evidence_excerpt,
  k.occurred_at,
  k.confidence,
  k.sensitivity
from public.key_facts k
left join public.notes n on n.id = k.note_id
left join public.tasks t on t.id = k.task_id
where k.deleted_at is null
  and (k.note_id is null or n.deleted_at is null)
  and (k.task_id is null or t.deleted_at is null);

create index if not exists idx_notes_type_time on public.notes(note_type, occurred_at desc);
create index if not exists idx_notes_journal_date on public.notes(journal_date desc);
create unique index if not exists idx_notes_source_capture_active
  on public.notes(source_capture_id)
  where source_capture_id is not null and deleted_at is null;

create index if not exists idx_captures_status_created on public.captures_raw(status, created_at desc);

create index if not exists idx_tasks_status_due on public.tasks(status, due_at);
create index if not exists idx_tasks_priority on public.tasks(priority, status);
create unique index if not exists idx_tasks_source_capture_active
  on public.tasks(source_capture_id)
  where source_capture_id is not null and deleted_at is null;

create index if not exists idx_key_facts_subject_predicate on public.key_facts(subject, predicate);
create index if not exists idx_key_facts_object_text on public.key_facts(object_text);
create index if not exists idx_key_facts_note on public.key_facts(note_id);
create index if not exists idx_key_facts_task on public.key_facts(task_id);
create index if not exists idx_key_facts_occurred_confidence on public.key_facts(occurred_at desc, confidence desc);
create unique index if not exists idx_key_facts_note_unique_active
  on public.key_facts(note_id, subject, predicate, object_text)
  where note_id is not null and deleted_at is null;
create unique index if not exists idx_key_facts_task_unique_active
  on public.key_facts(task_id, subject, predicate, object_text)
  where task_id is not null and deleted_at is null;

commit;
