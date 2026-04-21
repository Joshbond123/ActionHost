import { ReactNode, useEffect, useMemo, useState } from 'react';
import { Activity, AlertCircle, ExternalLink, Github, RefreshCw, Settings } from 'lucide-react';
import { motion } from 'motion/react';
import { cn } from '@/src/lib/utils';
import { functionsBaseUrl, hasSupabaseConfig, supabase } from '@/src/lib/supabase';
import { Deployment, LogEntry, Project, ProjectStatus } from './types';

type Tab = 'dashboard' | 'deploy' | 'settings';

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
  const [deploying, setDeploying] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [cerebrasKey, setCerebrasKey] = useState('');
  const [form, setForm] = useState({
    repoUrl: 'https://github.com/Joshbond123/Blog-Automator',
    ngrokAuthtoken: '',
    ngrokDomain: 'unapprehended-overemotionally-jeni.ngrok-free.dev',
  });

  useEffect(() => {
    if (!supabase) return;
    refresh();
    const channel = supabase
      .channel('dashboard-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, refresh)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments' }, refresh)
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const refresh = async () => {
    if (!supabase) return;
    const { data, error: queryError } = await supabase
      .from('projects')
      .select('*,deployments(*)')
      .order('created_at', { ascending: false });

    if (queryError) {
      setError(queryError.message);
      return;
    }

    const normalized = (data ?? []).map((project: any) => ({
      ...project,
      deployments: (project.deployments ?? []).sort(
        (a: Deployment, b: Deployment) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime(),
      ),
    }));

    setProjects(normalized);
  };

  const submitDeployment = async () => {
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
      if (!response.ok) throw new Error(payload.error ?? 'Deploy failed.');

      setSuccess(`Deployment queued: ${payload.deploymentId}`);
      await refresh();
      setTab('dashboard');
    } catch (err: any) {
      setError(err.message ?? 'Deploy failed.');
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
      if (!response.ok) throw new Error(payload.error ?? 'Settings save failed.');
      setSuccess('Settings saved securely.');
      setCerebrasKey('');
    } catch (err: any) {
      setError(err.message ?? 'Settings save failed.');
    }
  };

  const stats = useMemo(() => {
    const active = projects.filter((project) => project.deployments?.[0]?.status === 'active').length;
    const auto = projects.filter((project) => project.auto_deploy_enabled).length;
    return { total: projects.length, active, auto };
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
            <p className="text-sm text-text-muted mt-1">GitHub Actions deployments exposed through ngrok with automatic redeploy on new commits.</p>
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

        {tab === 'dashboard' && !selectedProject && (
          <section className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <StatCard title="Projects" value={String(stats.total)} />
              <StatCard title="Active deployments" value={String(stats.active)} />
              <StatCard title="Auto-deploy enabled" value={String(stats.auto)} />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
              {projects.map((project) => {
                const latest = project.deployments?.[0];
                return (
                  <motion.button
                    whileHover={{ y: -2 }}
                    key={project.id}
                    onClick={() => setSelectedProject(project)}
                    className="text-left rounded-xl border border-border p-4 bg-card-bg"
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div>
                        <h3 className="font-semibold">{project.name}</h3>
                        <p className="text-xs text-text-muted break-all">{project.repo_url}</p>
                      </div>
                      <StatusBadge status={latest?.status ?? 'queued'} />
                    </div>
                    <div className="mt-3 text-xs text-text-muted space-y-1">
                      <p className="flex items-center gap-2"><Github className="w-3.5 h-3.5" /> {latest?.commit_sha?.slice(0, 7) ?? project.latest_deployed_commit_sha?.slice(0, 7) ?? 'pending'}</p>
                      <p>Workflow: <b>{latest?.workflow_status ?? 'queued'}</b></p>
                      <p>ngrok: <b>{project.ngrok_domain}</b></p>
                      <p>Auto deploy: <b>{project.auto_deploy_enabled ? 'enabled' : 'disabled'}</b></p>
                    </div>
                  </motion.button>
                );
              })}
            </div>
          </section>
        )}

        {tab === 'deploy' && !selectedProject && (
          <section className="max-w-4xl rounded-xl bg-card-bg border border-border p-6 space-y-5">
            <h2 className="text-xl font-bold flex items-center gap-2"><Activity className="w-5 h-5" /> Deploy with ngrok</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input label="GitHub repository URL" value={form.repoUrl} onChange={(value) => setForm((prev) => ({ ...prev, repoUrl: value }))} placeholder="https://github.com/owner/repo" />
              <Input label="ngrok authtoken" type="password" value={form.ngrokAuthtoken} onChange={(value) => setForm((prev) => ({ ...prev, ngrokAuthtoken: value }))} />
              <Input label="ngrok domain" value={form.ngrokDomain} onChange={(value) => setForm((prev) => ({ ...prev, ngrokDomain: value }))} placeholder="your-reserved.ngrok-free.dev" />
            </div>
            <button onClick={submitDeployment} disabled={deploying} className="bg-primary text-white px-5 py-2 rounded-lg text-sm font-semibold inline-flex items-center gap-2 disabled:opacity-50">
              {deploying ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />} Deploy
            </button>
          </section>
        )}

        {tab === 'settings' && !selectedProject && (
          <section className="max-w-2xl rounded-xl bg-card-bg border border-border p-6 space-y-4">
            <h2 className="text-xl font-bold flex items-center gap-2"><Settings className="w-5 h-5" /> Settings</h2>
            <Input label="Optional Cerebras API key (backend-only)" value={cerebrasKey} type="password" onChange={setCerebrasKey} />
            <button onClick={saveSettings} className="bg-primary text-white px-5 py-2 rounded-lg text-sm font-semibold">Save</button>
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
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects', filter: `id=eq.${projectId}` }, load)
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [projectId]);

  const current = deployments[0];

  return (
    <section className="space-y-4">
      <button onClick={onBack} className="text-sm text-text-muted">← Back to dashboard</button>

      <div className="rounded-xl bg-card-bg border border-border p-6 space-y-4">
        <h2 className="text-2xl font-bold">{project?.name}</h2>
        <p className="text-xs text-text-muted break-all">{project?.repo_url}</p>

        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3 text-sm">
          <InfoCard label="Deployment status" value={current ? <StatusBadge status={current.status} /> : 'N/A'} />
          <InfoCard label="Workflow status" value={current?.workflow_status ?? 'queued'} />
          <InfoCard label="Active live URL" value={current?.public_url ? <a className="inline-flex items-center gap-1 text-primary" href={current.public_url} target="_blank" rel="noreferrer">Open <ExternalLink className="w-3 h-3" /></a> : 'Pending'} />
          <InfoCard label="ngrok domain" value={current?.ngrok_domain ?? project?.ngrok_domain ?? 'N/A'} />
          <InfoCard label="Latest commit deployed" value={project?.latest_deployed_commit_sha?.slice(0, 7) ?? 'pending'} />
          <InfoCard label="Auto-deploy status" value={project?.auto_deploy_enabled ? 'enabled' : 'disabled'} />
          <InfoCard label="Detected framework" value={current?.detected_framework ?? project?.detected_framework ?? 'Detecting'} />
          <InfoCard label="Detected branch" value={current?.branch ?? project?.detected_branch ?? 'Detecting'} />
          <InfoCard label="Detected build command" value={current?.detected_build_command ?? project?.detected_build_command ?? 'Detecting'} />
          <InfoCard label="Detected start command" value={current?.detected_start_command ?? project?.detected_start_command ?? 'Detecting'} />
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
        <div className="rounded-xl bg-card-bg border border-border p-5">
          <h3 className="font-bold">Deployment history</h3>
          <div className="mt-3 space-y-2 text-sm">
            {deployments.length === 0 && <p className="text-text-muted text-xs">No deployments yet.</p>}
            {deployments.map((deployment) => (
              <div key={deployment.id} className="border border-border rounded-lg p-3 bg-bg">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs">{deployment.id.slice(0, 8)}</span>
                  <StatusBadge status={deployment.status} />
                </div>
                <p className="text-xs text-text-muted mt-1">Commit: {deployment.commit_sha?.slice(0, 7) ?? 'n/a'}</p>
                <p className="text-xs text-text-muted mt-1">Created: {new Date(deployment.created_at).toLocaleString()}</p>
                <p className="text-xs text-text-muted mt-1">Health: {deployment.health_status}</p>
                {deployment.error_message && <p className="text-xs text-red-600 mt-1">{deployment.error_message}</p>}
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-xl bg-sidebar-bg p-5 h-[28rem] overflow-y-auto">
          <h3 className="text-xs text-white uppercase font-bold tracking-wider">Logs</h3>
          <div className="mt-4 space-y-2 text-xs text-slate-300 font-mono">
            {logs.length === 0 && <p>No logs yet.</p>}
            {logs.map((entry) => (
              <p key={entry.id}><span className="text-slate-500 mr-2">[{new Date(entry.created_at).toLocaleTimeString()}]</span>{entry.message}</p>
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
      <input type={type} value={value} onChange={(event) => onChange(event.target.value)} placeholder={placeholder} className="w-full rounded-lg border border-border px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary" />
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
