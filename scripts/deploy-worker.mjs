import { Octokit } from 'octokit';
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const deploymentId = process.env.DEPLOYMENT_ID;
const projectId = process.env.PROJECT_ID;

if (!deploymentId || !projectId) throw new Error('DEPLOYMENT_ID and PROJECT_ID are required.');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const log = async (message, level = 'info') => {
  console.log(message);
  await supabase.from('logs').insert({ deployment_id: deploymentId, message, level });
};

const { data: project, error: projectError } = await supabase.from('projects').select('*').eq('id', projectId).single();
if (projectError) throw projectError;

await supabase.from('deployments').update({ status: 'starting' }).eq('id', deploymentId);
await log(`Cloning ${project.repo_url}`);

execSync(`git clone ${project.repo_url} target-app`, { stdio: 'inherit' });

const appDir = 'target-app';
const hasPackageJson = fs.existsSync(`${appDir}/package.json`);

if (hasPackageJson) {
  await log('Installing npm dependencies');
  execSync('npm ci', { cwd: appDir, stdio: 'inherit' });
}

await log(`Running build command: ${project.build_command || 'npm run build'}`);
execSync(project.build_command || 'npm run build', { cwd: appDir, stdio: 'inherit' });

await log('Starting temporary Cloudflare quick tunnel');
execSync('curl -L --output cloudflared.tgz https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.tgz', { stdio: 'inherit' });
execSync('tar -xzf cloudflared.tgz cloudflared && chmod +x cloudflared');

const startCommand = project.start_command || 'npm run preview -- --host 0.0.0.0 --port 4173';
execSync(`${startCommand} > ../app.log 2>&1 &`, { cwd: appDir, stdio: 'inherit', shell: '/bin/bash' });
execSync('sleep 8');
execSync('./cloudflared tunnel --url http://localhost:4173 > tunnel.log 2>&1 &', { stdio: 'inherit', shell: '/bin/bash' });
execSync('sleep 8');

const tunnelLog = fs.readFileSync('tunnel.log', 'utf8');
const urlMatch = tunnelLog.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
if (!urlMatch) throw new Error('Could not get Cloudflare tunnel URL');

const publicUrl = urlMatch[0];
await log(`Tunnel live: ${publicUrl}`);

await supabase.from('deployments').update({ status: 'ready', public_url: publicUrl, healthcheck_url: publicUrl }).eq('id', deploymentId);

const health = await fetch(publicUrl);
if (!health.ok) {
  await supabase.from('deployments').update({ status: 'failed' }).eq('id', deploymentId);
  throw new Error(`Health check failed: ${health.status}`);
}

await log('Health check passed. Updating Cloudflare DNS.');

const recordName = project.subdomain ? `${project.subdomain}.${project.domain}` : project.domain;
const targetHostname = new URL(publicUrl).hostname;

const listRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${project.cloudflare_zone_id}/dns_records?name=${recordName}`, {
  headers: { Authorization: `Bearer ${project.cloudflare_api_token}`, 'Content-Type': 'application/json' },
});

const listJson = await listRes.json();
const existing = listJson?.result?.[0];

if (existing) {
  await fetch(`https://api.cloudflare.com/client/v4/zones/${project.cloudflare_zone_id}/dns_records/${existing.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${project.cloudflare_api_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'CNAME', name: recordName, content: targetHostname, proxied: true, ttl: 1 }),
  });
} else {
  await fetch(`https://api.cloudflare.com/client/v4/zones/${project.cloudflare_zone_id}/dns_records`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${project.cloudflare_api_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'CNAME', name: recordName, content: targetHostname, proxied: true, ttl: 1 }),
  });
}

await supabase.from('domain_mappings').insert({
  project_id: projectId,
  deployment_id: deploymentId,
  fqdn: recordName,
  target_hostname: targetHostname,
  status: 'active',
});

await supabase.from('deployments').update({ status: 'active' }).eq('id', deploymentId);
await log('Deployment is active.');

const { data: activeRows } = await supabase
  .from('deployments')
  .select('id,workflow_run_id')
  .eq('project_id', projectId)
  .eq('status', 'active')
  .neq('id', deploymentId);

for (const oldRow of activeRows ?? []) {
  await supabase.from('deployments').update({ status: 'draining' }).eq('id', oldRow.id);
  if (oldRow.workflow_run_id) {
    const octokit = new Octokit({ auth: process.env.GITHUB_PAT });
    const [owner, repo] = process.env.ACTIONHOST_REPO_PATH.split('/');
    await octokit.rest.actions.cancelWorkflowRun({ owner, repo, run_id: Number(oldRow.workflow_run_id) });
  }
  await supabase.from('deployments').update({ status: 'stopped' }).eq('id', oldRow.id);
}
