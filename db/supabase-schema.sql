create table if not exists workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'PipeChat Workspace',
  created_at timestamptz not null default now()
);

create table if not exists profiles (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id) on delete cascade,
  email text not null unique,
  full_name text,
  created_at timestamptz not null default now()
);

create table if not exists crm_deals (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  account text not null,
  owner text,
  stage text not null default 'Discovery',
  value numeric not null default 0,
  close_date text,
  next_step text,
  follow_up text,
  activity text,
  health text,
  notes text,
  history jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists crm_deals_workspace_idx on crm_deals(workspace_id);
create index if not exists crm_deals_follow_up_idx on crm_deals(workspace_id, follow_up);
create index if not exists crm_deals_stage_idx on crm_deals(workspace_id, stage);

create table if not exists chat_usage (
  workspace_id uuid primary key references workspaces(id) on delete cascade,
  used integer not null default 0,
  free_limit integer not null default 1000,
  updated_at timestamptz not null default now()
);

create table if not exists chat_messages (
  id bigint generated always as identity primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  role text not null check (role in ('user', 'assistant')),
  content text not null,
  created_at timestamptz not null default now()
);

create index if not exists chat_messages_workspace_idx on chat_messages(workspace_id, created_at desc);
