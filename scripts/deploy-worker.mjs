import { Octokit } from 'octokit';
import { createClient } from '@supabase/supabase-js';
import { execSync } from 'node:child_process';
import fs from 'node:fs';

const deploymentId = process.env.DEPLOYMENT_ID;
const projectId = process.env.PROJECT_ID;
const workflowRunId = process.env.GITHUB_RUN_ID;

if (!deploymentId || !projectId) throw new Error('DEPLOYMENT_ID and PROJECT_ID are required.');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const octokit = new Octokit({ auth: process.env.GITHUB_PAT });

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const log = async (message, level = 'info') => {
  console.log(message);
  await supabase.from('logs').insert({ deployment_id: deploymentId, message, level });
};

const updateDeployment = async (payload) => {
  await supabase.from('deployments').update(payload).eq('id', deploymentId);
};

const verifyUrl = async (url, attempts = 8) => {
  for (let index = 0; index < attempts; index += 1) {
    try {
      const response = await fetch(url, { redirect: 'follow' });
      if (response.ok) return true;
    } catch {
      // retry
    }
    await wait(4000);
  }
  return false;
};

const { data: project, error: projectError } = await supabase.from('projects').select('*').eq('id', projectId).single();
if (projectError) throw projectError;

const { data: tokenSetting, error: tokenError } = await supabase
  .from('settings')
  .select('value')
  .eq('key', `ngrok_authtoken:${project.id}`)
  .single();

if (tokenError || !tokenSetting?.value) throw new Error('ngrok authtoken not found for this project.');
const ngrokAuthtoken = tokenSetting.value;

await updateDeployment({ status: 'starting', workflow_status: 'running', workflow_run_id: workflowRunId || null, ngrok_domain: project.ngrok_domain });
await log(`Starting deployment for ${project.repo_url}`);

const { owner, repo } = (() => {
  const match = project.repo_url.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (!match) throw new Error('Invalid project repository URL');
  return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
})();

const branch = project.detected_branch || 'main';
const commit = await octokit.rest.repos.getCommit({ owner, repo, ref: branch });
const commitSha = commit.data.sha;

await updateDeployment({ branch, commit_sha: commitSha });
await log(`Deploying commit ${commitSha.slice(0, 7)} from ${branch}`);

execSync(`git clone --branch ${branch} ${project.repo_url} target-app`, { stdio: 'inherit', shell: '/bin/bash' });

if (fs.existsSync('target-app/package.json')) {
  await log('Installing dependencies');
  execSync('npm ci', { cwd: 'target-app', stdio: 'inherit' });
}

await log(`Running build: ${project.detected_build_command || 'npm run build'}`);
execSync(project.detected_build_command || 'npm run build', { cwd: 'target-app', stdio: 'inherit', shell: '/bin/bash' });

await log(`Starting app: ${project.detected_start_command || 'npm run preview -- --host 0.0.0.0 --port 4173'}`);
execSync(`${project.detected_start_command || 'npm run preview -- --host 0.0.0.0 --port 4173'} > ../app.log 2>&1 &`, {
  cwd: 'target-app',
  stdio: 'inherit',
  shell: '/bin/bash',
});

await wait(6000);
await log('Installing ngrok');
execSync('curl -sSL https://ngrok-agent.s3.amazonaws.com/ngrok.asc | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null', { stdio: 'inherit', shell: '/bin/bash' });
execSync('echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | sudo tee /etc/apt/sources.list.d/ngrok.list', { stdio: 'inherit', shell: '/bin/bash' });
execSync('sudo apt-get update && sudo apt-get install ngrok -y', { stdio: 'inherit', shell: '/bin/bash' });

await log('Configuring ngrok authtoken');
execSync(`ngrok config add-authtoken ${ngrokAuthtoken}`, { stdio: 'inherit', shell: '/bin/bash' });

await log(`Starting ngrok tunnel on reserved domain ${project.ngrok_domain}`);
execSync(`ngrok http --domain=${project.ngrok_domain} 4173 > ngrok.log 2>&1 &`, { stdio: 'inherit', shell: '/bin/bash' });
await wait(7000);

const publicUrl = `https://${project.ngrok_domain}`;
await updateDeployment({ status: 'warming', public_url: publicUrl, workflow_status: 'running' });

const healthy = await verifyUrl(publicUrl);
if (!healthy) {
  await updateDeployment({ status: 'failed', health_status: 'unhealthy', workflow_status: 'failed', error_message: `Health check failed for ${publicUrl}` });
  throw new Error(`Health check failed for ${publicUrl}`);
}

await updateDeployment({
  status: 'active',
  health_status: 'healthy',
  workflow_status: 'active',
  became_active_at: new Date().toISOString(),
  public_url: publicUrl,
});

await supabase
  .from('projects')
  .update({ latest_deployed_commit_sha: commitSha, latest_seen_commit_sha: commitSha })
  .eq('id', projectId);

await supabase.from('workflow_runs').insert({ deployment_id: deploymentId, github_run_id: workflowRunId || 'unknown', status: 'completed' });
await log(`Deployment active at ${publicUrl}`);

const { data: previous } = await supabase
  .from('deployments')
  .select('id, workflow_run_id')
  .eq('project_id', projectId)
  .eq('status', 'active')
  .neq('id', deploymentId);

for (const old of previous ?? []) {
  await supabase.from('deployments').update({ status: 'draining', workflow_status: 'draining' }).eq('id', old.id);
  if (old.workflow_run_id) {
    const [actionhostOwner, actionhostRepo] = process.env.ACTIONHOST_REPO_PATH.split('/');
    await octokit.rest.actions.cancelWorkflowRun({ owner: actionhostOwner, repo: actionhostRepo, run_id: Number(old.workflow_run_id) });
  }
  await supabase.from('deployments').update({ status: 'stopped', workflow_status: 'stopped' }).eq('id', old.id);
  await log(`Stopped previous deployment ${old.id}`);
}
