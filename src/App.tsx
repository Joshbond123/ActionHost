import { ReactNode, useEffect, useMemo, useState } from 'react';
import { Activity, AlertCircle, ExternalLink, Github, Globe, RefreshCw, Settings } from 'lucide-react';
import { motion } from 'motion/react';
import { cn } from '@/src/lib/utils';
import { functionsBaseUrl, hasSupabaseConfig, supabase } from '@/src/lib/supabase';
import { Deployment, LogEntry, Project, ProjectStatus } from './types';

type Tab = 'dashboard' | 'deploy' | 'settings';

type DeployPayload = {
  repoUrl: string;
  cloudflareApiToken: string;
  cloudflareZoneId: string;
  domain: string;
  subdomain?: string;
};

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
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [cerebrasKey, setCerebrasKey] = useState('');
  const [form, setForm] = useState<DeployPayload>({
    repoUrl: '',
    cloudflareApiToken: '',
    cloudflareZoneId: '',
    domain: '',
    subdomain: '',
  });

  useEffect(() => {
    if (!supabase) return;
    loadProjects();
    const channel = supabase
      .channel('projects-dashboard-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, loadProjects)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments' }, loadProjects)
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const loadProjects = async () => {
    if (!supabase) return;
    const { data, error: dbError } = await supabase
      .from('projects')
      .select('*,deployments(*)')
      .order('created_at', { ascending: false });

    if (dbError) {
      setError(dbError.message);
      return;
    }

    const normalized: Project[] = (data ?? []).map((item: any) => ({
      ...item,
      deployments: (item.deployments ?? []).sort(
        (a: Deployment, b: Deployment) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      ),
    }));

    setProjects(normalized);
  };

  const handleDeploy = async () => {
    setDeploying(true);
    setError('');
    setSuccess('');

    try {
      if (!functionsBaseUrl) throw new Error('VITE_SUPABASE_FUNCTIONS_BASE_URL is missing.');
      const response = await fetch(`${functionsBaseUrl}/deploy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });

      const payload = await response.json();
      if (!response.ok) {
        throw new Error(payload.error ?? 'Deployment request failed.');
      }

      setForm({ repoUrl: '', cloudflareApiToken: '', cloudflareZoneId: '', domain: '', subdomain: '' });
      setSuccess(`Deployment queued: ${payload.deploymentId}`);
      setTab('dashboard');
      await loadProjects();
    } catch (err: any) {
      setError(err.message ?? 'Deployment failed.');
    } finally {
      setDeploying(false);
    }
  };

  const saveSettings = async () => {
    setError('');
    setSuccess('');

    try {
      if (!functionsBaseUrl) throw new Error('VITE_SUPABASE_FUNCTIONS_BASE_URL is missing.');
      const response = await fetch(`${functionsBaseUrl}/save-settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cerebrasApiKey: cerebrasKey }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? 'Settings save failed');
      setSuccess('Settings saved securely.');
      setCerebrasKey('');
    } catch (err: any) {
      setError(err.message ?? 'Settings save failed.');
    }
  };

  const stats = useMemo(() => {
    const active = projects.filter((p) => p.deployments?.[0]?.status === 'active').length;
    const queued = projects.filter((p) => p.deployments?.[0]?.status === 'queued').length;
    return { total: projects.length, active, queued };
  }, [projects]);

  if (!hasSupabaseConfig) {
    return (
      <main className="min-h-screen bg-bg p-8 flex items-center justify-center">
        <div className="max-w-xl rounded-xl border border-border bg-card-bg p-8 text-center">
          <AlertCircle className="mx-auto w-10 h-10 text-warning" />
          <h1 className="text-2xl font-bold mt-3">Supabase configuration missing</h1>
          <p className="text-sm text-text-muted mt-2">Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before running ActionHost.</p>
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
            <p className="text-sm text-text-muted mt-1">Zero-downtime temporary hosting on GitHub Actions with Supabase + Cloudflare orchestration.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {(['dashboard', 'deploy', 'settings'] as Tab[]).map((nextTab) => (
              <button
                key={nextTab}
                onClick={() => {
                  setSelectedProject(null);
                  setTab(nextTab);
                }}
                className={cn('px-4 py-2 text-sm rounded-lg border transition', tab === nextTab ? 'bg-primary text-white border-primary' : 'bg-white border-border')}
              >
                {nextTab[0].toUpperCase() + nextTab.slice(1)}
              </button>
            ))}
          </div>
        </header>

        {error && <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        {success && <p className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-700">{success}</p>}

        {!selectedProject && tab === 'dashboard' && (
          <section className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <StatCard title="Projects" value={String(stats.total)} />
              <StatCard title="Active" value={String(stats.active)} />
              <StatCard title="Queued" value={String(stats.queued)} />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {projects.map((project) => (
                <motion.button
                  whileHover={{ y: -2 }}
                  key={project.id}
                  onClick={() => setSelectedProject(project)}
                  className="bg-card-bg rounded-xl border border-border p-5 text-left"
                >
                  <div className="flex justify-between items-start gap-3">
                    <div>
                      <h3 className="font-semibold text-lg">{project.name}</h3>
                      <p className="text-xs text-text-muted break-all">{project.repo_url}</p>
                    </div>
                    <StatusBadge status={project.deployments?.[0]?.status ?? 'queued'} />
                  </div>

                  <div className="mt-4 text-xs text-text-muted space-y-1">
                    <p className="flex items-center gap-2"><Globe className="w-3.5 h-3.5" /> {project.subdomain ? `${project.subdomain}.` : ''}{project.domain}</p>
                    <p className="flex items-center gap-2"><Github className="w-3.5 h-3.5" /> {project.framework ?? 'Auto-detected'}</p>
                  </div>
                </motion.button>
              ))}
            </div>
          </section>
        )}

        {tab === 'deploy' && !selectedProject && (
          <section className="max-w-4xl rounded-xl bg-card-bg border border-border p-6 space-y-5">
            <h2 className="text-xl font-bold flex items-center gap-2"><Activity className="w-5 h-5" /> New deployment</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input label="GitHub repository URL" value={form.repoUrl} onChange={(value) => setForm((prev) => ({ ...prev, repoUrl: value }))} placeholder="https://github.com/owner/repo" />
              <Input label="Cloudflare API token" type="password" value={form.cloudflareApiToken} onChange={(value) => setForm((prev) => ({ ...prev, cloudflareApiToken: value }))} />
              <Input label="Cloudflare Zone ID" value={form.cloudflareZoneId} onChange={(value) => setForm((prev) => ({ ...prev, cloudflareZoneId: value }))} />
              <Input label="Custom domain" value={form.domain} onChange={(value) => setForm((prev) => ({ ...prev, domain: value }))} placeholder="example.com" />
              <Input label="Subdomain (optional)" value={form.subdomain ?? ''} onChange={(value) => setForm((prev) => ({ ...prev, subdomain: value }))} placeholder="app" />
            </div>
            <button onClick={handleDeploy} disabled={deploying} className="bg-primary text-white px-5 py-2 rounded-lg text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50">
              {deploying ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />} Deploy now
            </button>
          </section>
        )}

        {tab === 'settings' && !selectedProject && (
          <section className="max-w-2xl rounded-xl bg-card-bg border border-border p-6 space-y-4">
            <h2 className="text-xl font-bold flex items-center gap-2"><Settings className="w-5 h-5" /> Settings</h2>
            <Input label="Optional Cerebras API key (stored backend-only)" value={cerebrasKey} type="password" onChange={setCerebrasKey} />
            <button onClick={saveSettings} className="bg-primary text-white px-5 py-2 rounded-lg text-sm font-semibold">Save settings</button>
          </section>
        )}

        {selectedProject && <ProjectDetails projectId={selectedProject.id} onBack={() => setSelectedProject(null)} />}
      </div>
    </main>
  );
}

function ProjectDetails({ projectId, onBack }: { projectId: string; onBack: () => void }) {
  const [project, setProject] = useState<Project | null>(null);
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [logs, setLogs] = useState<LogEntry[]>([]);

  useEffect(() => {
    if (!supabase) return;

    const load = async () => {
      const { data: projectRow } = await supabase.from('projects').select('*').eq('id', projectId).single();
      const { data: depRows } = await supabase.from('deployments').select('*').eq('project_id', projectId).order('created_at', { ascending: false });
      setProject(projectRow as Project);
      setDeployments((depRows ?? []) as Deployment[]);

      if (depRows?.length) {
        const { data: logsRows } = await supabase.from('logs').select('*').eq('deployment_id', depRows[0].id).order('created_at', { ascending: true });
        setLogs((logsRows ?? []) as LogEntry[]);
      }
    };

    load();
    const channel = supabase
      .channel(`project-live-${projectId}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments', filter: `project_id=eq.${projectId}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'logs' }, load)
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId]);

  const latest = deployments[0];

  return (
    <section className="space-y-4">
      <button onClick={onBack} className="text-sm text-text-muted">← Back to dashboard</button>

      <div className="rounded-xl bg-card-bg border border-border p-6 space-y-4">
        <h2 className="text-2xl font-bold">{project?.name ?? 'Project'}</h2>
        <p className="text-xs text-text-muted break-all">{project?.repo_url}</p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
          <InfoCard label="Status" value={latest ? <StatusBadge status={latest.status} /> : 'No deployments'} />
          <InfoCard label="Created" value={latest ? new Date(latest.created_at).toLocaleString() : '—'} />
          <InfoCard
            label="Live URL"
            value={
              latest?.public_url ? (
                <a href={latest.public_url} target="_blank" rel="noreferrer" className="text-primary inline-flex items-center gap-1">
                  Open <ExternalLink className="w-3 h-3" />
                </a>
              ) : (
                'Pending'
              )
            }
          />
        </div>
      </div>

      <div className="rounded-xl bg-sidebar-bg p-5 h-72 overflow-y-auto">
        <h3 className="text-xs text-white uppercase font-bold tracking-wider">Deployment logs</h3>
        <div className="mt-4 space-y-2 text-xs text-slate-300 font-mono">
          {logs.length === 0 && <p>No logs yet.</p>}
          {logs.map((entry) => (
            <p key={entry.id}>
              <span className="text-slate-500 mr-2">[{new Date(entry.created_at).toLocaleTimeString()}]</span>
              {entry.message}
            </p>
          ))}
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
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary"
      />
    </label>
  );
}

function InfoCard({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="p-3 border border-border rounded-lg">
      <p className="text-[10px] font-bold uppercase text-text-muted">{label}</p>
      <div className="text-sm mt-1">{value}</div>
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
