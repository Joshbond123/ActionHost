import { Octokit } from 'octokit';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
const octokit = new Octokit({ auth: process.env.GITHUB_PAT });

const defaultRepo = process.env.ACTIONHOST_DEFAULT_TARGET_REPO;
const defaultDomain = process.env.ACTIONHOST_DEFAULT_NGROK_DOMAIN;
const defaultToken = process.env.ACTIONHOST_DEFAULT_NGROK_AUTHTOKEN;

const parseRepo = (repoUrl) => {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (!match) throw new Error(`Invalid repo URL: ${repoUrl}`);
  return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
};

const detectFromFiles = (files) => {
  const names = new Set(files.map((name) => name.toLowerCase()));
  if (names.has('next.config.js') || names.has('next.config.mjs')) return { framework: 'Next.js', build: 'npm run build', start: 'npm run start -- --hostname 0.0.0.0 --port 4173', strategy: 'nextjs-build-and-start' };
  if (names.has('vite.config.ts') || names.has('vite.config.js')) return { framework: 'Vite', build: 'npm run build', start: 'npm run preview -- --host 0.0.0.0 --port 4173', strategy: 'vite-preview' };
  if (names.has('requirements.txt') || names.has('pyproject.toml')) return { framework: 'Python', build: 'echo "python build skipped"', start: 'python app.py', strategy: 'python-runtime' };
  return { framework: 'Node.js', build: 'npm run build', start: 'npm start', strategy: 'node-runtime' };
};

const queueDeployment = async (project, reason, commitSha) => {
  const { data: queued, error } = await supabase
    .from('deployments')
    .insert({
      project_id: project.id,
      repo_url: project.repo_url,
      branch: project.detected_branch || 'main',
      commit_sha: commitSha,
      detected_framework: project.detected_framework,
      detected_build_command: project.detected_build_command,
      detected_start_command: project.detected_start_command,
      ngrok_domain: project.ngrok_domain,
      status: 'queued',
      workflow_status: 'queued',
      health_status: 'pending',
      expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
    })
    .select()
    .single();

  if (error) throw error;

  await fetch(`https://api.github.com/repos/${process.env.ACTIONHOST_REPO_PATH}/actions/workflows/deploy-worker.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_PAT}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ ref: 'main', inputs: { project_id: project.id, deployment_id: queued.id } }),
  });

  await supabase.from('logs').insert({
    deployment_id: queued.id,
    level: 'info',
    message: `Deployment queued (${reason}) for commit ${commitSha?.slice(0, 7) || 'unknown'}.`,
  });
};

const ensureDefaultProject = async () => {
  if (!defaultRepo || !defaultDomain || !defaultToken) return;

  const existing = await supabase.from('projects').select('*').eq('repo_url', defaultRepo).maybeSingle();
  if (existing.data) return;

  const { owner, repo } = parseRepo(defaultRepo);
  const repoMeta = await octokit.rest.repos.get({ owner, repo });
  const branch = repoMeta.data.default_branch || 'main';
  const latestCommit = await octokit.rest.repos.getCommit({ owner, repo, ref: branch });
  const rootFiles = await octokit.rest.repos.getContent({ owner, repo, path: '' });
  const files = Array.isArray(rootFiles.data) ? rootFiles.data.map((item) => item.name) : [];
  const detected = detectFromFiles(files);

  const { data: project, error } = await supabase
    .from('projects')
    .insert({
      name: repo,
      repo_url: defaultRepo,
      ngrok_domain: defaultDomain,
      auto_deploy_enabled: true,
      detected_framework: detected.framework,
      detected_branch: branch,
      detected_build_command: detected.build,
      detected_start_command: detected.start,
      deployment_strategy: detected.strategy,
      latest_seen_commit_sha: latestCommit.data.sha,
    })
    .select()
    .single();

  if (error) throw error;

  await supabase.from('settings').upsert({ key: `ngrok_authtoken:${project.id}`, value: defaultToken, updated_at: new Date().toISOString() }, { onConflict: 'key' });
  await queueDeployment(project, 'default project bootstrap', latestCommit.data.sha);
};

await ensureDefaultProject();

const projectsResult = await supabase.from('projects').select('*').eq('auto_deploy_enabled', true);
if (projectsResult.error) throw projectsResult.error;

for (const project of projectsResult.data ?? []) {
  const { owner, repo } = parseRepo(project.repo_url);
  const branch = project.detected_branch || 'main';
  const latestCommit = await octokit.rest.repos.getCommit({ owner, repo, ref: branch });
  const latestSha = latestCommit.data.sha;

  await supabase.from('projects').update({ latest_seen_commit_sha: latestSha }).eq('id', project.id);

  const active = await supabase
    .from('deployments')
    .select('id,expires_at,commit_sha,status')
    .eq('project_id', project.id)
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  const activeDeployment = active.data;
  const commitChanged = project.latest_deployed_commit_sha !== latestSha;
  const nearExpiry = activeDeployment?.expires_at ? new Date(activeDeployment.expires_at).getTime() < Date.now() + 30 * 60 * 1000 : false;

  if (!activeDeployment) {
    await queueDeployment(project, 'initial auto deployment', latestSha);
    continue;
  }

  if (commitChanged) {
    await queueDeployment(project, 'new repository commit detected', latestSha);
    continue;
  }

  if (nearExpiry) {
    await queueDeployment(project, 'rotation before expiry', latestSha);
  }
}
