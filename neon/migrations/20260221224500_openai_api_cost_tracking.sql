begin;

create table if not exists public.openai_api_requests (
  id text primary key,
  created_at timestamptz not null default now(),
  request_started_at timestamptz not null default now(),
  request_finished_at timestamptz,

  status text not null default 'ok',
  environment text not null default 'local',
  endpoint text not null,
  model text not null,
  operation text,
  workflow text,
  correlation_id text,
  actor text not null default 'system',

  source_ref_type text not null default 'none',
  source_ref_id text,
  openai_request_id text,

  input_tokens integer not null default 0,
  cached_input_tokens integer not null default 0,
  output_tokens integer not null default 0,
  reasoning_output_tokens integer not null default 0,
  total_tokens integer generated always as (input_tokens + output_tokens) stored,

  input_chars integer,
  output_chars integer,

  input_price_per_1m_usd numeric(12, 6),
  cached_input_price_per_1m_usd numeric(12, 6),
  output_price_per_1m_usd numeric(12, 6),
  request_cost_usd numeric(12, 6) not null default 0,
  cost_source text not null default 'estimated',

  error_type text,
  error_message text,
  metadata_json jsonb not null default '{}'::jsonb,

  constraint openai_api_requests_status_check
    check (status in ('ok', 'error', 'timeout', 'canceled')),
  constraint openai_api_requests_environment_check
    check (environment in ('local', 'staging', 'production')),
  constraint openai_api_requests_source_ref_type_check
    check (source_ref_type in ('none', 'capture', 'note', 'task', 'entry', 'other')),
  constraint openai_api_requests_cost_source_check
    check (cost_source in ('estimated', 'provider_reported', 'manual')),
  constraint openai_api_requests_nonnegative_tokens_check
    check (
      input_tokens >= 0
      and cached_input_tokens >= 0
      and output_tokens >= 0
      and reasoning_output_tokens >= 0
    ),
  constraint openai_api_requests_nonnegative_cost_check
    check (
      request_cost_usd >= 0
      and (input_price_per_1m_usd is null or input_price_per_1m_usd >= 0)
      and (cached_input_price_per_1m_usd is null or cached_input_price_per_1m_usd >= 0)
      and (output_price_per_1m_usd is null or output_price_per_1m_usd >= 0)
    ),
  constraint openai_api_requests_finished_after_start_check
    check (request_finished_at is null or request_finished_at >= request_started_at)
);

create unique index if not exists idx_openai_api_requests_openai_request_id_unique
  on public.openai_api_requests(openai_request_id)
  where openai_request_id is not null;

create index if not exists idx_openai_api_requests_created_at
  on public.openai_api_requests(created_at desc);

create index if not exists idx_openai_api_requests_model_created
  on public.openai_api_requests(model, created_at desc);

create index if not exists idx_openai_api_requests_status_created
  on public.openai_api_requests(status, created_at desc);

create index if not exists idx_openai_api_requests_source_ref
  on public.openai_api_requests(source_ref_type, source_ref_id, created_at desc);

create index if not exists idx_openai_api_requests_correlation
  on public.openai_api_requests(correlation_id, created_at desc);

create or replace view public.v_openai_api_request_costs as
select
  id,
  created_at,
  request_started_at,
  request_finished_at,
  status,
  environment,
  endpoint,
  model,
  operation,
  workflow,
  correlation_id,
  actor,
  source_ref_type,
  source_ref_id,
  openai_request_id,
  input_tokens,
  cached_input_tokens,
  output_tokens,
  reasoning_output_tokens,
  total_tokens,
  input_chars,
  output_chars,
  input_price_per_1m_usd,
  cached_input_price_per_1m_usd,
  output_price_per_1m_usd,
  request_cost_usd,
  cost_source,
  error_type,
  error_message,
  metadata_json
from public.openai_api_requests
order by created_at desc;

create or replace view public.v_openai_api_cost_daily as
select
  date_trunc('day', created_at)::date as day_utc,
  count(*) as request_count,
  count(*) filter (where status = 'ok') as ok_count,
  count(*) filter (where status <> 'ok') as error_count,
  sum(input_tokens) as input_tokens,
  sum(cached_input_tokens) as cached_input_tokens,
  sum(output_tokens) as output_tokens,
  sum(total_tokens) as total_tokens,
  sum(request_cost_usd)::numeric(14, 6) as total_cost_usd
from public.openai_api_requests
group by 1
order by 1 desc;

commit;
