begin;

alter table if exists public.app_entries
  add column if not exists analysis_state text not null default 'not_requested';

alter table if exists public.app_entries
  add column if not exists latest_analysis_job_id text;

alter table if exists public.fact_documents
  add column if not exists language text;

alter table if exists public.fact_documents
  add column if not exists normalized_text text;

alter table if exists public.fact_documents
  add column if not exists token_count integer;

alter table if exists public.fact_documents
  add column if not exists analysis_state text not null default 'ready';

alter table if exists public.fact_documents
  add column if not exists last_analyzed_at timestamptz;

create table if not exists public.fact_extractions (
  id text primary key,
  document_id text not null references public.fact_documents(id) on delete cascade,
  entry_id text not null references public.app_entries(id) on delete cascade,
  job_id text references public.fact_extraction_jobs(id) on delete set null,
  job_item_id text references public.fact_extraction_job_items(id) on delete set null,
  model text not null,
  reasoning_effort text not null default 'none' check (reasoning_effort in ('none', 'low', 'medium', 'high')),
  schema_version text not null default 'v2',
  prompt_version text not null default 'v2',
  status text not null check (status in ('running', 'succeeded', 'failed', 'blocked', 'queued_retry')),
  request_tokens_in integer not null default 0,
  request_tokens_out integer not null default 0,
  request_cost_usd numeric(14, 6) not null default 0,
  error_code text,
  error_summary text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_fact_extractions_document on public.fact_extractions(document_id, created_at desc);
create index if not exists idx_fact_extractions_entry on public.fact_extractions(entry_id, created_at desc);
create index if not exists idx_fact_extractions_status on public.fact_extractions(status, created_at desc);

alter table if exists public.fact_claims
  add column if not exists extraction_id text;

alter table if exists public.fact_claims
  add column if not exists object_text_raw text;

alter table if exists public.fact_claims
  add column if not exists object_text_canonical text;

alter table if exists public.fact_claims
  add column if not exists me_role text default 'none';

alter table if exists public.fact_claims
  add column if not exists quality_score double precision not null default 0;

alter table if exists public.fact_claims
  add column if not exists quality_flags jsonb not null default '[]'::jsonb;

alter table if exists public.fact_claims
  add column if not exists revision_note text;

update public.fact_claims
set object_text_raw = coalesce(object_text_raw, object_text)
where object_text_raw is null;

update public.fact_claims
set object_text_canonical = coalesce(object_text_canonical, object_text_raw, object_text)
where object_text_canonical is null;

update public.fact_claims
set me_role = coalesce(me_role, 'none')
where me_role is null;

update public.fact_claims
set quality_score = case
  when quality_score = 0 then coalesce(certainty, 0)
  else quality_score
end;

insert into public.fact_extractions (
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
select
  'legacy-extraction-' || c.id,
  c.document_id,
  c.entry_id,
  coalesce(nullif(c.extractor_version, ''), 'legacy'),
  'none',
  'v1',
  'legacy',
  'succeeded',
  0,
  0,
  0,
  c.created_at,
  c.updated_at,
  c.created_at,
  c.updated_at
from public.fact_claims c
where c.extraction_id is null
on conflict (id) do nothing;

update public.fact_claims
set extraction_id = 'legacy-extraction-' || id
where extraction_id is null;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'fact_claims_me_role_check'
  ) then
    alter table public.fact_claims
      add constraint fact_claims_me_role_check
      check (me_role in ('actor', 'experiencer', 'observer', 'recipient', 'none'));
  end if;
end $$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'fact_claims_extraction_fk'
  ) then
    alter table public.fact_claims
      add constraint fact_claims_extraction_fk
      foreign key (extraction_id) references public.fact_extractions(id) on delete restrict;
  end if;
end $$;

alter table public.fact_claims
  alter column extraction_id set not null;

alter table public.fact_claims
  alter column object_text_raw set not null;

alter table public.fact_claims
  alter column object_text_canonical set not null;

alter table public.fact_claims
  alter column me_role set not null;

create index if not exists idx_fact_claims_fts_canonical
  on public.fact_claims using gin (to_tsvector('simple', object_text_canonical));

create index if not exists idx_fact_claims_entry_created
  on public.fact_claims(entry_id, created_at desc);

create index if not exists idx_fact_claims_pred_mod_cert
  on public.fact_claims(predicate, modality, certainty desc);

create table if not exists public.fact_claim_dimensions (
  id text primary key,
  claim_id text not null references public.fact_claims(id) on delete cascade,
  dimension_type text not null check (dimension_type in ('person', 'place', 'activity', 'emotion', 'health', 'topic', 'project', 'item', 'reason', 'time_hint')),
  dimension_value text not null,
  normalized_value text not null,
  confidence double precision not null default 0.8 check (confidence >= 0 and confidence <= 1),
  source text not null default 'llm' check (source in ('llm', 'rule', 'manual')),
  created_at timestamptz not null default now(),
  unique(claim_id, dimension_type, normalized_value, source)
);

create index if not exists idx_fact_claim_dimensions_type_norm
  on public.fact_claim_dimensions(dimension_type, normalized_value, confidence desc);

create index if not exists idx_fact_claim_dimensions_claim
  on public.fact_claim_dimensions(claim_id);

create table if not exists public.fact_rollups (
  id text primary key,
  scope_type text not null check (scope_type in ('all', 'entry_type', 'topic', 'project')),
  scope_key text not null,
  period_type text not null check (period_type in ('daily', 'weekly', 'monthly', 'custom')),
  period_start_utc timestamptz not null,
  period_end_utc timestamptz not null,
  summary_text text not null,
  key_claim_ids jsonb not null default '[]'::jsonb,
  generated_by_model text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(scope_type, scope_key, period_type, period_start_utc, period_end_utc)
);

create index if not exists idx_fact_rollups_scope_period
  on public.fact_rollups(scope_type, period_type, period_start_utc desc);

create table if not exists public.fact_analysis_artifacts (
  id text primary key,
  extraction_id text not null references public.fact_extractions(id) on delete cascade,
  artifact_type text not null check (artifact_type in ('prompt_meta', 'response_meta', 'validation_error')),
  sha256 text not null,
  metadata_json jsonb not null default '{}'::jsonb,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists idx_fact_analysis_artifacts_extraction
  on public.fact_analysis_artifacts(extraction_id, created_at desc);

create table if not exists public.fact_claim_feedback (
  id text primary key,
  claim_id text not null references public.fact_claims(id) on delete cascade,
  action text not null check (action in ('revise', 'supersede', 'retract', 'restore')),
  before_json jsonb not null,
  after_json jsonb not null,
  actor text not null default 'user',
  created_at timestamptz not null default now()
);

create index if not exists idx_fact_claim_feedback_claim
  on public.fact_claim_feedback(claim_id, created_at desc);

update public.app_entries e
set
  analysis_state = case
    when s.status = 'succeeded' then 'succeeded'
    when s.status = 'running' then 'running'
    when s.status = 'queued' then 'queued'
    when s.status = 'blocked' then 'blocked'
    when s.status = 'failed' then 'failed'
    else 'not_requested'
  end,
  latest_analysis_job_id = s.job_id
from (
  select distinct on (entry_id) entry_id, status, job_id, updated_at
  from public.fact_extraction_job_items
  order by entry_id, updated_at desc
) s
where s.entry_id = e.id;

commit;
