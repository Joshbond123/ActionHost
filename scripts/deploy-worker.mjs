import { Octokit } from 'octokit';
import { createClient } from '@supabase/supabase-js';
import { execSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

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
  if (!apiKey) {
    return { ok: false, body: 'FreeDomain DNS API key not configured.' };
  }
  const { root, host } = parseDomain(domain);
  const apiBase = process.env.FREEDOMAIN_DNS_API_BASE || 'https://update.dnsexit.com/RemoteUpdate.sv';

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const url = `${apiBase}?apikey=${encodeURIComponent(apiKey)}&domain=${encodeURIComponent(root)}&host=${encodeURIComponent(host)}&recordtype=CNAME&target=${encodeURIComponent(targetHostname)}`;
      const response = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(10000) });
      const body = await response.text();
      console.log(`DNS update attempt ${attempt}: status=${response.status} body=${body}`);

      if (response.ok && !/error|invalid|failed/i.test(body)) {
        return { ok: true, body };
      }
    } catch (err) {
      console.error(`DNS update attempt ${attempt} failed:`, err.message);
    }

    if (attempt < 3) await wait(5000 * attempt);
  }

  return { ok: false, body: 'DNS update failed after 3 retries.' };
};

const verifyUrlHealthy = async (url, maxAttempts = 8, delayMs = 5000) => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10000) });
      if (response.ok || response.status < 500) return true;
    } catch {
      // retry
    }
    await wait(delayMs);
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
    // Use npm ci if package-lock exists, otherwise npm install
    const lockExists = fs.existsSync('target-app/package-lock.json');
    execSync(lockExists ? 'npm ci' : 'npm install', { cwd: 'target-app', stdio: 'inherit' });
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
  await updateDeployment({ status: 'failed', error_message: `Build failed: ${err.message}` });
  await log(`Build failed: ${err.message}`, 'error');
  process.exit(1);
}

// Start app
const startCmd = project.detected_start_command || 'npm run preview -- --host 0.0.0.0 --port 4173';
await log(`Starting app: ${startCmd}`);
try {
  execSync(`${startCmd} > ../app.log 2>&1 &`, {
    cwd: 'target-app',
    stdio: 'inherit',
    shell: '/bin/bash',
  });
  await wait(4000);
} catch (err) {
  await updateDeployment({ status: 'failed', error_message: `App start failed: ${err.message}` });
  await log(`App start failed: ${err.message}`, 'error');
  process.exit(1);
}

// Download and start Cloudflare Quick Tunnel
await log('Starting Cloudflare Quick Tunnel...');
try {
  execSync('curl -fsSL -o cloudflared.tgz https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.tgz', { stdio: 'inherit' });
  execSync('tar -xzf cloudflared.tgz && chmod +x cloudflared');
} catch (err) {
  await updateDeployment({ status: 'failed', error_message: `cloudflared download failed: ${err.message}` });
  await log(`cloudflared download failed: ${err.message}`, 'error');
  process.exit(1);
}

execSync('./cloudflared tunnel --url http://localhost:4173 --no-autoupdate > tunnel.log 2>&1 &', {
  stdio: 'inherit',
  shell: '/bin/bash',
});

// Wait for tunnel URL to appear in log (up to 30s)
let publicUrl = null;
for (let i = 0; i < 15; i++) {
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
  await updateDeployment({ status: 'failed', workflow_status: 'failed', error_message: 'Unable to parse tunnel URL.' });
  await log(`Tunnel log: ${tunnelLog}`, 'error');
  await log('Unable to parse tunnel URL.', 'error');
  process.exit(1);
}

const tunnelHostname = new URL(publicUrl).hostname;
await updateDeployment({ status: 'warming', public_url: publicUrl, tunnel_hostname: tunnelHostname, workflow_status: 'running' });
await log(`Tunnel ready: ${publicUrl}`);

// Health check tunnel
const tunnelHealthy = await verifyUrlHealthy(publicUrl, 8, 5000);
if (!tunnelHealthy) {
  await updateDeployment({ status: 'failed', health_status: 'unhealthy', workflow_status: 'failed', error_message: 'Tunnel health check failed.' });
  await log('Tunnel health check failed after 8 attempts.', 'error');
  process.exit(1);
}

await updateDeployment({ status: 'ready', health_status: 'healthy' });
await log('Tunnel health check passed.');

// Update FreeDomain DNS
await log(`Updating FreeDomain DNS for domain: ${project.domain}`);
const dnsResult = await updateFreeDomainDns({
  domain: project.domain,
  apiKey: project.free_domain_dns_api_key,
  targetHostname: tunnelHostname,
});

if (!dnsResult.ok) {
  await updateDeployment({ status: 'failed', workflow_status: 'failed', error_message: dnsResult.body });
  await supabase.from('domain_mappings').upsert(
    { domain: project.domain, dns_status: 'failed', tunnel_hostname: tunnelHostname },
    { onConflict: 'domain' },
  );
  await log(`DNS update failed: ${dnsResult.body}`, 'error');
  process.exit(1);
}

await log(`DNS update accepted: ${dnsResult.body}`);

// Verify domain health (DNS propagation may take a few minutes)
await log(`Verifying domain health: https://${project.domain}`);
const domainHealthy = await verifyUrlHealthy(`https://${project.domain}`, 12, 10000);

if (!domainHealthy) {
  // Domain health failed but DNS update was accepted — mark as partially active
  await log('Domain health check failed after 12 attempts. DNS may still be propagating.', 'warn');
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

await updateDeployment({
  status: 'active',
  workflow_status: 'active',
  became_active_at: new Date().toISOString(),
});
await log(domainHealthy ? 'Deployment active. Domain is live.' : 'Deployment active. Tunnel is live (DNS may still be propagating).');

// Mark old deployments as draining/stopped
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

// Record workflow run
await supabase.from('workflow_runs').insert({
  deployment_id: deploymentId,
  github_run_id: workflowRunId || 'unknown',
  status: 'completed',
});

await log('Deployment worker finished successfully.');

// Keep the process alive to maintain the tunnel and app server
await log('Keeping runner alive to maintain tunnel and app server...');
while (true) {
  await wait(60000);
}
