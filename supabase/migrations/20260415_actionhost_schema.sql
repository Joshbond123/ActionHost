create extension if not exists "uuid-ossp";

create table if not exists public.projects (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  repo_url text not null unique,
  ngrok_domain text not null,
  auto_deploy_enabled boolean not null default true,
  detected_framework text,
  detected_branch text,
  detected_build_command text,
  detected_start_command text,
  deployment_strategy text,
  latest_seen_commit_sha text,
  latest_deployed_commit_sha text,
  created_at timestamptz not null default now()
);

create table if not exists public.deployments (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid not null references public.projects(id) on delete cascade,
  repo_url text not null,
  branch text,
  commit_sha text,
  detected_framework text,
  detected_build_command text,
  detected_start_command text,
  workflow_run_id text,
  workflow_status text,
  public_url text,
  ngrok_domain text,
  status text not null default 'queued',
  health_status text not null default 'pending',
  error_message text,
  created_at timestamptz not null default now(),
  became_active_at timestamptz,
  expires_at timestamptz
);

create table if not exists public.workflow_runs (
  id uuid primary key default uuid_generate_v4(),
  deployment_id uuid not null references public.deployments(id) on delete cascade,
  github_run_id text not null,
  status text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.logs (
  id uuid primary key default uuid_generate_v4(),
  deployment_id uuid not null references public.deployments(id) on delete cascade,
  level text not null default 'info',
  message text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.settings (
  id uuid primary key default uuid_generate_v4(),
  key text not null unique,
  value text not null,
  updated_at timestamptz not null default now()
);

alter publication supabase_realtime add table public.projects;
alter publication supabase_realtime add table public.deployments;
alter publication supabase_realtime add table public.logs;

alter table public.projects enable row level security;
alter table public.deployments enable row level security;
alter table public.logs enable row level security;
alter table public.workflow_runs enable row level security;
alter table public.settings enable row level security;

create policy "public read projects" on public.projects for select using (true);
create policy "public insert projects" on public.projects for insert with check (true);
create policy "public update projects" on public.projects for update using (true) with check (true);
create policy "public read deployments" on public.deployments for select using (true);
create policy "public insert deployments" on public.deployments for insert with check (true);
create policy "public update deployments" on public.deployments for update using (true) with check (true);
create policy "public read logs" on public.logs for select using (true);
create policy "public insert logs" on public.logs for insert with check (true);
