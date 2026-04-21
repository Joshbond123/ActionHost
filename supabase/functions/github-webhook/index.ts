// GitHub webhook receiver — triggers an instant redeployment whenever a push
// event arrives for a repository connected to an ActionHost project.
//
// Flow:
//   1. GitHub pushes commit -> POSTs to this endpoint with X-GitHub-Event: push
//   2. We verify the X-Hub-Signature-256 HMAC against GITHUB_WEBHOOK_SECRET
//   3. We look up the project whose repo_url matches the pushed repository and
//      whose tracked branch matches the pushed ref
//   4. If the project has auto_deploy enabled, we create a new deployment row
//      and dispatch the deploy-worker GitHub Actions workflow immediately

import { createClient } from 'jsr:@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

const hexFromBuffer = (buf: ArrayBuffer) =>
  Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');

const verifySignature = async (secret: string, rawBody: string, signatureHeader: string | null) => {
  if (!signatureHeader || !signatureHeader.startsWith('sha256=')) return false;
  const expected = signatureHeader.slice('sha256='.length);

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody));
  const actual = hexFromBuffer(sig);

  // constant-time compare
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
};

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  try {
    const supabaseUrl = Deno.env.get('SUPABASE_URL') ?? '';
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';
    const webhookSecret = Deno.env.get('GITHUB_WEBHOOK_SECRET') ?? '';
    const githubPat = Deno.env.get('GITHUB_PAT') ?? '';
    const actionhostRepoPath = Deno.env.get('ACTIONHOST_REPO_PATH') ?? '';

    if (!supabaseUrl || !supabaseServiceKey) return json({ error: 'Supabase env not configured' }, 500);
    if (!webhookSecret) return json({ error: 'GITHUB_WEBHOOK_SECRET not configured' }, 500);
    if (!githubPat || !actionhostRepoPath) return json({ error: 'GitHub env not configured' }, 500);

    const event = request.headers.get('x-github-event') ?? '';
    const rawBody = await request.text();

    // GitHub sends a one-shot 'ping' on webhook creation — verify and ack.
    const ok = await verifySignature(webhookSecret, rawBody, request.headers.get('x-hub-signature-256'));
    if (!ok) return json({ error: 'Invalid signature' }, 401);

    if (event === 'ping') return json({ ok: true, pong: true });
    if (event !== 'push') return json({ ok: true, ignored: event });

    const payload = JSON.parse(rawBody);
    const repoFullName: string = payload?.repository?.full_name ?? '';
    const refStr: string = payload?.ref ?? ''; // e.g. "refs/heads/main"
    const headSha: string = payload?.after ?? '';
    const deleted: boolean = payload?.deleted === true;

    if (!repoFullName || !refStr.startsWith('refs/heads/')) {
      return json({ ok: true, ignored: 'not a branch push' });
    }
    if (deleted) return json({ ok: true, ignored: 'branch deleted' });

    const branch = refStr.slice('refs/heads/'.length);
    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Find candidate projects whose repo_url ends with /<full_name>(.git)?
    const { data: projects, error: projErr } = await supabase
      .from('projects')
      .select('*')
      .ilike('repo_url', `%/${repoFullName}%`);

    if (projErr) return json({ error: `Project lookup failed: ${projErr.message}` }, 500);

    const matched = (projects ?? []).filter((p) => {
      if (p.auto_deploy === false) return false;
      const url = String(p.repo_url || '').toLowerCase();
      const target = `/${repoFullName}`.toLowerCase();
      const trimmed = url.replace(/\.git$/, '').replace(/\/+$/, '');
      if (!trimmed.endsWith(target)) return false;
      const projectBranch = (p.detected_branch || 'main').toLowerCase();
      return projectBranch === branch.toLowerCase();
    });

    if (matched.length === 0) {
      return json({ ok: true, ignored: 'no matching project', repo: repoFullName, branch });
    }

    const dispatched: Array<{ projectId: string; deploymentId: string }> = [];

    for (const project of matched) {
      // Skip if we've already deployed this exact SHA
      if (headSha && project.last_deployed_sha === headSha) {
        continue;
      }

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
      if (depErr || !deployment) continue;

      const pusher = payload?.pusher?.name || payload?.sender?.login || 'unknown';
      const commitMsg = (payload?.head_commit?.message || '').split('\n')[0].slice(0, 120);
      await supabase.from('logs').insert({
        deployment_id: deployment.id,
        level: 'info',
        message: `Auto-deploy: push ${headSha.slice(0, 8)} on ${branch} by ${pusher}${commitMsg ? ` — ${commitMsg}` : ''}`,
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
          body: JSON.stringify({ ref: 'main', inputs: { project_id: project.id, deployment_id: deployment.id } }),
        },
      );

      if (!dispatchRes.ok) {
        const reason = await dispatchRes.text();
        await supabase.from('deployments').update({ status: 'failed', error_message: `Workflow trigger failed: ${reason}` }).eq('id', deployment.id);
        await supabase.from('logs').insert({ deployment_id: deployment.id, level: 'error', message: `Failed to trigger workflow: ${reason}` });
        continue;
      }

      await supabase.from('logs').insert({ deployment_id: deployment.id, level: 'info', message: 'GitHub Actions workflow triggered successfully.' });
      dispatched.push({ projectId: project.id, deploymentId: deployment.id });
    }

    return json({ ok: true, dispatched });
  } catch (err) {
    return json({ error: (err as Error).message }, 500);
  }
});
