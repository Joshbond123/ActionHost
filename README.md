# ActionHost

ActionHost is a deployment control dashboard that stores deployment state in Supabase and is hosted on **GitHub Pages**.

## Production architecture

- **Frontend hosting**: GitHub Pages (`deploy-pages.yml`).
- **State + realtime**: Supabase tables (`projects`, `deployments`, `logs`, `cerebras_keys`).
- **Secure automation**: GitHub PAT and Supabase service-role keys are kept only in GitHub Actions repository secrets.
- **Deployment worker**: `deploy-template.yml` can be triggered to process queued deployments.

## Required GitHub repository secrets

Add these secrets in **Settings → Secrets and variables → Actions**:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_SUPABASE_FUNCTIONS_BASE_URL` (optional; used for `analyze-repo` and `queue-deployment` edge functions)
- `SUPABASE_URL` (for deployment worker)
- `SUPABASE_SERVICE_ROLE_KEY` (for deployment worker)
- `GITHUB_PAT` (used by workflows only)

> Never put `GITHUB_PAT` in frontend code or client-exposed environment variables.

## Supabase schema

```sql
create extension if not exists "uuid-ossp";

create table if not exists projects (
  id uuid primary key default uuid_generate_v4(),
  name text not null,
  repo_url text not null,
  domain text not null,
  subdomain text,
  cloudflare_zone_id text,
  framework text,
  build_command text,
  start_command text,
  created_at timestamptz default now()
);

create table if not exists deployments (
  id uuid primary key default uuid_generate_v4(),
  project_id uuid references projects(id) on delete cascade,
  status text not null default 'queued',
  workflow_run_id text,
  public_url text,
  created_at timestamptz default now(),
  expires_at timestamptz
);

create table if not exists logs (
  id uuid primary key default uuid_generate_v4(),
  deployment_id uuid references deployments(id) on delete cascade,
  message text not null,
  level text default 'info',
  created_at timestamptz default now()
);

create table if not exists cerebras_keys (
  id uuid primary key default uuid_generate_v4(),
  key text not null unique,
  usage_count integer default 0,
  created_at timestamptz default now()
);

alter publication supabase_realtime add table projects;
alter publication supabase_realtime add table deployments;
alter publication supabase_realtime add table logs;
```

## Local development

1. Copy `.env.example` to `.env`.
2. Set:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
   - optional `VITE_SUPABASE_FUNCTIONS_BASE_URL`
3. Run:

```bash
npm ci
npm run dev
```

## Deploy to GitHub Pages

- Push to `main`.
- Workflow `Deploy GitHub Pages` runs automatically.
- Site is published at: `https://<github-username>.github.io/ActionHost/`.
