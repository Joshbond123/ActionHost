import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const threshold = new Date(Date.now() + 30 * 60 * 1000).toISOString();

const { data: activeNearExpiry, error } = await supabase
  .from('deployments')
  .select('id, project_id, repo_url, domain')
  .eq('status', 'active')
  .lte('expires_at', threshold);

if (error) throw error;
if (!activeNearExpiry?.length) {
  console.log('No deployments to rotate.');
  process.exit(0);
}

for (const active of activeNearExpiry) {
  const { data: project, error: projectError } = await supabase.from('projects').select('*').eq('id', active.project_id).single();
  if (projectError) throw projectError;

  const { data: queued, error: queuedError } = await supabase
    .from('deployments')
    .insert({
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
    })
    .select()
    .single();

  if (queuedError) throw queuedError;

  await fetch(`https://api.github.com/repos/${process.env.ACTIONHOST_REPO_PATH}/actions/workflows/deploy-worker.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_PAT}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ref: 'main',
      inputs: {
        project_id: project.id,
        deployment_id: queued.id,
      },
    }),
  });

  await supabase.from('logs').insert({
    deployment_id: active.id,
    level: 'info',
    message: `Rotation started. Replacement deployment queued: ${queued.id}`,
  });
}
