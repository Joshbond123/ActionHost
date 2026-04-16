create extension if not exists "uuid-ossp";

create table if not exists public.projects (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  repo_url text not null,
  domain text not null,
  free_domain_dns_api_key text not null,
  detected_framework text,
  detected_branch text,
  detected_build_command text,
  detected_start_command text,
  deployment_strategy text,
  created_at timestamptz not null default now()
);

create table if not exists public.deployments (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid not null references public.projects(id) on delete cascade,
  repo_url text not null,
  domain text not null,
  tunnel_hostname text,
  public_url text,
  workflow_run_id text,
  workflow_status text,
  status text not null default 'queued',
  health_status text not null default 'pending',
  detected_framework text,
  detected_branch text,
  detected_build_command text,
  detected_start_command text,
  deployment_strategy text,
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

create table if not exists public.domain_mappings (
  id uuid primary key default uuid_generate_v4(),
  domain text not null unique,
  active_deployment_id uuid references public.deployments(id) on delete set null,
  tunnel_hostname text,
  last_dns_update_at timestamptz,
  dns_status text not null default 'pending',
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
alter publication supabase_realtime add table public.domain_mappings;

alter table public.projects enable row level security;
alter table public.deployments enable row level security;
alter table public.logs enable row level security;
alter table public.workflow_runs enable row level security;
alter table public.domain_mappings enable row level security;
alter table public.settings enable row level security;

create policy "public read projects" on public.projects for select using (true);
create policy "public insert projects" on public.projects for insert with check (true);
create policy "public read deployments" on public.deployments for select using (true);
create policy "public insert deployments" on public.deployments for insert with check (true);
create policy "public read logs" on public.logs for select using (true);
create policy "public read domain mappings" on public.domain_mappings for select using (true);
