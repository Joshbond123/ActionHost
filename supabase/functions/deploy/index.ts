import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

type DeployRequest = {
  repoUrl: string;
  freeDomainDomain: string;
  freeDomainDnsApiKey: string;
};

type Detection = {
  framework: string;
  branch: string;
  buildCommand: string;
  startCommand: string;
  strategy: string;
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const repoParser = (repoUrl: string) => {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (!match) throw new Error('Invalid GitHub repository URL.');
  return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
};

const detectFromFiles = (files: string[]): Omit<Detection, 'branch'> => {
  const names = new Set(files.map((file) => file.toLowerCase()));

  if (names.has('next.config.js') || names.has('next.config.mjs')) {
    return {
      framework: 'Next.js',
      buildCommand: 'npm run build',
      startCommand: 'npm run start -- --hostname 0.0.0.0 --port 4173',
      strategy: 'build-and-run-next',
    };
  }

  if (names.has('vite.config.ts') || names.has('vite.config.js')) {
    return {
      framework: 'Vite',
      buildCommand: 'npm run build',
      startCommand: 'npm run preview -- --host 0.0.0.0 --port 4173',
      strategy: 'build-and-preview-vite',
    };
  }

  if (names.has('requirements.txt') || names.has('pyproject.toml')) {
    return {
      framework: 'Python',
      buildCommand: 'echo "python build not required"',
      startCommand: 'python app.py',
      strategy: 'python-runtime',
    };
  }

  if (names.has('package.json')) {
    return {
      framework: 'Node.js',
      buildCommand: 'npm run build',
      startCommand: 'npm start',
      strategy: 'node-runtime',
    };
  }

  return {
    framework: 'Static',
    buildCommand: 'echo "no build required"',
    startCommand: 'npx serve -l 4173 .',
    strategy: 'static-hosting',
  };
};

const detectRepository = async (repoUrl: string): Promise<Detection> => {
  const { owner, repo } = repoParser(repoUrl);
  const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
  const defaultBranch = repoRes.ok ? (await repoRes.json()).default_branch || 'main' : 'main';

  const contentsRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents`);
  if (!contentsRes.ok) {
    return {
      framework: 'Node.js',
      branch: defaultBranch,
      buildCommand: 'npm run build',
      startCommand: 'npm start',
      strategy: 'node-runtime-fallback',
    };
  }

  const files = ((await contentsRes.json()) as Array<{ name: string }>).map((item) => item.name);
  const detected = detectFromFiles(files);
  return { ...detected, branch: defaultBranch };
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = (await request.json()) as DeployRequest;
    const { repoUrl, freeDomainDomain, freeDomainDnsApiKey } = body;

    if (!repoUrl || !freeDomainDomain || !freeDomainDnsApiKey) {
      throw new Error('repoUrl, freeDomainDomain, and freeDomainDnsApiKey are required.');
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const detection = await detectRepository(repoUrl);
    const projectName = repoUrl.split('/').pop()?.replace(/\.git$/, '') ?? 'project';

    const { data: project, error: projectError } = await supabase
      .from('projects')
      .insert({
        name: projectName,
        repo_url: repoUrl,
        domain: freeDomainDomain,
        free_domain_dns_api_key: freeDomainDnsApiKey,
        detected_framework: detection.framework,
        detected_branch: detection.branch,
        detected_build_command: detection.buildCommand,
        detected_start_command: detection.startCommand,
        deployment_strategy: detection.strategy,
      })
      .select()
      .single();

    if (projectError) throw projectError;

    const { data: deployment, error: deploymentError } = await supabase
      .from('deployments')
      .insert({
        project_id: project.id,
        repo_url: repoUrl,
        domain: freeDomainDomain,
        status: 'queued',
        health_status: 'pending',
        detected_framework: detection.framework,
        detected_branch: detection.branch,
        detected_build_command: detection.buildCommand,
        detected_start_command: detection.startCommand,
        deployment_strategy: detection.strategy,
        expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      })
      .select()
      .single();

    if (deploymentError) throw deploymentError;

    await supabase.from('logs').insert({
      deployment_id: deployment.id,
      level: 'info',
      message: `Deployment queued for ${repoUrl}. Detected ${detection.framework} (${detection.branch}).`,
    });

    const githubPat = Deno.env.get('GITHUB_PAT');
    const actionhostRepoPath = Deno.env.get('ACTIONHOST_REPO_PATH');
    if (!githubPat || !actionhostRepoPath) throw new Error('Missing GITHUB_PAT or ACTIONHOST_REPO_PATH in edge-function env.');

    const dispatch = await fetch(`https://api.github.com/repos/${actionhostRepoPath}/actions/workflows/deploy-worker.yml/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${githubPat}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ref: 'main',
        inputs: {
          project_id: project.id,
          deployment_id: deployment.id,
        },
      }),
    });

    if (!dispatch.ok) {
      const reason = await dispatch.text();
      throw new Error(`Failed to trigger GitHub workflow: ${reason}`);
    }

    return new Response(
      JSON.stringify({
        projectId: project.id,
        deploymentId: deployment.id,
        detection,
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 200 },
    );
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
