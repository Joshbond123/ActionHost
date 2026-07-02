import { Octokit } from 'octokit';
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const deploymentId = process.env.DEPLOYMENT_ID;
const projectId = process.env.PROJECT_ID;
const workflowRunId = process.env.GITHUB_RUN_ID;

if (!deploymentId || !projectId) {
  console.error('DEPLOYMENT_ID and PROJECT_ID env vars are required.');
  process.exit(1);
}

if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required.');
  process.exit(1);
}

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const log = async (message, level = 'info') => {
  console.log(`[${level.toUpperCase()}] ${message}`);
  try {
    await supabase.from('logs').insert({ deployment_id: deploymentId, message, level });
  } catch (err) {
    console.error('Failed to write log to Supabase:', err.message);
  }
};

const updateDeployment = async (payload) => {
  const { error } = await supabase.from('deployments').update(payload).eq('id', deploymentId);
  if (error) console.error('Failed to update deployment:', error.message);
};

const verifyUrlHealthy = async (url, maxAttempts = 8, delayMs = 5000) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 12000);
      const response = await fetch(url, { redirect: 'follow', signal: controller.signal });
      clearTimeout(timeout);
      if (response.ok || response.status < 500) return true;
    } catch {
      // retry
    }
    if (attempt < maxAttempts) await wait(delayMs);
  }
  return false;
};

// ─── Main worker logic ────────────────────────────────────────────────────────

const { data: project, error: projectError } = await supabase.from('projects').select('*').eq('id', projectId).single();
if (projectError) {
  console.error('Failed to load project:', projectError.message);
  process.exit(1);
}

const { data: deployment, error: deploymentLoadError } = await supabase.from('deployments').select('expires_at').eq('id', deploymentId).single();
if (deploymentLoadError) {
  console.error('Failed to load deployment:', deploymentLoadError.message);
  process.exit(1);
}

if (!project.ngrok_authtoken) {
  await updateDeployment({ status: 'failed', error_message: 'ngrok authtoken is not configured for this project.' });
  await log('Project has no ngrok_authtoken configured. Edit the project and add it.', 'error');
  process.exit(1);
}
if (!project.domain) {
  await updateDeployment({ status: 'failed', error_message: 'ngrok domain is not configured for this project.' });
  await log('Project has no ngrok domain configured.', 'error');
  process.exit(1);
}

await updateDeployment({ status: 'starting', workflow_status: 'in_progress', workflow_run_id: workflowRunId || null });
await log(`Starting deployment for ${project.repo_url}`);

