import { createClient } from '@supabase/supabase-js';

const {
  SUPABASE_URL,
  SUPABASE_SERVICE_ROLE_KEY,
  GITHUB_PAT,
  ACTIONHOST_REPO_PATH,
} = process.env;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY env vars are required.');
  process.exit(1);
}
if (!GITHUB_PAT || !ACTIONHOST_REPO_PATH) {
  console.error('GITHUB_PAT and ACTIONHOST_REPO_PATH env vars are required.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const parseRepo = (repoUrl) => {
  const match = String(repoUrl || '').match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?(?:\/.*)?$/i);
  if (!match) return null;
  return { owner: match[1], repo: match[2] };
};

const getLatestSha = async ({ owner, repo, branch }) => {
  const headers = { Authorization: `Bearer ${GITHUB_PAT}`, Accept: 'application/vnd.github+json' };
  const ref = branch || 'main';
  const res = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${encodeURIComponent(ref)}`, { headers });
  if (!res.ok) {
    // Try default branch fallback
    const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
    if (!repoRes.ok) throw new Error(`GitHub API ${repoRes.status} for ${owner}/${repo}`);
    const repoMeta = await repoRes.json();
    const fb = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${repoMeta.default_branch}`, { headers });
    if (!fb.ok) throw new Error(`GitHub API ${fb.status} for ${owner}/${repo}@${repoMeta.default_branch}`);
    return (await fb.json()).sha;
  }
  return (await res.json()).sha;
};

const dispatchDeploy = async ({ projectId, deploymentId }) => {
  const res = await fetch(
    `https://api.github.com/repos/${ACTIONHOST_REPO_PATH}/actions/workflows/deploy-worker.yml/dispatches`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${GITHUB_PAT}`, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ ref: 'main', inputs: { project_id: projectId, deployment_id: deploymentId } }),
    },
  );
  if (!res.ok) throw new Error(`Workflow dispatch failed: ${res.status} ${await res.text()}`);
};

const { data: projects, error } = await supabase.from('projects').select('*');
if (error) {
  console.error('Failed to load projects:', error.message);
  process.exit(1);
}

const candidates = (projects ?? []).filter((p) => p.auto_deploy !== false && p.repo_url);
console.log(`Auto-deploy watcher: ${candidates.length} project(s) eligible.`);

let triggered = 0;
for (const project of candidates) {
  const parsed = parseRepo(project.repo_url);
  if (!parsed) { console.log(`Skip ${project.id}: unparseable repo_url ${project.repo_url}`); continue; }

  let latestSha;
  try {
    latestSha = await getLatestSha({ ...parsed, branch: project.detected_branch });
  } catch (err) {
    console.log(`Skip ${project.id}: ${err.message}`);
    continue;
  }

  const lastSha = project.last_deployed_sha || '';
  if (latestSha === lastSha) {
    console.log(`No changes for ${parsed.owner}/${parsed.repo} (${latestSha.slice(0, 8)}).`);
    continue;
  }

  console.log(`New commit for ${parsed.owner}/${parsed.repo}: ${lastSha.slice(0, 8) || '(none)'} → ${latestSha.slice(0, 8)}. Triggering deploy...`);

  // Create deployment row
  const { data: deployment, error: depErr } = await supabase.from('deployments').insert({
    project_id: project.id,
    repo_url: project.repo_url,
    domain: project.domain,
    status: 'queued',
    health_status: 'pending',
    detected_framework: project.detected_framework,
    detected_branch: project.detected_branch,
    detected_build_command: project.detected_build_command,
    detected_start_command: project.detected_start_command,
    deployment_strategy: project.deployment_strategy,
    expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
  }).select().single();
  if (depErr) { console.error(`Failed to create deployment for ${project.id}: ${depErr.message}`); continue; }

  await supabase.from('logs').insert({
    deployment_id: deployment.id,
    level: 'info',
    message: `Auto-deploy: detected new commit ${latestSha.slice(0, 8)} on ${parsed.owner}/${parsed.repo}.`,
  });

  try {
    await dispatchDeploy({ projectId: project.id, deploymentId: deployment.id });
    triggered++;
  } catch (err) {
    await supabase.from('deployments').update({ status: 'failed', error_message: err.message }).eq('id', deployment.id);
    console.error(`Dispatch failed for ${project.id}: ${err.message}`);
  }
}

console.log(`Auto-deploy watcher done. Triggered ${triggered} deployment(s).`);
