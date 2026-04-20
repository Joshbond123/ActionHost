import { ReactNode, useEffect, useMemo, useState } from 'react';
import { Activity, AlertCircle, ExternalLink, Github, Globe, Key, Plus, RefreshCw, Settings, Trash2, CheckCircle, XCircle } from 'lucide-react';
import { motion } from 'motion/react';
import { cn } from '@/src/lib/utils';
import { functionsBaseUrl, functionFetch, hasSupabaseConfig, supabase } from '@/src/lib/supabase';
import { CerebrasKey, Deployment, DomainMapping, LogEntry, Project, ProjectStatus } from './types';

type Tab = 'dashboard' | 'deploy' | 'cerebras' | 'settings';

const STATUS_STYLES: Record<ProjectStatus, string> = {
  queued: 'bg-slate-100 text-slate-700 border-slate-300',
  starting: 'bg-blue-50 text-blue-700 border-blue-200',
  warming: 'bg-amber-50 text-amber-700 border-amber-200',
  ready: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  active: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  draining: 'bg-orange-50 text-orange-700 border-orange-200',
  stopped: 'bg-zinc-100 text-zinc-700 border-zinc-200',
  failed: 'bg-red-50 text-red-700 border-red-200',
};

export default function App() {
  const [tab, setTab] = useState<Tab>('dashboard');
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [domainMappings, setDomainMappings] = useState<DomainMapping[]>([]);
  const [cerebrasKeys, setCerebrasKeys] = useState<CerebrasKey[]>([]);
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [newCerebrasKey, setNewCerebrasKey] = useState('');
  const [addingKey, setAddingKey] = useState(false);
  const [deletingKeyId, setDeletingKeyId] = useState<string | null>(null);
  const [form, setForm] = useState({
    repoUrl: '',
    freeDomainDomain: '',
    freeDomainDnsApiKey: '',
  });

  useEffect(() => {
    if (!supabase) return;
    loadDashboard();
    loadCerebrasKeys();
    const channel = supabase
      .channel('dashboard-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, loadDashboard)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments' }, loadDashboard)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'domain_mappings' }, loadDashboard)
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const loadDashboard = async () => {
    if (!supabase) return;
    const [{ data: projectsData, error: projectsError }, { data: domainData, error: domainError }] = await Promise.all([
      supabase.from('projects').select('*,deployments(*)').order('created_at', { ascending: false }),
      supabase.from('domain_mappings').select('*').order('created_at', { ascending: false }),
    ]);

    if (projectsError || domainError) {
      setError(projectsError?.message || domainError?.message || 'Failed to load dashboard.');
      return;
    }

    const normalized = (projectsData ?? []).map((project: any) => ({
      ...project,
      deployments: (project.deployments ?? []).sort(
        (a: Deployment, b: Deployment) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      ),
    }));

    setProjects(normalized);
    setDomainMappings((domainData ?? []) as DomainMapping[]);
  };

  const loadCerebrasKeys = async () => {
    if (!functionsBaseUrl) return;
    try {
      const response = await functionFetch('/manage-cerebras-keys', { action: 'list' });
      if (response.ok) {
        const payload = await response.json();
        setCerebrasKeys((payload.keys ?? []) as CerebrasKey[]);
      }
    } catch {
      // silently fail if edge function unreachable
    }
  };

  const submitDeploy = async () => {
    setDeploying(true);
    setError('');
    setSuccess('');

    try {
      if (!functionsBaseUrl) throw new Error('VITE_SUPABASE_FUNCTIONS_BASE_URL is missing.');
      const response = await functionFetch('/deploy', form);
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Deployment failed.');

      setSuccess(`Deployment queued: ${payload.deploymentId}`);
      setForm({ repoUrl: '', freeDomainDomain: '', freeDomainDnsApiKey: '' });
      setTab('dashboard');
      await loadDashboard();
    } catch (err: any) {
      setError(err.message ?? 'Deployment failed.');
    } finally {
      setDeploying(false);
    }
  };

  const addCerebrasKey = async () => {
    if (!newCerebrasKey.trim()) {
      setError('API key cannot be empty.');
      return;
    }
    setAddingKey(true);
    setError('');
    setSuccess('');
    try {
      const response = await functionFetch('/manage-cerebras-keys', {
        action: 'add',
        key: newCerebrasKey.trim(),
        label: `Key ${cerebrasKeys.length + 1}`,
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Failed to add key.');
      setSuccess('Cerebras API key added successfully.');
      setNewCerebrasKey('');
      await loadCerebrasKeys();
    } catch (err: any) {
      setError(err.message ?? 'Failed to add key.');
    } finally {
      setAddingKey(false);
    }
  };

  const deleteCerebrasKey = async (id: string) => {
    setDeletingKeyId(id);
    setError('');
    setSuccess('');
    try {
      const response = await functionFetch('/manage-cerebras-keys', { action: 'delete', id });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Failed to delete key.');
      setSuccess('Key removed.');
      await loadCerebrasKeys();
    } catch (err: any) {
      setError(err.message ?? 'Failed to delete key.');
    } finally {
      setDeletingKeyId(null);
    }
  };

  const stats = useMemo(() => {
    const active = projects.filter((p) => p.deployments?.[0]?.status === 'active').length;
    const failed = projects.filter((p) => p.deployments?.[0]?.status === 'failed').length;
    return { total: projects.length, active, failed };
  }, [projects]);

  if (!hasSupabaseConfig) {
    return (
      <main className="min-h-screen bg-bg p-8 flex items-center justify-center">
        <div className="max-w-xl rounded-xl border border-border bg-card-bg p-8 text-center">
          <AlertCircle className="mx-auto w-10 h-10 text-warning" />
          <h1 className="text-2xl font-bold mt-3">Supabase configuration missing</h1>
          <p className="text-sm text-text-muted mt-2">
            Set <code className="font-mono text-xs bg-slate-100 px-1 py-0.5 rounded">VITE_SUPABASE_URL</code> and{' '}
            <code className="font-mono text-xs bg-slate-100 px-1 py-0.5 rounded">VITE_SUPABASE_ANON_KEY</code> in your GitHub repository variables before running ActionHost.
          </p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-bg text-text-main p-6 md:p-10">
      <div className="max-w-7xl mx-auto space-y-8">
        <header className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold tracking-tight">ActionHost</h1>
            <p className="text-sm text-text-muted mt-1">Temporary hosting with GitHub Actions + Quick Tunnel + FreeDomain DNS switching.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(['dashboard', 'deploy', 'cerebras', 'settings'] as Tab[]).map((nextTab) => (
              <button
                key={nextTab}
                onClick={() => {
                  setSelectedProject(null);
                  setError('');
                  setSuccess('');
                  setTab(nextTab);
                }}
                className={cn(
                  'px-4 py-2 text-sm rounded-lg border transition',
                  tab === nextTab ? 'bg-primary text-white border-primary' : 'bg-white border-border hover:bg-slate-50',
                )}
              >
                {nextTab === 'cerebras' ? 'API Keys' : nextTab[0].toUpperCase() + nextTab.slice(1)}
              </button>
            ))}
          </div>
        </header>

        {error && (
          <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 flex items-start gap-2">
            <XCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{error}</span>
          </div>
        )}
        {success && (
          <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700 flex items-start gap-2">
            <CheckCircle className="w-4 h-4 shrink-0 mt-0.5" />
            <span>{success}</span>
          </div>
        )}

        {tab === 'dashboard' && !selectedProject && (
          <section className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <StatCard title="Projects" value={String(stats.total)} />
              <StatCard title="Active deployments" value={String(stats.active)} />
              <StatCard title="Failed deployments" value={String(stats.failed)} />
            </div>

            <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
              <div className="lg:col-span-2 bg-card-bg border border-border rounded-xl p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <h2 className="font-bold text-lg">Projects</h2>
                  <button
                    onClick={loadDashboard}
                    className="text-xs text-text-muted hover:text-text-main flex items-center gap-1"
                  >
                    <RefreshCw className="w-3 h-3" /> Refresh
                  </button>
                </div>
                {projects.length === 0 && (
                  <p className="text-text-muted text-sm">No projects yet. Click <strong>Deploy</strong> to get started.</p>
                )}
                <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                  {projects.map((project) => {
                    const latest = project.deployments?.[0];
                    return (
                      <motion.button
                        whileHover={{ y: -2 }}
                        key={project.id}
                        onClick={() => setSelectedProject(project)}
                        className="text-left border border-border rounded-xl p-4 bg-bg hover:border-primary/30 transition"
                      >
                        <div className="flex justify-between items-start gap-2">
                          <div>
                            <h3 className="font-semibold">{project.name}</h3>
                            <p className="text-xs text-text-muted break-all">{project.repo_url}</p>
                          </div>
                          <StatusBadge status={latest?.status ?? 'queued'} />
                        </div>
                        <div className="mt-3 text-xs text-text-muted space-y-1">
                          <p className="flex items-center gap-2"><Globe className="w-3.5 h-3.5" /> {project.domain}</p>
                          <p className="flex items-center gap-2"><Github className="w-3.5 h-3.5" /> {latest?.detected_framework ?? project.detected_framework ?? 'Detecting...'}</p>
                          <p>Workflow: <b>{latest?.workflow_status ?? 'queued'}</b></p>
                        </div>
                      </motion.button>
                    );
                  })}
                </div>
              </div>

              <div className="bg-card-bg border border-border rounded-xl p-5 space-y-4">
                <h2 className="font-bold text-lg">Domain status</h2>
                <div className="space-y-3 text-sm">
                  {domainMappings.length === 0 && <p className="text-text-muted text-xs">No mapped domains yet.</p>}
                  {domainMappings.slice(0, 8).map((mapping) => (
                    <div key={mapping.id} className="border border-border rounded-lg p-3 bg-bg">
                      <p className="font-semibold text-xs">{mapping.domain}</p>
                      <p className="text-xs text-text-muted">DNS: {mapping.dns_status}</p>
                      <p className="text-xs text-text-muted break-all">Target: {mapping.tunnel_hostname ?? 'pending'}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </section>
        )}

        {tab === 'deploy' && !selectedProject && (
          <section className="max-w-4xl rounded-xl bg-card-bg border border-border p-6 space-y-5">
            <h2 className="text-xl font-bold flex items-center gap-2"><Activity className="w-5 h-5" /> New deployment</h2>
            <p className="text-sm text-text-muted">Enter the GitHub repo you want to deploy. ActionHost will detect the framework, build it, and expose it via a Cloudflare tunnel with your FreeDomain DNS.</p>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="GitHub repository URL"
                value={form.repoUrl}
                onChange={(value) => setForm((prev) => ({ ...prev, repoUrl: value }))}
                placeholder="https://github.com/owner/repo"
              />
              <Input
                label="FreeDomain domain"
                value={form.freeDomainDomain}
                onChange={(value) => setForm((prev) => ({ ...prev, freeDomainDomain: value }))}
                placeholder="yourdomain.example.com"
              />
              <Input
                label="FreeDomain DNS API key"
                type="password"
                value={form.freeDomainDnsApiKey}
                onChange={(value) => setForm((prev) => ({ ...prev, freeDomainDnsApiKey: value }))}
                placeholder="Your FreeDomain API key"
              />
            </div>
            <button
              onClick={submitDeploy}
              disabled={deploying || !form.repoUrl || !form.freeDomainDomain || !form.freeDomainDnsApiKey}
              className="bg-primary text-white px-5 py-2 rounded-lg text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50 transition"
            >
              {deploying ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />}
              {deploying ? 'Queuing deployment...' : 'Deploy'}
            </button>
          </section>
        )}

        {tab === 'cerebras' && !selectedProject && (
          <section className="max-w-4xl space-y-6">
            <div className="rounded-xl bg-card-bg border border-border p-6 space-y-5">
              <h2 className="text-xl font-bold flex items-center gap-2"><Key className="w-5 h-5" /> Cerebras API Keys</h2>
              <p className="text-sm text-text-muted">
                Add multiple Cerebras API keys. The system automatically rotates through them per request, tracking usage and falling back to another key if one fails. Keys are stored securely — only masked labels are shown here.
              </p>
              <div className="flex gap-3">
                <input
                  type="password"
                  value={newCerebrasKey}
                  onChange={(e) => setNewCerebrasKey(e.target.value)}
                  placeholder="csk-... paste your Cerebras API key"
                  className="flex-1 rounded-lg border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary font-mono"
                  onKeyDown={(e) => e.key === 'Enter' && addCerebrasKey()}
                />
                <button
                  onClick={addCerebrasKey}
                  disabled={addingKey || !newCerebrasKey.trim()}
                  className="bg-primary text-white px-4 py-2 rounded-lg text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50 transition whitespace-nowrap"
                >
                  {addingKey ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                  Add Key
                </button>
              </div>
            </div>

            <div className="rounded-xl bg-card-bg border border-border p-6 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="font-bold">Stored keys ({cerebrasKeys.length})</h3>
                <button onClick={loadCerebrasKeys} className="text-xs text-text-muted hover:text-text-main flex items-center gap-1">
                  <RefreshCw className="w-3 h-3" /> Refresh
                </button>
              </div>

              {cerebrasKeys.length === 0 && (
                <p className="text-sm text-text-muted">No API keys stored yet. Add one above.</p>
              )}

              <div className="space-y-3">
                {cerebrasKeys.map((ck, idx) => (
                  <div key={ck.id} className="border border-border rounded-lg p-4 bg-bg flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-semibold">{ck.label || `Key ${idx + 1}`}</span>
                        <span className={cn('px-2 py-0.5 rounded-full text-[10px] font-bold border uppercase', ck.is_active ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-zinc-100 text-zinc-500 border-zinc-300')}>
                          {ck.is_active ? 'active' : 'inactive'}
                        </span>
                      </div>
                      <div className="flex flex-wrap gap-3 mt-2 text-xs text-text-muted">
                        <span>Requests: <strong>{ck.usage_count}</strong></span>
                        <span>Success: <strong className="text-emerald-600">{ck.success_count}</strong></span>
                        <span>Failed: <strong className="text-red-500">{ck.fail_count}</strong></span>
                        {ck.last_used_at && (
                          <span>Last used: <strong>{new Date(ck.last_used_at).toLocaleString()}</strong></span>
                        )}
                      </div>
                    </div>
                    <button
                      onClick={() => deleteCerebrasKey(ck.id)}
                      disabled={deletingKeyId === ck.id}
                      className="text-red-400 hover:text-red-600 transition disabled:opacity-50 shrink-0"
                      title="Delete key"
                    >
                      {deletingKeyId === ck.id ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {tab === 'settings' && !selectedProject && (
          <section className="max-w-2xl rounded-xl bg-card-bg border border-border p-6 space-y-4">
            <h2 className="text-xl font-bold flex items-center gap-2"><Settings className="w-5 h-5" /> Settings</h2>
            <p className="text-sm text-text-muted">
              System configuration. Cerebras API key management has moved to the <strong>API Keys</strong> tab.
            </p>
            <div className="rounded-lg border border-border p-4 bg-bg space-y-2">
              <p className="text-xs font-bold uppercase text-text-muted">Connection Status</p>
              <div className="flex items-center gap-2 text-sm">
                <CheckCircle className="w-4 h-4 text-emerald-500" />
                <span>Supabase connected</span>
              </div>
              <p className="text-xs text-text-muted break-all">URL: {import.meta.env.VITE_SUPABASE_URL}</p>
            </div>
          </section>
        )}

        {selectedProject && (
          <ProjectDetails projectId={selectedProject.id} onBack={() => setSelectedProject(null)} />
        )}
      </div>
    </main>
  );
}

function ProjectDetails({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const [project, setProject] = useState<Project | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [redeploying, setRedeploying] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    if (!supabase) return;
    const load = async () => {
      const { data: projectData } = await supabase.from('projects').select('*').eq('id', projectId).single();
      const { data: deploymentData } = await supabase.from('deployments').select('*').eq('project_id', projectId).order('created_at', { ascending: false });
      setProject(projectData as Project);
      setDeployments((deploymentData ?? []) as Deployment[]);

      if (deploymentData?.length) {
        const { data: logData } = await supabase.from('logs').select('*').eq('deployment_id', deploymentData[0].id).order('created_at', { ascending: true });
        setLogs((logData ?? []) as LogEntry[]);
      }
    };

    load();
    const channel = supabase
      .channel(`project-${projectId}-live`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments', filter: `project_id=eq.${projectId}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'logs' }, load)
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [projectId]);

  const redeploy = async () => {
    if (!project) return;
    setRedeploying(true);
    setMsg('');
    try {
      const response = await functionFetch('/deploy', {
        repoUrl: project.repo_url,
        freeDomainDomain: project.domain,
        freeDomainDnsApiKey: '',
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Re-deploy failed.');
      setMsg(`Re-deployment queued: ${payload.deploymentId}`);
    } catch (err: any) {
      setMsg(err.message);
    } finally {
      setRedeploying(false);
    }
  };

  const current = deployments[0];

  return (
    <section className="space-y-4">
      <button onClick={onBack} className="text-sm text-text-muted hover:text-text-main">← Back to dashboard</button>

      {msg && <p className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700">{msg}</p>}

      <div className="rounded-xl bg-card-bg border border-border p-6 space-y-4">
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 className="text-2xl font-bold">{project?.name}</h2>
            <p className="text-xs text-text-muted break-all mt-1">{project?.repo_url}</p>
          </div>
          <button
            onClick={redeploy}
            disabled={redeploying}
            className="bg-primary text-white px-4 py-2 rounded-lg text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50 shrink-0"
          >
            {redeploying ? <RefreshCw className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
            Re-deploy
          </button>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 text-sm">
          <InfoCard label="Deployment status" value={current ? <StatusBadge status={current.status} /> : 'N/A'} />
          <InfoCard label="Workflow status" value={current?.workflow_status ?? 'queued'} />
          <InfoCard label="Current active domain" value={current?.domain ?? project?.domain ?? 'N/A'} />
          <InfoCard
            label="Current live URL"
            value={
              current?.public_url
                ? <a className="inline-flex items-center gap-1 text-primary" href={current.public_url} target="_blank" rel="noreferrer">Open <ExternalLink className="w-3 h-3" /></a>
                : 'Pending'
            }
          />
          <InfoCard label="Framework" value={current?.detected_framework ?? project?.detected_framework ?? 'Detecting'} />
          <InfoCard label="Branch" value={current?.detected_branch ?? project?.detected_branch ?? 'Detecting'} />
          <InfoCard label="Build command" value={current?.detected_build_command ?? project?.detected_build_command ?? 'Detecting'} />
          <InfoCard label="Start command" value={current?.detected_start_command ?? project?.detected_start_command ?? 'Detecting'} />
          {current?.expires_at && (
            <InfoCard label="Expires at" value={new Date(current.expires_at).toLocaleString()} />
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="rounded-xl bg-card-bg border border-border p-5">
          <h3 className="font-bold">Deployment history</h3>
          <div className="mt-3 space-y-2 text-sm">
            {deployments.length === 0 && <p className="text-text-muted text-xs">No deployments yet.</p>}
            {deployments.map((dep) => (
              <div key={dep.id} className="border border-border rounded-lg p-3 bg-bg">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs">{dep.id.slice(0, 8)}</span>
                  <StatusBadge status={dep.status} />
                </div>
                <p className="text-xs text-text-muted mt-1">{new Date(dep.created_at).toLocaleString()}</p>
                <p className="text-xs text-text-muted mt-1">Health: {dep.health_status}</p>
                {dep.error_message && <p className="text-xs text-red-600 mt-1">{dep.error_message}</p>}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl bg-sidebar-bg p-5 h-[28rem] overflow-y-auto">
          <h3 className="text-xs text-white uppercase font-bold tracking-wider">Logs</h3>
          <div className="mt-4 space-y-2 text-xs text-slate-300 font-mono">
            {logs.length === 0 && <p>No logs yet.</p>}
            {logs.map((entry) => (
              <p key={entry.id} className={cn('leading-relaxed', entry.level === 'error' && 'text-red-400', entry.level === 'warn' && 'text-yellow-400')}>
                <span className="text-slate-500 mr-2">[{new Date(entry.created_at).toLocaleTimeString()}]</span>
                {entry.message}
              </p>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function Input({ label, value, onChange, placeholder, type = 'text' }: { label: string; value: string; onChange: (value: string) => void; placeholder?: string; type?: string }) {
  return (
    <label className="space-y-1 block">
      <span className="text-xs uppercase font-bold text-text-muted">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition"
      />
    </label>
  );
}

function InfoCard({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="p-3 border border-border rounded-lg">
      <p className="text-[10px] font-bold uppercase text-text-muted">{label}</p>
      <div className="text-sm mt-1 break-all">{value}</div>
    </div>
  );
}

function StatusBadge({ status }: { status: ProjectStatus }) {
  return <span className={cn('px-2 py-1 rounded-full border text-[10px] uppercase font-bold', STATUS_STYLES[status])}>{status}</span>;
}

function StatCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-xl border border-border bg-card-bg p-4">
      <p className="text-xs uppercase font-bold text-text-muted">{title}</p>
      <p className="text-2xl font-bold mt-2">{value}</p>
    </div>
  );
}