// ─── Stop any prior live deployments BEFORE starting our tunnel ──────────────
// The ngrok reserved domain only allows one active endpoint at a time
// (ERR_NGROK_334). If a previous deploy is still running, we must cancel its
// GitHub Actions run so its ngrok process dies and releases the endpoint —
// otherwise our new tunnel will fail to come online.
try {
  const { data: liveDeployments } = await supabase
    .from('deployments')
    .select('id, workflow_run_id, status')
    .eq('project_id', projectId)
    .in('status', ['active', 'ready', 'warming', 'starting'])
    .neq('id', deploymentId);

  if (liveDeployments && liveDeployments.length > 0) {
    await log(`Found ${liveDeployments.length} prior live deployment(s) — stopping them to free the ngrok domain...`);
    let cancelledAny = false;

    for (const old of liveDeployments) {
      await supabase.from('deployments').update({ status: 'draining', workflow_status: 'draining' }).eq('id', old.id);

      if (old.workflow_run_id && process.env.GITHUB_PAT && process.env.ACTIONHOST_REPO_PATH) {
        const octokit = new Octokit({ auth: process.env.GITHUB_PAT });
        const [owner, repo] = process.env.ACTIONHOST_REPO_PATH.split('/');

        // Check the run's current state first so we don't try to cancel
        // something that already finished (which returns 409).
        let runStatus = null;
        try {
          const { data: runInfo } = await octokit.rest.actions.getWorkflowRun({
            owner, repo, run_id: Number(old.workflow_run_id),
          });
          runStatus = runInfo.status; // queued | in_progress | completed | waiting
        } catch (err) {
          await log(`Prior workflow run ${old.workflow_run_id} state unknown (${err.message}); assuming finished.`);
        }

        if (runStatus === 'queued' || runStatus === 'in_progress' || runStatus === 'waiting') {
          try {
            await octokit.rest.actions.cancelWorkflowRun({
              owner, repo, run_id: Number(old.workflow_run_id),
            });
            await log(`Cancelled previous workflow run ${old.workflow_run_id} (deployment ${old.id.slice(0, 8)}).`);
            cancelledAny = true;
          } catch (err) {
            // 409 race: it finished between GET and CANCEL — treat as already-stopped.
            if (String(err.message).includes('Cannot cancel a workflow run that is completed')) {
              await log(`Prior workflow run ${old.workflow_run_id} finished on its own; domain is free.`);
            } else {
              await log(`Could not cancel prior workflow run ${old.workflow_run_id}: ${err.message}`, 'warn');
            }
          }
        } else {
          await log(`Prior workflow run ${old.workflow_run_id} already finished; ngrok endpoint should be free.`);
        }
      }

      await supabase.from('deployments').update({ status: 'stopped', workflow_status: 'stopped' }).eq('id', old.id);
    }

    if (cancelledAny) {
      // Give ngrok edge time to recognize the previous tunnel is gone
      // before we try to claim the same reserved domain.
      await log('Waiting 20s for ngrok to release the reserved domain...');
      await wait(20000);
    }
  }
} catch (err) {
  await log(`Pre-deploy cleanup of prior deployments failed: ${err.message}`, 'warn');
}

await log(`Framework: ${project.detected_framework ?? 'unknown'} | Branch: ${project.detected_branch ?? 'main'}`);
await log(`ngrok domain: ${project.domain}`);

// Clone repository (track latest SHA for auto-deploy)
await log('Cloning repository...');
let latestSha = '';
try {
  execSync(`git clone --depth 1 ${project.repo_url} target-app`, { stdio: 'inherit' });
  try { latestSha = execSync('git rev-parse HEAD', { cwd: 'target-app' }).toString().trim(); } catch { /* non-fatal */ }
} catch (err) {
  await updateDeployment({ status: 'failed', error_message: `git clone failed: ${err.message}` });
  await log(`git clone failed: ${err.message}`, 'error');
  process.exit(1);
}

const hasPackageJson = fs.existsSync('target-app/package.json');

// Install dependencies
if (hasPackageJson) {
  await log('Installing dependencies...');
  try {
    const lockExists = fs.existsSync('target-app/package-lock.json');
    const installCmd = lockExists ? 'npm ci' : 'npm install';
    execSync(installCmd, { cwd: 'target-app', stdio: 'inherit' });
  } catch (err) {
    await updateDeployment({ status: 'failed', error_message: `npm install failed: ${err.message}` });
    await log(`npm install failed: ${err.message}`, 'error');
    process.exit(1);
  }
}

// Build
const buildCmd = project.detected_build_command || 'npm run build';
await log(`Running build: ${buildCmd}`);
try {
  execSync(buildCmd, { cwd: 'target-app', stdio: 'inherit', shell: '/bin/bash' });
} catch (err) {
  if (buildCmd.startsWith('echo')) {
    await log('Build step skipped (no build required).');
  } else {
    await updateDeployment({ status: 'failed', error_message: `Build failed: ${err.message}` });
    await log(`Build failed: ${err.message}`, 'error');
    process.exit(1);
  }
}

// All ActionHost-detected apps run on port 4173 (PORT=4173 is embedded in start commands)
const APP_PORT = 4173;

