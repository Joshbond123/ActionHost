import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = await request.json();
    const { projectId, repoUrl, domain, dnsApiKey, envVars, redeploy } = body;

    if (!projectId) throw new Error('projectId is required.');

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const githubPat = Deno.env.get('GITHUB_PAT');
    const actionhostRepoPath = Deno.env.get('ACTIONHOST_REPO_PATH');

    if (!supabaseUrl || !supabaseServiceKey) throw new Error('Supabase credentials not configured.');

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Build update payload
    const updatePayload: Record<string, unknown> = {};
    if (repoUrl) updatePayload.repo_url = repoUrl;
    if (domain) updatePayload.domain = domain;
    if (dnsApiKey) updatePayload.free_domain_dns_api_key = dnsApiKey;

    // Update project fields if any changed
    if (Object.keys(updatePayload).length > 0) {
      const { error } = await supabase.from('projects').update(updatePayload).eq('id', projectId);
      if (error) throw new Error(`Failed to update project: ${error.message}`);
    }

    // Save env vars to settings table (keyed by project ID)
    if (envVars !== undefined) {
      const envJson = JSON.stringify(envVars);
      const { error: settingsError } = await supabase
        .from('settings')
        .upsert({ key: `env_${projectId}`, value: envJson, updated_at: new Date().toISOString() }, { onConflict: 'key' });
      if (settingsError) throw new Error(`Failed to save env vars: ${settingsError.message}`);
    }

    if (!redeploy) {
      return new Response(JSON.stringify({ ok: true }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }

    // Re-deploy: fetch current project state and trigger a new workflow
    if (!githubPat) throw new Error('GITHUB_PAT not configured.');
    if (!actionhostRepoPath) throw new Error('ACTIONHOST_REPO_PATH not configured.');

    const { data: project, error: fetchError } = await supabase.from('projects').select('*').eq('id', projectId).single();
    if (fetchError) throw new Error(`Failed to fetch project: ${fetchError.message}`);

    const { data: deployment, error: deploymentError } = await supabase.from('deployments').insert({
      project_id: projectId,
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

    if (deploymentError) throw new Error(`Failed to create deployment: ${deploymentError.message}`);

    await supabase.from('logs').insert({
      deployment_id: deployment.id,
      level: 'info',
      message: `Re-deployment queued after project update.`,
    });

    const dispatchRes = await fetch(
      `https://api.github.com/repos/${actionhostRepoPath}/actions/workflows/deploy-worker.yml/dispatches`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${githubPat}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          ref: 'main',
          inputs: { project_id: projectId, deployment_id: deployment.id },
        }),
      },
    );

    if (!dispatchRes.ok) {
      const reason = await dispatchRes.text();
      await supabase.from('deployments').update({ status: 'failed', error_message: `Workflow trigger failed: ${reason}` }).eq('id', deployment.id);
      throw new Error(`Failed to trigger GitHub workflow: ${reason}`);
    }

    await supabase.from('logs').insert({
      deployment_id: deployment.id,
      level: 'info',
      message: 'GitHub Actions workflow triggered successfully.',
    });

    return new Response(
      JSON.stringify({ ok: true, deploymentId: deployment.id }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
