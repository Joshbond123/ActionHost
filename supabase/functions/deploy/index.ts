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

const detectFromFiles = (files: string[], pkgScripts: Record<string, string>): Omit<Detection, 'branch'> => {
  const names = new Set(files.map((file) => file.toLowerCase()));

  const hasServerFile = names.has('server.ts') || names.has('server.js') || names.has('server.mjs') || names.has('app.ts') || names.has('app.js');
  const hasViteConfig = names.has('vite.config.ts') || names.has('vite.config.js') || names.has('vite.config.mjs');
  const hasNextConfig = names.has('next.config.js') || names.has('next.config.mjs') || names.has('next.config.ts');

  // Express + Vite hybrid: has both vite config and a server entry file
  // Or package.json "start" script runs a server file (tsx/node server.ts)
  const startScript = pkgScripts['start'] ?? '';
  const isExpressServer = hasServerFile && (
    startScript.includes('server.ts') || startScript.includes('server.js') ||
    startScript.includes('app.ts') || startScript.includes('app.js') ||
    startScript.includes('tsx') || startScript.includes('ts-node')
  );

  if (isExpressServer && hasViteConfig) {
    return {
      framework: 'Node.js (Express + Vite)',
      buildCommand: 'npm run build',
      startCommand: 'PORT=4173 NODE_ENV=production npm start',
      strategy: 'build-and-run-express',
    };
  }

  if (hasNextConfig) {
    return {
      framework: 'Next.js',
      buildCommand: 'npm run build',
      startCommand: 'npm run start -- --hostname 0.0.0.0 --port 4173',
      strategy: 'build-and-run-next',
    };
  }

  if (hasViteConfig) {
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

  if (names.has('cargo.toml')) {
    return {
      framework: 'Rust',
      buildCommand: 'cargo build --release',
      startCommand: './target/release/app',
      strategy: 'rust-runtime',
    };
  }

  if (names.has('go.mod')) {
    return {
      framework: 'Go',
      buildCommand: 'go build -o app .',
      startCommand: './app',
      strategy: 'go-runtime',
    };
  }

  if (names.has('package.json')) {
    if (isExpressServer) {
      return {
        framework: 'Node.js (Express)',
        buildCommand: 'npm run build 2>/dev/null || echo "no build"',
        startCommand: 'PORT=4173 NODE_ENV=production npm start',
        strategy: 'node-express-runtime',
      };
    }
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

const detectRepository = async (repoUrl: string, githubPat?: string): Promise<Detection> => {
  const { owner, repo } = repoParser(repoUrl);

  const headers: Record<string, string> = { Accept: 'application/vnd.github+json' };
  if (githubPat) headers['Authorization'] = `Bearer ${githubPat}`;

  const repoRes = await fetch(`https://api.github.com/repos/${owner}/${repo}`, { headers });
  const defaultBranch = repoRes.ok ? ((await repoRes.json()).default_branch || 'main') : 'main';

  const contentsRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents`, { headers });
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

  // Also fetch package.json scripts if present
  let pkgScripts: Record<string, string> = {};
  if (files.some(f => f.toLowerCase() === 'package.json')) {
    try {
      const pkgRes = await fetch(`https://api.github.com/repos/${owner}/${repo}/contents/package.json`, { headers });
      if (pkgRes.ok) {
        const pkgData = await pkgRes.json() as { content?: string };
        if (pkgData.content) {
          const pkgJson = JSON.parse(atob(pkgData.content.replace(/\n/g, '')));
          pkgScripts = pkgJson.scripts ?? {};
        }
      }
    } catch (_) { /* ignore */ }
  }

  const detected = detectFromFiles(files, pkgScripts);
  return { ...detected, branch: defaultBranch };
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  try {
    const body = (await request.json()) as DeployRequest;
    const { repoUrl, freeDomainDomain, freeDomainDnsApiKey } = body;

    if (!repoUrl) throw new Error('repoUrl is required.');
    if (!freeDomainDomain) throw new Error('freeDomainDomain is required.');
    if (!freeDomainDnsApiKey) throw new Error('freeDomainDnsApiKey is required.');

    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

    if (!supabaseUrl || !supabaseServiceKey) {
      throw new Error('Supabase credentials not configured in edge function environment.');
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    const githubPat = Deno.env.get('GITHUB_PAT');
    const actionhostRepoPath = Deno.env.get('ACTIONHOST_REPO_PATH');

    if (!githubPat) throw new Error('GITHUB_PAT not configured in edge function environment. Set it in Supabase Edge Function secrets.');
    if (!actionhostRepoPath) throw new Error('ACTIONHOST_REPO_PATH not configured in edge function environment.');

    const detection = await detectRepository(repoUrl, githubPat);
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

    if (projectError) throw new Error(`Failed to create project: ${projectError.message}`);

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

    if (deploymentError) throw new Error(`Failed to create deployment: ${deploymentError.message}`);

    await supabase.from('logs').insert({
      deployment_id: deployment.id,
      level: 'info',
      message: `Deployment queued for ${repoUrl}. Detected ${detection.framework} (branch: ${detection.branch}).`,
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
          inputs: {
            project_id: project.id,
            deployment_id: deployment.id,
          },
        }),
      },
    );

    if (!dispatchRes.ok) {
      const reason = await dispatchRes.text();
      await supabase.from('logs').insert({
        deployment_id: deployment.id,
        level: 'error',
        message: `Failed to trigger GitHub workflow: ${reason}`,
      });
      await supabase.from('deployments').update({ status: 'failed', error_message: `Workflow trigger failed: ${reason}` }).eq('id', deployment.id);
      throw new Error(`Failed to trigger GitHub workflow: ${reason}`);
    }

    await supabase.from('logs').insert({
      deployment_id: deployment.id,
      level: 'info',
      message: 'GitHub Actions workflow triggered successfully.',
    });

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