// Load env vars stored for this project (set via ActionHost UI)
let projectEnvVars = {};
try {
  const { data: envSetting } = await supabase.from('settings').select('value').eq('key', `env_${projectId}`).single();
  if (envSetting?.value) {
    projectEnvVars = JSON.parse(envSetting.value);
    const envCount = Object.keys(projectEnvVars).length;
    if (envCount > 0) await log(`Injecting ${envCount} environment variable(s) from project settings.`);
  }
} catch {
  // no env vars saved — that's fine
}

// Build the env export lines for the shell script
const envExports = Object.entries(projectEnvVars)
  .map(([k, v]) => `export ${k}=${JSON.stringify(String(v))}`)
  .join('\n');

// Start app in background using a shell wrapper script for reliable detachment
const startCmd = project.detected_start_command || `npm run preview -- --host 0.0.0.0 --port ${APP_PORT}`;
await log(`Starting app: ${startCmd}`);

// Write a startup script that handles the background process reliably
fs.writeFileSync('start-app.sh', `#!/bin/bash
${envExports}
cd target-app
${startCmd} >> ../app.log 2>&1 &
echo $! > ../app.pid
echo "App started with PID $!"
`);
execSync('chmod +x start-app.sh && bash start-app.sh', { stdio: 'inherit' });
await wait(5000); // Give the app 5 seconds to start

// Read app log to check for startup errors
const appLogContent = fs.existsSync('app.log') ? fs.readFileSync('app.log', 'utf8') : '';
if (appLogContent) {
  await log(`App startup output: ${appLogContent.slice(0, 300)}`);
}

// Quick check if app is responding
const appStarted = await verifyUrlHealthy(`http://localhost:${APP_PORT}`, 3, 3000);
if (!appStarted) {
  const appLog = fs.existsSync('app.log') ? fs.readFileSync('app.log', 'utf8') : '(no output)';
  await log(`App startup log: ${appLog.slice(0, 500)}`, 'warn');
  await log(`App not responding on port ${APP_PORT} after 9s, proceeding with tunnel anyway...`, 'warn');
}

// Download and start ngrok
await log('Downloading ngrok...');
try {
  execSync(
    'curl -fsSL -o ngrok.tgz https://bin.equinox.io/c/bNyj1mQVY4c/ngrok-v3-stable-linux-amd64.tgz && tar -xzf ngrok.tgz && chmod +x ngrok',
    { stdio: 'inherit' }
  );
} catch (err) {
  await updateDeployment({ status: 'failed', error_message: `ngrok download failed: ${err.message}` });
  await log(`ngrok download failed: ${err.message}`, 'error');
  process.exit(1);
}

// Configure ngrok authtoken
await log('Configuring ngrok authtoken...');
try {
  execSync(`./ngrok config add-authtoken ${project.ngrok_authtoken}`, { stdio: 'inherit' });
} catch (err) {
  await updateDeployment({ status: 'failed', error_message: `ngrok authtoken config failed: ${err.message}` });
  await log(`ngrok authtoken config failed: ${err.message}`, 'error');
  process.exit(1);
}

// Start ngrok bound to the reserved domain
await log(`Starting ngrok tunnel bound to ${project.domain}...`);
fs.writeFileSync('start-tunnel.sh', `#!/bin/bash
./ngrok http --url=https://${project.domain} ${APP_PORT} --log=stdout >> tunnel.log 2>&1 &
echo $! > tunnel.pid
`);
execSync('chmod +x start-tunnel.sh && bash start-tunnel.sh', { stdio: 'inherit' });

// Wait for ngrok to confirm tunnel is online (poll its local API at :4040)
let publicUrl = `https://${project.domain}`;
let tunnelOnline = false;
for (let i = 0; i < 30; i++) {
  await wait(2000);
  try {
    const res = await fetch('http://127.0.0.1:4040/api/tunnels');
    if (res.ok) {
      const payload = await res.json();
      const tunnels = payload.tunnels || [];
      const match = tunnels.find((t) => (t.public_url || '').includes(project.domain));
      if (match) { publicUrl = match.public_url; tunnelOnline = true; break; }
      if (tunnels.length > 0) { publicUrl = tunnels[0].public_url; tunnelOnline = true; break; }
    }
  } catch {
    // ngrok api not up yet
  }
}

