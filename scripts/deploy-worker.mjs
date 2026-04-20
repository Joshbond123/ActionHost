import { Octokit } from 'octokit';
import { createClient } from '@supabase/supabase-js';
import { execSync, spawnSync } from 'node:child_process';
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

const parseDomain = (domain) => {
  const parts = domain.split('.');
  if (parts.length < 2) throw new Error(`Invalid domain: ${domain}`);
  return {
    root: parts.slice(-2).join('.'),
    host: parts.length > 2 ? parts.slice(0, -2).join('.') : '@',
  };
};

const updateFreeDomainDns = async ({ domain, apiKey, targetHostname }) => {
  if (!apiKey || apiKey === 'test' || apiKey.length < 5) {
    return { ok: false, body: 'FreeDomain DNS API key not configured or invalid.' };
  }
  const { root, host } = parseDomain(domain);
  const apiBase = process.env.FREEDOMAIN_DNS_API_BASE || 'https://update.dnsexit.com/RemoteUpdate.sv';

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const url = `${apiBase}?apikey=${encodeURIComponent(apiKey)}&domain=${encodeURIComponent(root)}&host=${encodeURIComponent(host)}&recordtype=CNAME&target=${encodeURIComponent(targetHostname)}`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15000);
      const response = await fetch(url, { method: 'GET', signal: controller.signal });
      clearTimeout(timeout);
      const body = await response.text();
      console.log(`DNS update attempt ${attempt}: status=${response.status} body=${body}`);

      // DNSExit returns "0=Success" on success
      if (response.ok && body.startsWith('0=')) {
        return { ok: true, body };
      }
      // Some providers return "good" or "nochg" on success
      if (response.ok && /^(ok|success|good|nochg)/i.test(body.trim())) {
        return { ok: true, body };
      }
      // If server error (5xx), retry
      if (response.status >= 500) {
        await log(`DNS API returned ${response.status}, retrying (attempt ${attempt}/3)...`, 'warn');
      } else {
        await log(`DNS API response (attempt ${attempt}): ${body}`, 'warn');
      }
    } catch (err) {
      console.error(`DNS update attempt ${attempt} failed:`, err.message);
      await log(`DNS update attempt ${attempt} error: ${err.message}`, 'warn');
    }

    if (attempt < 3) await wait(5000 * attempt);
  }

  return { ok: false, body: 'DNS update failed after 3 retries.' };
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

await updateDeployment({ status: 'starting', workflow_status: 'in_progress', workflow_run_id: workflowRunId || null });
await log(`Starting deployment for ${project.repo_url}`);
await log(`Framework: ${project.detected_framework ?? 'unknown'} | Branch: ${project.detected_branch ?? 'main'}`);

