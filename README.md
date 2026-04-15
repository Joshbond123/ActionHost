# ActionHost

ActionHost is a full-stack SaaS platform to deploy GitHub repositories as temporary hosts using GitHub Actions, Supabase, and Cloudflare.

## Core capabilities

- GitHub Pages-hosted frontend dashboard
- Secure backend orchestration through Supabase Edge Functions + GitHub Actions
- Automatic repository analysis (framework/branch/build/start detection)
- Deployment lifecycle states:
  - `queued → starting → warming → ready → active → draining → stopped → failed`
- Zero-downtime rotation every ~4 hours
- Cloudflare DNS switching after health checks
- Deployment and log tracking in Supabase

---

## Architecture

### Frontend (GitHub Pages)
- React + Vite single-page dashboard (`src/App.tsx`)
- Reads projects, deployments, and logs from Supabase
- User inputs are limited to:
  - GitHub repository URL
  - Cloudflare API token
  - Cloudflare Zone ID
  - Custom domain
  - Optional subdomain

### Backend
- Supabase Edge Function `deploy`:
  - Validates input
  - Detects framework/build/start defaults
  - Writes `projects` + `deployments`
  - Dispatches `deploy-worker.yml`
- Supabase Edge Function `save-settings`:
  - Stores optional Cerebras API key
- GitHub workflow `deploy-worker.yml`:
  - Clones target repo
  - Builds and starts app
  - Starts Cloudflare quick tunnel
  - Health checks deployment
  - Updates Cloudflare DNS
  - Updates Supabase statuses/logs
  - Cancels prior active workflow run after cutover
- GitHub workflow `rotation-scheduler.yml`:
  - Runs every 10 min
  - Detects deployments near expiration
  - Queues replacement deployment
  - Dispatches `deploy-worker.yml`

### Database (Supabase)
Tables:
- `projects`
- `deployments`
- `workflow_runs`
- `domain_mappings`
- `logs`
- `settings`

Migration: `supabase/migrations/20260415_actionhost_schema.sql`

---

## Required repository configuration

### GitHub Actions variables
Set in **Repository Settings → Secrets and variables → Actions → Variables**:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_SUPABASE_FUNCTIONS_BASE_URL`
- `ACTIONHOST_REPO_PATH` (`owner/repo`, e.g. `Joshbond123/ActionHost`)

### GitHub Actions secrets
Set in **Repository Settings → Secrets and variables → Actions → Secrets**:

- `GITHUB_PAT`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

### Supabase Edge Function secrets
Set in Supabase project function environment:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GITHUB_PAT`
- `ACTIONHOST_REPO_PATH`

---

## Local development

```bash
npm ci
npm run dev
```

Use `.env.example` for local Vite variables.

---

## Deployment

1. Push to `main`.
2. `Deploy GitHub Pages` workflow publishes frontend.
3. GitHub Pages URL:
   - `https://<your-username>.github.io/ActionHost/`

---

## Security model

- GitHub PAT, Cloudflare token, and Cerebras key are handled in backend workflows/functions.
- PAT is never embedded in frontend.
- Frontend is static and hosted only on GitHub Pages.

