import { createClient } from '@supabase/supabase-js';

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const now = new Date();
const threshold = new Date(now.getTime() + 30 * 60 * 1000).toISOString();

const { data: candidates, error } = await supabase
  .from('deployments')
  .select('id,project_id,expires_at,status')
  .eq('status', 'active')
  .lte('expires_at', threshold);

if (error) throw error;
if (!candidates?.length) {
  console.log('No active deployments nearing expiration.');
  process.exit(0);
}

for (const deployment of candidates) {
  const { data: project } = await supabase.from('projects').select('*').eq('id', deployment.project_id).single();
  const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
  const { data: newDeployment, error: insertError } = await supabase
    .from('deployments')
    .insert({
      project_id: project.id,
      status: 'queued',
      expires_at: expiresAt,
    })
    .select()
    .single();

  if (insertError) throw insertError;

  await fetch(`https://api.github.com/repos/${process.env.ACTIONHOST_REPO_PATH}/actions/workflows/deploy-worker.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GITHUB_PAT}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      ref: 'main',
      inputs: { project_id: project.id, deployment_id: newDeployment.id },
    }),
  });

  await supabase.from('logs').insert({
    deployment_id: deployment.id,
    level: 'info',
    message: `Rotation started. New deployment queued: ${newDeployment.id}`,
  });
}
