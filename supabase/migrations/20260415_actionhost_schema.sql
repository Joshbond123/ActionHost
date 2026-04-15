create extension if not exists "uuid-ossp";

create table if not exists public.projects (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  repo_url text not null,
  domain text not null,
  subdomain text,
  cloudflare_zone_id text not null,
  cloudflare_api_token text not null,
  framework text,
  branch text,
  build_command text,
  start_command text,
  created_at timestamptz not null default now()
);

create table if not exists public.deployments (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid not null references public.projects(id) on delete cascade,
  status text not null default 'queued',
  workflow_run_id text,
  public_url text,
  healthcheck_url text,
  created_at timestamptz not null default now(),
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
  project_id uuid not null references public.projects(id) on delete cascade,
  deployment_id uuid not null references public.deployments(id) on delete cascade,
  fqdn text not null,
  target_hostname text not null,
  status text not null default 'pending',
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
alter table public.domain_mappings enable row level security;
alter table public.settings enable row level security;

create policy if not exists "public read projects" on public.projects for select using (true);
create policy if not exists "public insert projects" on public.projects for insert with check (true);
create policy if not exists "public read deployments" on public.deployments for select using (true);
create policy if not exists "public insert deployments" on public.deployments for insert with check (true);
create policy if not exists "public read logs" on public.logs for select using (true);