// Clone repository
await log('Cloning repository...');
try {
  execSync(`git clone --depth 1 ${project.repo_url} target-app`, { stdio: 'inherit' });
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

// Start app in background using a shell wrapper script for reliable detachment
const startCmd = project.detected_start_command || `npm run preview -- --host 0.0.0.0 --port ${APP_PORT}`;
await log(`Starting app: ${startCmd}`);

// Write a startup script that handles the background process reliably
fs.writeFileSync('start-app.sh', `#!/bin/bash
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

// Download and start Cloudflare Quick Tunnel
await log('Starting Cloudflare Quick Tunnel...');
try {
  execSync(
    'curl -fsSL -o cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x cloudflared',
    { stdio: 'inherit' }
  );
} catch (err) {
  try {
    await log('Primary cloudflared download failed, trying wget...', 'warn');
    execSync(
      'wget -q -O cloudflared https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 && chmod +x cloudflared',
      { stdio: 'inherit' }
    );
  } catch (err2) {
    await updateDeployment({ status: 'failed', error_message: `cloudflared download failed: ${err2.message}` });
    await log(`cloudflared download failed: ${err2.message}`, 'error');
    process.exit(1);
  }
}

// Start tunnel in background
fs.writeFileSync('start-tunnel.sh', `#!/bin/bash
./cloudflared tunnel --url http://localhost:${APP_PORT} --no-autoupdate >> tunnel.log 2>&1 &
echo $! > tunnel.pid
`);
execSync('chmod +x start-tunnel.sh && bash start-tunnel.sh', { stdio: 'inherit' });

// Wait for tunnel URL to appear in log (up to 60s)
let publicUrl = null;
for (let i = 0; i < 30; i++) {
  await wait(2000);
  if (fs.existsSync('tunnel.log')) {
    const tunnelLog = fs.readFileSync('tunnel.log', 'utf8');
    const urlMatch = tunnelLog.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
    if (urlMatch) {
      publicUrl = urlMatch[0];
      break;
    }
  }
}

if (!publicUrl) {
  const tunnelLog = fs.existsSync('tunnel.log') ? fs.readFileSync('tunnel.log', 'utf8') : '(no log)';
  const appLog = fs.existsSync('app.log') ? fs.readFileSync('app.log', 'utf8').slice(-500) : '(no log)';
  await updateDeployment({ status: 'failed', workflow_status: 'failed', error_message: 'Unable to parse tunnel URL from cloudflared output.' });
  await log(`App log: ${appLog}`, 'error');
  await log(`Tunnel log: ${tunnelLog}`, 'error');
  await log('Unable to parse tunnel URL.', 'error');
  process.exit(1);
}

const tunnelHostname = new URL(publicUrl).hostname;
await updateDeployment({ status: 'warming', public_url: publicUrl, tunnel_hostname: tunnelHostname, workflow_status: 'running' });
await log(`Tunnel ready: ${publicUrl}`);

// Health check tunnel
const tunnelHealthy = await verifyUrlHealthy(publicUrl, 10, 5000);
if (!tunnelHealthy) {
  const appLog = fs.existsSync('app.log') ? fs.readFileSync('app.log', 'utf8').slice(-1000) : '(no log)';
  await updateDeployment({ status: 'failed', health_status: 'unhealthy', workflow_status: 'failed', error_message: 'Tunnel health check failed - app may have crashed on startup.' });
  await log(`App log: ${appLog}`, 'error');
  await log('Tunnel health check failed after 10 attempts.', 'error');
  process.exit(1);
}

await updateDeployment({ status: 'ready', health_status: 'healthy' });
await log('Tunnel health check passed.');

// Update FreeDomain DNS — non-fatal (tunnel is still live even if DNS fails)
let dnsSuccess = false;
if (project.domain && project.domain !== 'test.example.com' && project.free_domain_dns_api_key) {
  await log(`Updating FreeDomain DNS for domain: ${project.domain}`);
  const dnsResult = await updateFreeDomainDns({
    domain: project.domain,
    apiKey: project.free_domain_dns_api_key,
    targetHostname: tunnelHostname,
  });

  if (!dnsResult.ok) {
    await log(`DNS update failed: ${dnsResult.body}. Tunnel is still live at: ${publicUrl}`, 'warn');
    await supabase.from('domain_mappings').upsert(
      { domain: project.domain, dns_status: 'failed', tunnel_hostname: tunnelHostname },
      { onConflict: 'domain' },
    );
  } else {
    dnsSuccess = true;
    await log(`DNS update accepted: ${dnsResult.body}`);

    const domainHealthy = await verifyUrlHealthy(`https://${project.domain}`, 12, 10000);
    if (!domainHealthy) {
      await log('Domain health check failed. DNS may still be propagating.', 'warn');
    }

    await supabase.from('domain_mappings').upsert(
      {
        domain: project.domain,
        active_deployment_id: deploymentId,
        tunnel_hostname: tunnelHostname,
        last_dns_update_at: new Date().toISOString(),
        dns_status: domainHealthy ? 'active' : 'pending',
      },
      { onConflict: 'domain' },
    );
  }
}

await updateDeployment({
  status: 'active',
  workflow_status: 'active',
  became_active_at: new Date().toISOString(),
});

await log(dnsSuccess
  ? 'Deployment active. Domain is live.'
  : `Deployment active. App is live at tunnel URL: ${publicUrl}`
);

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

await supabase.from('workflow_runs').insert({
  deployment_id: deploymentId,
  github_run_id: workflowRunId || 'unknown',
  status: 'completed',
}).catch(() => {});

await log('Deployment worker finished. App is live!');
await log(`Tunnel URL: ${publicUrl}`);

// Keep runner alive to maintain the tunnel and app
await log('Keeping runner alive to maintain tunnel and app server...');
while (true) {
  await wait(60000);
  // Periodic health check
  const stillHealthy = await verifyUrlHealthy(publicUrl, 2, 3000);
  if (!stillHealthy) {
    await log('Tunnel health degraded - runner still active but app may be unresponsive', 'warn');
    await updateDeployment({ health_status: 'unhealthy' });
  } else {
    await updateDeployment({ health_status: 'healthy' });
  }
}