if (!tunnelOnline) {
  const tunnelLog = fs.existsSync('tunnel.log') ? fs.readFileSync('tunnel.log', 'utf8') : '(no log)';
  const appLog = fs.existsSync('app.log') ? fs.readFileSync('app.log', 'utf8').slice(-500) : '(no log)';
  await updateDeployment({ status: 'failed', workflow_status: 'failed', error_message: 'ngrok tunnel did not come online.' });
  await log(`App log: ${appLog}`, 'error');
  await log(`Tunnel log: ${tunnelLog}`, 'error');
  process.exit(1);
}

const tunnelHostname = new URL(publicUrl).hostname;
await updateDeployment({ status: 'warming', public_url: publicUrl, tunnel_hostname: tunnelHostname, workflow_status: 'running' });
await log(`Tunnel ready: ${publicUrl}`);

// Health check on localhost (the tunnel forwards to it)
await log(`Verifying app is responding on localhost:${APP_PORT}...`);
const localHealthy = await verifyUrlHealthy(`http://localhost:${APP_PORT}`, 12, 5000);
if (!localHealthy) {
  const appLog = fs.existsSync('app.log') ? fs.readFileSync('app.log', 'utf8').slice(-2000) : '(no log)';
  await updateDeployment({ status: 'failed', health_status: 'unhealthy', workflow_status: 'failed', error_message: 'App health check failed - app did not start or crashed on port ' + APP_PORT });
  await log(`App log: ${appLog}`, 'error');
  await log(`App health check failed: no response on localhost:${APP_PORT} after 12 attempts.`, 'error');
  process.exit(1);
}

await updateDeployment({ status: 'ready', health_status: 'healthy' });
await log(`App health check passed — responding on localhost:${APP_PORT}.`);

// Record domain mapping (ngrok handles DNS automatically — no manual update needed)
await supabase.from('domain_mappings').upsert(
  {
    domain: project.domain,
    active_deployment_id: deploymentId,
    tunnel_hostname: tunnelHostname,
    last_dns_update_at: new Date().toISOString(),
    dns_status: 'active',
  },
  { onConflict: 'domain' },
);

await updateDeployment({
  status: 'active',
  workflow_status: 'active',
  became_active_at: new Date().toISOString(),
});

// Persist last deployed commit SHA for auto-deploy comparison
if (latestSha) {
  try {
    await supabase.from('projects').update({ last_deployed_sha: latestSha }).eq('id', projectId);
    await log(`Recorded deployed commit: ${latestSha.slice(0, 8)}`);
  } catch { /* non-fatal */ }
}

await log(`Deployment active. App is live at: ${publicUrl}`);

// Mark old deployments as stopped
const { data: oldDeployments } = await supabase
  .from('deployments')
  .select('id, workflow_run_id')
  .eq('project_id', projectId)
  .eq('status', 'active')
  .neq('id', deploymentId);

for (const old of oldDeployments ?? []) {
  await supabase.from('deployments').update({ status: 'draining', workflow_status: 'draining' }).eq('id', old.id);

  if (old.workflow_run_id && process.env.GITHUB_PAT && process.env.ACTIONHOST_REPO_PATH) {
    try {
      const octokit = new Octokit({ auth: process.env.GITHUB_PAT });
      const [owner, repo] = process.env.ACTIONHOST_REPO_PATH.split('/');
      await octokit.rest.actions.cancelWorkflowRun({ owner, repo, run_id: Number(old.workflow_run_id) });
    } catch (err) {
      console.error(`Failed to cancel old workflow run ${old.workflow_run_id}:`, err.message);
    }
  }

  await supabase.from('deployments').update({ status: 'stopped', workflow_status: 'stopped' }).eq('id', old.id);
  await log(`Stopped previous deployment: ${old.id}`);
}

