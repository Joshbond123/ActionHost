import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.49.1';

type DeployRequest = {
  repoUrl: string;
  ngrokAuthtoken: string;
  ngrokDomain: string;
};

type Detection = {
  framework: string;
  branch: string;
  buildCommand: string;
  startCommand: string;
  strategy: string;
  latestCommitSha: string;
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const parseRepo = (repoUrl: string) => {
  const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/i);
  if (!match) throw new Error('Invalid GitHub repository URL.');
  return { owner: match[1], repo: match[2].replace(/\.git$/, '') };
};

const detectFromFiles = (files: string[]): Omit<Detection, 'branch' | 'latestCommitSha'> => {
  const names = new Set(files.map((name) => name.toLowerCase()));

  if (names.has('next.config.js') || names.has('next.config.mjs')) {
    return {
      framework: 'Next.js',
      buildCommand: 'npm run build',
      startCommand: 'npm run start -- --hostname 0.0.0.0 --port 4173',
      strategy: 'nextjs-build-and-start',
    };
  }

  if (names.has('vite.config.ts') || names.has('vite.config.js')) {
    return {
      framework: 'Vite',
      buildCommand: 'npm run build',
      startCommand: 'npm run preview -- --host 0.0.0.0 --port 4173',
      strategy: 'vite-preview',
    };
  }

  if (names.has('requirements.txt') || names.has('pyproject.toml')) {
    return {
      framework: 'Python',
      buildCommand: 'echo "python build skipped"',
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
    buildCommand: 'echo "no build"',
    startCommand: 'npx serve -l 4173 .',
    strategy: 'static-server',
  };
};

const detectRepo = async (repoUrl: string): Promise<Detection> => {
  const { owner, repo } = parseRepo(repoUrl);

  const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
  const repoData = repoRes.ok ? await repoRes.json() : null;
  const branch = repoData?.default_branch || 'main';

  const commitRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/commits/${branch}`);
  const commitData = commitRes.ok ? await commitRes.json() : null;
  const latestCommitSha = commitData?.sha || 'unknown';

  const contentsRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents`);
  if (!contentsRes.ok) {
    return {
      framework: 'Node.js',
      branch,
      buildCommand: 'npm run build',
      startCommand: 'npm start',
      strategy: 'node-fallback',
      latestCommitSha,
    };
  }

  const files = ((await contentsRes.json()) as Array<{ name: string }>).map((entry) => entry.name);
  const partial = detectFromFiles(files);
  return { ...partial, branch, latestCommitSha };
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const payload = (await request.json()) as Partial<DeployRequest>;
    const repoUrl = payload.repoUrl || Deno.env.get('DEFAULT_TARGET_REPO') || '';
    const ngrokAuthtoken = payload.ngrokAuthtoken || Deno.env.get('DEFAULT_NGROK_AUTHTOKEN') || '';
    const ngrokDomain = payload.ngrokDomain || Deno.env.get('DEFAULT_NGROK_DOMAIN') || '';

    if (!repoUrl || !ngrokAuthtoken || !ngrokDomain) {
      throw new Error('repoUrl, ngrokAuthtoken, and ngrokDomain are required.');
    }

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL') ?? '',
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    );

    const detection = await detectRepo(repoUrl);
    const name = repoUrl.split('/').pop()?.replace(/\.git$/, '') ?? 'project';

    const { data: project, error: projectError } = await supabase
      .from('projects')
      .upsert(
        {
          repo_url: repoUrl,
          name,
          ngrok_domain: ngrokDomain,
          auto_deploy_enabled: true,
          detected_framework: detection.framework,
          detected_branch: detection.branch,
          detected_build_command: detection.buildCommand,
          detected_start_command: detection.startCommand,
          deployment_strategy: detection.strategy,
          latest_seen_commit_sha: detection.latestCommitSha,
        },
        { onConflict: 'repo_url' },
      )
      .select()
      .single();

    if (projectError) throw projectError;

    await supabase
      .from('settings')
      .upsert({ key: `ngrok_authtoken:${project.id}`, value: ngrokAuthtoken, updated_at: new Date().toISOString() }, { onConflict: 'key' });

    const { data: deployment, error: deploymentError } = await supabase
      .from('deployments')
      .insert({
        project_id: project.id,
        repo_url: repoUrl,
        branch: detection.branch,
        commit_sha: detection.latestCommitSha,
        detected_framework: detection.framework,
        detected_build_command: detection.buildCommand,
        detected_start_command: detection.startCommand,
        ngrok_domain: ngrokDomain,
        status: 'queued',
        workflow_status: 'queued',
        health_status: 'pending',
        expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
      })
      .select()
      .single();

    if (deploymentError) throw deploymentError;

    await supabase.from('logs').insert({
      deployment_id: deployment.id,
      level: 'info',
      message: `Deployment queued for ${repoUrl} @ ${detection.latestCommitSha.slice(0, 7)} (${detection.framework}).`,
    });

    const githubPat = Deno.env.get('GITHUB_PAT');
    const actionhostRepoPath = Deno.env.get('ACTIONHOST_REPO_PATH');
    if (!githubPat || !actionhostRepoPath) throw new Error('Missing GITHUB_PAT or ACTIONHOST_REPO_PATH in function environment.');

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
      throw new Error(`Failed to dispatch deploy-worker workflow (${dispatch.status}).`);
    }

    return new Response(JSON.stringify({ projectId: project.id, deploymentId: deployment.id, detection }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 200,
    });
  } catch (error) {
    return new Response(JSON.stringify({ error: (error as Error).message }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      status: 500,
    });
  }
});
