# ActionHost

ActionHost deploys GitHub repositories as temporary hosted apps using GitHub Actions + Cloudflare Quick Tunnel, then maps a user-provided **FreeDomain** domain to the latest healthy deployment through DNS API updates.

## Product flow

1. User enters:
   - GitHub repository URL
   - FreeDomain domain
   - FreeDomain DNS API key
2. ActionHost auto-detects runtime:
   - framework/runtime
   - branch
   - build command
   - start command
   - deployment strategy
3. Deployment worker:
   - clones repo
   - installs dependencies
   - builds app
   - starts app
   - opens Cloudflare Quick Tunnel
   - extracts tunnel hostname + URL
4. Health checks tunnel URL.
5. Updates FreeDomain DNS record (CNAME) to tunnel hostname.
6. Verifies domain health.
7. Marks deployment active and stops previous active workflow only after successful switch.
8. Rotation scheduler queues a replacement deployment before expiration (~4h).

---

## Architecture

### Frontend (GitHub Pages)
- React + Vite dashboard
- Deployment form fields:
  - GitHub repository URL
  - FreeDomain domain
  - FreeDomain DNS API key
- Shows:
  - detected framework/runtime
  - detected branch
  - detected build/start commands
  - deployment/workflow/domain status
  - active URL
  - history and logs

### Backend
- Supabase Edge Functions:
  - `deploy` (validate input, detect runtime, create project/deployment, dispatch workflow)
  - `save-settings` (optional Cerebras key, backend only)
- GitHub Actions workers:
  - `deploy-worker.yml` runs deployment workflow logic
  - `rotation-scheduler.yml` handles zero-downtime rotation window checks
- Node worker scripts:
  - `scripts/deploy-worker.mjs`
  - `scripts/rotation-worker.mjs`

### DNS integration
- FreeDomain / DNSExit DNS API update via backend-only API key handling.
- Dynamic domain parsing for root + host parts.
- Retries on DNS update and domain verification checks.

---

## Supabase schema

Migration file:
- `supabase/migrations/20260415_actionhost_schema.sql`

Tables:
- `projects`
- `deployments`
- `workflow_runs`
- `domain_mappings`
- `logs`
- `settings`

---

## Required GitHub Actions variables

Set these repository variables:

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_SUPABASE_FUNCTIONS_BASE_URL`
- `ACTIONHOST_REPO_PATH` (example: `owner/repo`)
- `ACTIONHOST_GITHUB_PAT`
- `ACTIONHOST_SUPABASE_URL`
- `ACTIONHOST_SUPABASE_SERVICE_ROLE_KEY`
- `FREEDOMAIN_DNS_API_BASE` (optional override, default in worker script)

---

## Supabase Edge Function env vars

Set these in Supabase Functions environment:

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

Use `.env.example` for local frontend env setup.

---

## Security

- GitHub PAT, FreeDomain DNS API key, Supabase service keys, and optional Cerebras key are backend-only.
- Frontend is static and hosted on GitHub Pages.
- No secret keys are exposed in client code.