try {
  await supabase.from('workflow_runs').insert({
    deployment_id: deploymentId,
    github_run_id: workflowRunId || 'unknown',
    status: 'completed',
  });
} catch {
  // table may not exist — non-fatal
}

await log('Deployment worker finished. App is live!');
await log(`Public URL: ${publicUrl}`);

// Keep runner alive to maintain the tunnel and app.
// This loop is also a self-healing safety net: it verifies the ACTUAL public
// ngrok URL (not just localhost, which stays "healthy" even if the tunnel itself
// drops), and it self-triggers the next rotation before this run's expires_at,
// so the site keeps rotating even if the external cron-based Rotation Scheduler
// workflow gets disabled by GitHub for inactivity.
const expiresAtMs = deployment.expires_at ? new Date(deployment.expires_at).getTime() : null;
const ROTATE_BEFORE_MS = 20 * 60 * 1000; // trigger replacement 20 min before expiry
let rotationTriggered = false;
let consecutivePublicFailures = 0;

const triggerSelfRotation = async () => {
  if (rotationTriggered) return;
  rotationTriggered = true;
  await log('Self-healing: proactively triggering replacement deployment before this run expires.');
  try {
    const { data: queued, error: queuedError } = await supabase.from('deployments').insert({
      project_id: project.id,
      repo_url: project.repo_url,
      domain: project.domain,
      status: 'queued',
      workflow_status: 'queued',
      health_status: 'pending',
      detected_framework: project.detected_framework,
      detected_branch: project.detected_branch,
      detected_build_command: project.detected_build_command,
      detected_start_command: project.detected_start_command,
      deployment_strategy: project.deployment_strategy,
      expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    }).select().single();
    if (queuedError) throw queuedError;

    const dispatchRes = await fetch(
      `https://api.github.com/repos/${process.env.ACTIONHOST_REPO_PATH}/actions/workflows/deploy-worker.yml/dispatches`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.GITHUB_PAT}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'main', inputs: { project_id: project.id, deployment_id: queued.id } }),
      },
    );
    if (!dispatchRes.ok) throw new Error(`dispatch failed: ${dispatchRes.status} ${await dispatchRes.text()}`);
    await log(`Self-healing: replacement deployment ${queued.id} queued and dispatched.`);
  } catch (err) {
    rotationTriggered = false; // allow retry on next tick
    await log(`Self-healing rotation attempt failed, will retry: ${err.message}`, 'warn');
  }
};

await log('Keeping runner alive to maintain tunnel and app server...');
while (true) {
  try {
    await wait(60000);

    const localHealthyNow = await verifyUrlHealthy(`http://localhost:${APP_PORT}`, 2, 3000);
    const publicHealthyNow = await verifyUrlHealthy(publicUrl, 2, 5000);

    if (!localHealthyNow || !publicHealthyNow) {
      consecutivePublicFailures++;
      await log(`Health check failed (local=${localHealthyNow}, public=${publicHealthyNow}), attempt ${consecutivePublicFailures}`, 'warn');
      await updateDeployment({ health_status: 'unhealthy' });
      // If the public tunnel has been unreachable for a while, stop claiming we're active
      // and proactively trigger a replacement instead of waiting for expiry.
      if (consecutivePublicFailures >= 3) {
        await updateDeployment({ status: 'expired', workflow_status: 'expired', error_message: 'Public URL stopped responding (tunnel likely dropped).' });
        await triggerSelfRotation();
      }
    } else {
      consecutivePublicFailures = 0;
      await updateDeployment({ health_status: 'healthy' });
    }

    if (expiresAtMs && Date.now() >= expiresAtMs - ROTATE_BEFORE_MS) {
      await triggerSelfRotation();
    }
  } catch (err) {
    console.error('[keep-alive] Caught error (non-fatal, continuing):', err?.message);
  }
}
