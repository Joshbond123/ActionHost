import { Octokit } from 'octokit';
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const deploymentId = process.env.DEPLOYMENT_ID;
const projectId = process.env.PROJECT_ID;
const workflowRunId = process.env.GITHUB_RUN_ID;

if (!deploymentId || !projectId) throw new Error('DEPLOYMENT_ID and PROJECT_ID are required.');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const log = async (message, level = 'info') => {
  console.log(message);
  await supabase.from('logs').insert({ deployment_id: deploymentId, message, level });
};

const updateDeployment = async (payload) => {
  await supabase.from('deployments').update(payload).eq('id', deploymentId);
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
  const { root, host } = parseDomain(domain);
  const apiBase = process.env.FREEDOMAIN_DNS_API_BASE || 'https://update.dnsexit.com/RemoteUpdate.sv';

  for (let attempt = 1; attempt <= 3; attempt++) {
    const url = `${apiBase}?apikey=${encodeURIComponent(apiKey)}&domain=${encodeURIComponent(root)}&host=${encodeURIComponent(host)}&recordtype=CNAME&target=${encodeURIComponent(targetHostname)}`;
    const response = await fetch(url, { method: 'GET' });
    const body = await response.text();

    if (response.ok && !/error|invalid|failed/i.test(body)) {
      return { ok: true, body };
    }

    if (attempt < 3) await wait(3000 * attempt);
  }

  return { ok: false, body: 'DNS update failed after retries' };
};

const verifyUrlHealthy = async (url) => {
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (response.ok) return true;
    } catch {
      // ignore and retry
    }
    await wait(4000);
  }
  return false;
};

const { data: project, error: projectError } = await supabase.from('projects').select('*').eq('id', projectId).single();
if (projectError) throw projectError;

await updateDeployment({ status: 'starting', workflow_status: 'in_progress', workflow_run_id: workflowRunId || null });
await log(`Starting deployment for ${project.repo_url}`);

execSync(`git clone ${project.repo_url} target-app`, { stdio: 'inherit' });
const hasPackageJson = fs.existsSync('target-app/package.json');

if (hasPackageJson) {
  await log('Installing dependencies');
  execSync('npm ci', { cwd: 'target-app', stdio: 'inherit' });
}

await log(`Running build command: ${project.detected_build_command || 'npm run build'}`);
execSync(project.detected_build_command || 'npm run build', { cwd: 'target-app', stdio: 'inherit', shell: '/bin/bash' });

await log(`Running start command: ${project.detected_start_command || 'npm run preview -- --host 0.0.0.0 --port 4173'}`);
execSync(`${project.detected_start_command || 'npm run preview -- --host 0.0.0.0 --port 4173'} > ../app.log 2>&1 &`, {
  cwd: 'target-app',
  stdio: 'inherit',
  shell: '/bin/bash',
});

await log('Starting Cloudflare Quick Tunnel');
execSync('curl -L --output cloudflared.tgz https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.tgz', { stdio: 'inherit' });
execSync('tar -xzf cloudflared.tgz cloudflared && chmod +x cloudflared');
execSync('./cloudflared tunnel --url http://localhost:4173 > tunnel.log 2>&1 &', { stdio: 'inherit', shell: '/bin/bash' });

await wait(8000);
const tunnelLog = fs.readFileSync('tunnel.log', 'utf8');
const urlMatch = tunnelLog.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
if (!urlMatch) {
  await updateDeployment({ status: 'failed', workflow_status: 'failed', error_message: 'Unable to parse tunnel URL.' });
  throw new Error('Unable to parse tunnel URL');
}

const publicUrl = urlMatch[0];
const tunnelHostname = new URL(publicUrl).hostname;
await updateDeployment({ status: 'warming', public_url: publicUrl, tunnel_hostname: tunnelHostname, workflow_status: 'running' });
await log(`Tunnel ready: ${publicUrl}`);

const tunnelHealthy = await verifyUrlHealthy(publicUrl);
if (!tunnelHealthy) {
  await updateDeployment({ status: 'failed', health_status: 'unhealthy', workflow_status: 'failed', error_message: 'Tunnel health check failed.' });
  throw new Error('Tunnel health check failed.');
}

await updateDeployment({ status: 'ready', health_status: 'healthy' });
await log('Tunnel health check passed. Updating FreeDomain DNS.');

const dnsResult = await updateFreeDomainDns({
  domain: project.domain,
  apiKey: project.free_domain_dns_api_key,
  targetHostname: tunnelHostname,
});

if (!dnsResult.ok) {
  await updateDeployment({ status: 'failed', workflow_status: 'failed', error_message: dnsResult.body });
  await supabase.from('domain_mappings').upsert({ domain: project.domain, dns_status: 'failed' }, { onConflict: 'domain' });
  throw new Error(dnsResult.body);
}

await log('FreeDomain DNS update request accepted. Verifying domain health...');
const domainHealthy = await verifyUrlHealthy(`https://${project.domain}`);
if (!domainHealthy) {
  await updateDeployment({ status: 'failed', workflow_status: 'failed', error_message: 'Domain verification failed after DNS update.' });
  await supabase.from('domain_mappings').upsert(
    {
      domain: project.domain,
      active_deployment_id: deploymentId,
      tunnel_hostname: tunnelHostname,
      last_dns_update_at: new Date().toISOString(),
      dns_status: 'failed',
    },
    { onConflict: 'domain' },
  );
  throw new Error('Domain verification failed.');
}

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

await updateDeployment({ status: 'active', workflow_status: 'active', became_active_at: new Date().toISOString() });
await log('Deployment marked active and domain now points to latest healthy tunnel.');

const { data: oldDeployments } = await supabase
  .from('deployments')
  .select('id,workflow_run_id')
  .eq('project_id', projectId)
  .eq('status', 'active')
  .neq('id', deploymentId);

for (const old of oldDeployments ?? []) {
  await supabase.from('deployments').update({ status: 'draining', workflow_status: 'draining' }).eq('id', old.id);

  if (old.workflow_run_id) {
    const octokit = new Octokit({ auth: process.env.GITHUB_PAT });
    const [owner, repo] = process.env.ACTIONHOST_REPO_PATH.split('/');
    await octokit.rest.actions.cancelWorkflowRun({ owner, repo, run_id: Number(old.workflow_run_id) });
  }

  await supabase.from('deployments').update({ status: 'stopped', workflow_status: 'stopped' }).eq('id', old.id);
  await log(`Stopped previous deployment: ${old.id}`);
}

await supabase.from('workflow_runs').insert({
  deployment_id: deploymentId,
  github_run_id: workflowRunId || 'unknown',
  status: 'completed',
});
