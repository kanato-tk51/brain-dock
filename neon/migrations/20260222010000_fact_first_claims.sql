begin;

do $$
begin
  if to_regclass('public.notes') is not null and to_regclass('public.notes_legacy') is null then
    alter table public.notes rename to notes_legacy;
  end if;
  if to_regclass('public.tasks') is not null and to_regclass('public.tasks_legacy') is null then
    alter table public.tasks rename to tasks_legacy;
  end if;
  if to_regclass('public.key_facts') is not null and to_regclass('public.key_facts_legacy') is null then
    alter table public.key_facts rename to key_facts_legacy;
  end if;
end $$;

create table if not exists public.fact_documents (
  id text primary key,
  entry_id text not null references public.app_entries(id) on delete cascade,
  capture_id text references public.captures_raw(id) on delete set null,
  declared_type text not null check (declared_type in ('journal', 'todo', 'learning', 'thought', 'meeting')),
  raw_text text not null,
  occurred_at_utc timestamptz not null,
  sensitivity text not null default 'internal' check (sensitivity in ('public', 'internal', 'sensitive')),
  pii_score double precision not null default 0 check (pii_score >= 0 and pii_score <= 1),
  redaction_state text not null default 'none' check (redaction_state in ('none', 'masked', 'blocked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(entry_id)
);

create table if not exists public.fact_entities (
  id text primary key,
  entity_type text not null check (entity_type in ('person', 'organization', 'project', 'place', 'concept', 'other')),
  canonical_name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(entity_type, canonical_name)
);

create table if not exists public.fact_entity_aliases (
  id text primary key,
  entity_id text not null references public.fact_entities(id) on delete cascade,
  alias text not null,
  normalized_alias text not null,
  created_at timestamptz not null default now(),
  unique(entity_id, normalized_alias)
);

create table if not exists public.fact_claims (
  id text primary key,
  document_id text not null references public.fact_documents(id) on delete cascade,
  entry_id text not null references public.app_entries(id) on delete cascade,
  subject_text text not null,
  subject_entity_id text references public.fact_entities(id) on delete set null,
  predicate text not null,
  object_text text not null,
  object_entity_id text references public.fact_entities(id) on delete set null,
  modality text not null check (modality in ('fact', 'plan', 'hypothesis', 'request', 'feeling')),
  polarity text not null default 'affirm' check (polarity in ('affirm', 'negate')),
  certainty double precision not null default 0.8 check (certainty >= 0 and certainty <= 1),
  time_start_utc timestamptz,
  time_end_utc timestamptz,
  status text not null default 'active' check (status in ('active', 'retracted', 'superseded')),
  supersedes_claim_id text references public.fact_claims(id) on delete set null,
  extractor_version text not null default 'llm-gpt-4.1-mini',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists public.fact_evidence_spans (
  id text primary key,
  claim_id text not null references public.fact_claims(id) on delete cascade,
  document_id text not null references public.fact_documents(id) on delete cascade,
  char_start integer,
  char_end integer,
  excerpt text not null,
  created_at timestamptz not null default now(),
  constraint fact_evidence_span_order_check check (
    (char_start is null and char_end is null)
    or (char_start is not null and char_end is not null and char_start >= 0 and char_end > char_start)
  )
);

create table if not exists public.fact_claim_links (
  id text primary key,
  from_claim_id text not null references public.fact_claims(id) on delete cascade,
  to_claim_id text not null references public.fact_claims(id) on delete cascade,
  relation_type text not null check (relation_type in ('supports', 'contradicts', 'caused_by', 'follow_up', 'same_event')),
  confidence double precision not null default 0.8 check (confidence >= 0 and confidence <= 1),
  created_at timestamptz not null default now(),
  unique(from_claim_id, to_claim_id, relation_type)
);

create table if not exists public.fact_extraction_jobs (
  id text primary key,
  trigger_mode text not null check (trigger_mode in ('manual', 'retry', 'system')),
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed')),
  requested_by text not null default 'user',
  extractor_version text not null default 'llm-gpt-4.1-mini',
  requested_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  total_items integer not null default 0,
  succeeded_items integer not null default 0,
  failed_items integer not null default 0,
  error_summary text
);

create table if not exists public.fact_extraction_job_items (
  id text primary key,
  job_id text not null references public.fact_extraction_jobs(id) on delete cascade,
  entry_id text not null references public.app_entries(id) on delete cascade,
  document_id text references public.fact_documents(id) on delete set null,
  status text not null check (status in ('queued', 'running', 'succeeded', 'failed', 'blocked')),
  attempt_count integer not null default 0,
  next_retry_at timestamptz,
  last_error text,
  claims_inserted integer not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(job_id, entry_id)
);

create index if not exists idx_fact_documents_entry on public.fact_documents(entry_id);
create index if not exists idx_fact_documents_capture on public.fact_documents(capture_id);
create index if not exists idx_fact_claims_entry on public.fact_claims(entry_id, created_at desc);
create index if not exists idx_fact_claims_predicate on public.fact_claims(predicate, modality, certainty desc);
create index if not exists idx_fact_claims_subject on public.fact_claims(subject_text);
create index if not exists idx_fact_claims_object on public.fact_claims(object_text);
create index if not exists idx_fact_claims_time on public.fact_claims(time_start_utc desc);
create index if not exists idx_fact_evidence_claim on public.fact_evidence_spans(claim_id);
create index if not exists idx_fact_job_status on public.fact_extraction_jobs(status, requested_at desc);
create index if not exists idx_fact_job_items_entry on public.fact_extraction_job_items(entry_id, updated_at desc);
create index if not exists idx_fact_job_items_status on public.fact_extraction_job_items(status, next_retry_at);

insert into public.fact_documents (
  id,
  entry_id,
  capture_id,
  declared_type,
  raw_text,
  occurred_at_utc,
  sensitivity,
  pii_score,
  redaction_state,
  created_at,
  updated_at
)
select
  e.id as id,
  e.id as entry_id,
  c.id as capture_id,
  e.declared_type as declared_type,
  coalesce(c.raw_text, e.body, '') as raw_text,
  e.occurred_at_utc,
  e.sensitivity,
  greatest(coalesce(c.pii_score, 0), 0) as pii_score,
  case
    when coalesce(c.pii_score, 0) >= 0.90 then 'blocked'
    when coalesce(c.pii_score, 0) >= 0.50 then 'masked'
    else 'none'
  end as redaction_state,
  now(),
  now()
from public.app_entries e
left join lateral (
  select cr.id, cr.raw_text, cr.pii_score
  from public.captures_raw cr
  where cr.id = e.id
  order by cr.created_at desc
  limit 1
) c on true
where e.declared_type in ('journal', 'todo', 'learning', 'thought', 'meeting')
on conflict (id) do nothing;

do $$
begin
  if to_regclass('public.key_facts_legacy') is not null then
    insert into public.fact_claims (
      id,
      document_id,
      entry_id,
      subject_text,
      predicate,
      object_text,
      modality,
      polarity,
      certainty,
      time_start_utc,
      time_end_utc,
      status,
      extractor_version,
      created_at,
      updated_at
    )
    select
      'legacy-claim-' || k.id,
      coalesce(n.source_capture_id, t.source_capture_id),
      coalesce(n.source_capture_id, t.source_capture_id),
      k.subject,
      k.predicate,
      k.object_text,
      'fact',
      'affirm',
      coalesce(k.confidence, 0.8),
      case
        when k.occurred_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then (k.occurred_at)::timestamptz
        else null
      end,
      case
        when k.occurred_at ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}' then (k.occurred_at)::timestamptz
        else null
      end,
      'active',
      coalesce(k.extractor_version, 'legacy-key-facts'),
      now(),
      now()
    from public.key_facts_legacy k
    left join public.notes_legacy n on n.id = k.note_id
    left join public.tasks_legacy t on t.id = k.task_id
    where k.deleted_at is null
      and coalesce(n.source_capture_id, t.source_capture_id) is not null
      and exists (
        select 1
        from public.fact_documents d
        where d.id = coalesce(n.source_capture_id, t.source_capture_id)
      )
    on conflict (id) do nothing;

    insert into public.fact_evidence_spans (
      id,
      claim_id,
      document_id,
      char_start,
      char_end,
      excerpt,
      created_at
    )
    select
      'legacy-evidence-' || k.id,
      'legacy-claim-' || k.id,
      coalesce(n.source_capture_id, t.source_capture_id),
      null,
      null,
      coalesce(nullif(k.evidence_excerpt, ''), k.object_text),
      now()
    from public.key_facts_legacy k
    left join public.notes_legacy n on n.id = k.note_id
    left join public.tasks_legacy t on t.id = k.task_id
    where k.deleted_at is null
      and coalesce(n.source_capture_id, t.source_capture_id) is not null
      and exists (
        select 1
        from public.fact_documents d
        where d.id = coalesce(n.source_capture_id, t.source_capture_id)
      )
      and exists (
        select 1
        from public.fact_claims c
        where c.id = 'legacy-claim-' || k.id
      )
    on conflict (id) do nothing;
  end if;
end $$;

commit;
