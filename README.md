# ActionHost

ActionHost deploys GitHub repositories with GitHub Actions, exposes them via **ngrok**, and keeps deployments fresh automatically when new commits are pushed.

## Architecture (ngrok-only)

- **No FreeDomain integration**
- **No Cloudflare integration**
- Public access is provided only through a reserved ngrok domain.

## Deployment UI fields

The Deploy form includes only:

- GitHub repository URL
- ngrok authtoken
- ngrok domain
- Deploy button

## End-to-end flow

1. User submits repo URL + ngrok authtoken + ngrok domain.
2. Backend detects framework/runtime, branch, build command, start command.
3. Deploy worker clones/builds/starts app.
4. Deploy worker configures ngrok and starts a tunnel using the reserved domain.
5. Health check validates the new deployment.
6. Deployment is marked active in Supabase.
7. Previous active deployment is drained/stopped after successful activation.
8. Scheduled monitor checks for:
   - new commits on tracked repos (auto redeploy)
   - near-expiry active deployments (rotation)

## Automatic redeploy on new commits

`rotation-scheduler.yml` runs the commit monitor logic in `scripts/rotation-worker.mjs`.
For each `auto_deploy_enabled` project, it:

- queries latest commit SHA from GitHub,
- compares against `latest_deployed_commit_sha`,
- queues a new deployment if changed,
- dispatches `deploy-worker.yml` automatically.

## Supabase schema

Migration file:
- `supabase/migrations/20260415_actionhost_schema.sql`

Tables:
- `projects`
- `deployments`
- `workflow_runs`
- `logs`
- `settings`

Deployments include:
- repo URL
- branch
- commit SHA
- detected framework/build/start commands
- workflow run ID/status
- public ngrok URL
- deployment status + health
- created/active timestamps
- error message

## Required GitHub Actions variables

- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_SUPABASE_FUNCTIONS_BASE_URL`
- `ACTIONHOST_REPO_PATH`
- `DEFAULT_TARGET_REPO` (optional)
- `DEFAULT_NGROK_DOMAIN` (optional)
- `DEFAULT_NGROK_AUTHTOKEN` (optional)
- `ACTIONHOST_GITHUB_PAT`
- `ACTIONHOST_SUPABASE_URL`
- `ACTIONHOST_SUPABASE_SERVICE_ROLE_KEY`
- `ACTIONHOST_DEFAULT_TARGET_REPO` (optional default repo URL)
- `ACTIONHOST_DEFAULT_NGROK_DOMAIN` (optional default ngrok domain)
- `ACTIONHOST_DEFAULT_NGROK_AUTHTOKEN` (optional default ngrok token for backend)

## Required Supabase Edge Function env vars

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `GITHUB_PAT`
- `ACTIONHOST_REPO_PATH`
- `DEFAULT_TARGET_REPO` (optional)
- `DEFAULT_NGROK_DOMAIN` (optional)
- `DEFAULT_NGROK_AUTHTOKEN` (optional)


## Preconfigured target values

This setup is configured to support:
- Repository: `https://github.com/Joshbond123/Blog-Automator`
- ngrok domain: `unapprehended-overemotionally-jeni.ngrok-free.dev`

The rotation monitor can bootstrap this project automatically when these Action variables are set:
- `ACTIONHOST_DEFAULT_TARGET_REPO`
- `ACTIONHOST_DEFAULT_NGROK_DOMAIN`
- `ACTIONHOST_DEFAULT_NGROK_AUTHTOKEN`

## Security

- ngrok authtoken is accepted by backend and stored in `settings` (service-role access), not exposed in frontend.
- GitHub PAT and Supabase service key are backend/workflow-only.
- Frontend is static on GitHub Pages.

## Local development

```bash
npm ci
npm run dev
```

Use `.env.example` for local Vite env vars.
