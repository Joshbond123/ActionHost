import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

type DeployRequest = {
  repoUrl: string;
  cloudflareApiToken: string;
  cloudflareZoneId: string;
  domain: string;
  subdomain?: string;
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const parseRepo = (repoUrl: string) => {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (!match) throw new Error('Invalid GitHub repository URL.');
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/, ''),
  };
};

async function detectFramework(repoUrl: string) {
  const { owner, repo } = parseRepo(repoUrl);
  const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents`);
  if (!response.ok) {
    return { framework: 'Node', branch: 'main', build_command: 'npm run build', start_command: 'npm start' };
  }

  const files = (await response.json()) as Array<{ name: string }>;
  const names = new Set(files.map((file) => file.name.toLowerCase()));

  if (names.has('next.config.js') || names.has('next.config.mjs')) {
    return { framework: 'Next.js', branch: 'main', build_command: 'npm run build', start_command: 'npm run start' };
  }
  if (names.has('vite.config.ts') || names.has('vite.config.js')) {
    return { framework: 'Vite', branch: 'main', build_command: 'npm run build', start_command: 'npm run preview -- --host 0.0.0.0 --port 4173' };
  }
  if (names.has('requirements.txt')) {
    return { framework: 'Python', branch: 'main', build_command: 'echo "python app"', start_command: 'python app.py' };
  }
  if (names.has('package.json')) {
    return { framework: 'Node', branch: 'main', build_command: 'npm run build', start_command: 'npm start' };
  }
  return { framework: 'Static', branch: 'main', build_command: 'echo "static"', start_command: 'npx serve -l 4173 .' };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const payload = (await req.json()) as DeployRequest;
    const { repoUrl, cloudflareApiToken, cloudflareZoneId, domain, subdomain } = payload;
    if (!repoUrl || !cloudflareApiToken || !cloudflareZoneId || !domain) {
      throw new Error('repoUrl, cloudflareApiToken, cloudflareZoneId, and domain are required.');
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const analysis = await detectFramework(repoUrl);
    const name = repoUrl.split('/').pop()?.replace(/\.git$/, '') ?? 'project';

    const { data: project, error: projectError } = await supabase
      .from('projects')
      .insert({
        name,
        repo_url: repoUrl,
        domain,
        subdomain: subdomain || null,
        cloudflare_zone_id: cloudflareZoneId,
        cloudflare_api_token: cloudflareApiToken,
        framework: analysis.framework,
        branch: analysis.branch,
        build_command: analysis.build_command,
        start_command: analysis.start_command,
      })
      .select()
      .single();

    if (projectError) throw projectError;

    const expiresAt = new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString();
    const { data: deployment, error: deploymentError } = await supabase
      .from('deployments')
      .insert({ project_id: project.id, status: 'queued', expires_at: expiresAt })
      .select()
      .single();
    if (deploymentError) throw deploymentError;

    const githubToken = Deno.env.get('GITHUB_PAT');
    const repoPath = Deno.env.get('ACTIONHOST_REPO_PATH');
    if (!githubToken || !repoPath) throw new Error('Missing GITHUB_PAT or ACTIONHOST_REPO_PATH in function env.');

    const [owner, repo] = repoPath.split('/');

    await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows/deploy-worker.yml/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${githubToken}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          deployment_id: deployment.id,
          project_id: project.id,
        },
      }),
    });

    return new Response(
      JSON.stringify({ projectId: project.id, deploymentId: deployment.id, analysis }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 },
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
