begin;

create table if not exists public.app_entries (
  id text primary key,
  declared_type text not null check (declared_type in ('journal', 'todo', 'learning', 'thought', 'meeting', 'wishlist')),
  title text,
  body text,
  tags jsonb not null default '[]'::jsonb,
  occurred_at_utc timestamptz not null,
  sensitivity text not null default 'internal' check (sensitivity in ('public', 'internal', 'sensitive')),
  payload jsonb not null default '{}'::jsonb,
  sync_status text not null default 'pending' check (sync_status in ('pending', 'syncing', 'synced', 'failed')),
  remote_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.app_sync_queue (
  id text primary key,
  entry_id text not null references public.app_entries(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'syncing', 'synced', 'failed')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_app_sync_queue_entry_pending
  on public.app_sync_queue(entry_id)
  where status = 'pending';

create table if not exists public.app_history (
  id text primary key,
  entry_id text not null references public.app_entries(id) on delete cascade,
  source text not null check (source in ('local', 'remote')),
  before_json jsonb not null,
  after_json jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_app_entries_occurred on public.app_entries(occurred_at_utc desc);
create index if not exists idx_app_entries_type on public.app_entries(declared_type, occurred_at_utc desc);
create index if not exists idx_app_entries_sync on public.app_entries(sync_status, updated_at desc);
create index if not exists idx_app_history_entry on public.app_history(entry_id, created_at desc);
create index if not exists idx_app_sync_queue_status on public.app_sync_queue(status, created_at desc);

commit;
