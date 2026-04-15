import { ReactNode, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Github,
  Globe,
  Plus,
  RefreshCw,
  Settings as SettingsIcon,
  Terminal,
} from 'lucide-react';
import { motion } from 'motion/react';
import { cn } from '@/src/lib/utils';
import { functionsBaseUrl, hasSupabaseConfig, supabase } from '@/src/lib/supabase';
import { Deployment, Log, Project, ProjectStatus } from './types';

type Tab = 'dashboard' | 'new' | 'settings';

type Analysis = {
  framework: string;
  build_command: string;
  start_command: string;
  branch: string;
};

const statusClass: Record<ProjectStatus, string> = {
  active: 'bg-[#DCFCE7] text-[#166534] border-[#BBF7D0]',
  starting: 'bg-blue-50 text-blue-700 border-blue-100',
  failed: 'bg-red-50 text-red-700 border-red-100',
  queued: 'bg-slate-50 text-slate-700 border-slate-100',
  warming: 'bg-[#FEF3C7] text-[#92400E] border-[#FDE68A]',
  ready: 'bg-indigo-50 text-indigo-700 border-indigo-100',
  draining: 'bg-orange-50 text-orange-700 border-orange-100',
  stopped: 'bg-slate-50 text-slate-700 border-slate-100',
};

const defaultAnalysis = (repoUrl: string): Analysis => {
  const repo = repoUrl.toLowerCase();
  if (repo.includes('next')) return { framework: 'Next.js', build_command: 'npm run build', start_command: 'npm run start', branch: 'main' };
  if (repo.includes('vite') || repo.includes('react')) return { framework: 'Vite/React', build_command: 'npm run build', start_command: 'npm run preview', branch: 'main' };
  return { framework: 'Node.js', build_command: 'npm run build', start_command: 'npm start', branch: 'main' };
};

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('dashboard');
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [repoUrl, setRepoUrl] = useState('');
  const [domain, setDomain] = useState('');
  const [subdomain, setSubdomain] = useState('');
  const [zoneId, setZoneId] = useState('');
  const [analysis, setAnalysis] = useState<Analysis | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [settingsRepoPath, setSettingsRepoPath] = useState(localStorage.getItem('actionhost.githubRepoPath') ?? '');

  useEffect(() => {
    if (!supabase) return;
    fetchProjects();
    const channel = supabase
      .channel('projects-live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, fetchProjects)
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const fetchProjects = async () => {
    if (!supabase) return;
    const { data, error: queryError } = await supabase.from('projects').select('*').order('created_at', { ascending: false });
    if (queryError) {
      setError(queryError.message);
      return;
    }
    setProjects(data ?? []);
  };

  const runAnalyze = async () => {
    if (!repoUrl.trim()) return;
    setSaving(true);
    setError('');
    try {
      if (functionsBaseUrl) {
        const response = await fetch(`${functionsBaseUrl}/analyze-repo`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ repoUrl }),
        });
        if (!response.ok) throw new Error(`Analyze failed: ${response.status}`);
        const payload = await response.json();
        setAnalysis(payload);
      } else {
        setAnalysis(defaultAnalysis(repoUrl));
      }
    } catch (e: any) {
      setError(e.message ?? 'Unable to analyze repository.');
    } finally {
      setSaving(false);
    }
  };

  const createDeployment = async () => {
    if (!supabase) return;
    if (!repoUrl || !domain) {
      setError('Repository URL and domain are required.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const { data: project, error: projectError } = await supabase
        .from('projects')
        .insert({
          name: repoUrl.split('/').pop()?.replace('.git', '') || 'New Project',
          repo_url: repoUrl,
          domain,
          subdomain: subdomain || null,
          cloudflare_zone_id: zoneId || null,
          framework: analysis?.framework ?? null,
          build_command: analysis?.build_command ?? null,
          start_command: analysis?.start_command ?? null,
        })
        .select()
        .single();

      if (projectError) throw projectError;

      const { data: deployment, error: deploymentError } = await supabase
        .from('deployments')
        .insert({ project_id: project.id, status: 'queued' })
        .select()
        .single();

      if (deploymentError) throw deploymentError;

      if (functionsBaseUrl) {
        await fetch(`${functionsBaseUrl}/queue-deployment`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ projectId: project.id, deploymentId: deployment.id }),
        });
      }

      setRepoUrl('');
      setDomain('');
      setSubdomain('');
      setZoneId('');
      setAnalysis(null);
      setActiveTab('dashboard');
    } catch (e: any) {
      setError(e.message ?? 'Failed to create deployment.');
    } finally {
      setSaving(false);
    }
  };

  const totals = useMemo(() => ({ projects: projects.length }), [projects]);

  if (!hasSupabaseConfig) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-bg p-8">
        <div className="max-w-lg rounded-lg border border-border bg-card-bg p-8 text-center space-y-3">
          <AlertCircle className="w-10 h-10 text-warning mx-auto" />
          <h1 className="text-xl font-bold">Supabase is not configured</h1>
          <p className="text-text-muted text-sm">Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY in repository secrets for GitHub Pages builds.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-bg text-text-main">
      <main className="max-w-6xl mx-auto p-6 md:p-10 space-y-8">
        <header className="flex flex-col md:flex-row md:items-center md:justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">ActionHost</h1>
            <p className="text-text-muted text-sm">GitHub Actions deployment control plane backed by Supabase.</p>
          </div>
          <div className="flex gap-2">
            {(['dashboard', 'new', 'settings'] as Tab[]).map((tab) => (
              <button key={tab} onClick={() => { setActiveTab(tab); if (tab !== 'dashboard') setSelectedProject(null); }} className={cn('px-4 py-2 rounded-md text-sm font-semibold border', activeTab === tab ? 'bg-primary text-white border-primary' : 'border-border bg-white')}>
                {tab === 'new' ? 'New Deployment' : tab[0].toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>
        </header>

        {!!error && <div className="p-3 rounded-md bg-red-50 border border-red-200 text-red-700 text-sm">{error}</div>}

        {activeTab === 'dashboard' && !selectedProject && (
          <section className="space-y-5">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <StatCard label="Projects" value={String(totals.projects)} icon={<Github className="w-4 h-4" />} />
              <StatCard label="Supabase" value="Connected" icon={<CheckCircle2 className="w-4 h-4" />} />
              <StatCard label="Hosting" value="GitHub Pages" icon={<Globe className="w-4 h-4" />} />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {projects.map((project) => (
                <motion.button whileHover={{ y: -2 }} key={project.id} onClick={() => setSelectedProject(project)} className="text-left bg-card-bg border border-border p-5 rounded-lg hover:shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <h3 className="font-bold">{project.name}</h3>
                      <p className="text-xs text-text-muted truncate">{project.repo_url}</p>
                    </div>
                    <span className="px-2 py-1 border rounded-full text-[10px] uppercase font-bold">Project</span>
                  </div>
                </motion.button>
              ))}
            </div>
          </section>
        )}

        {activeTab === 'new' && (
          <section className="bg-card-bg border border-border rounded-lg p-6 space-y-4 max-w-3xl">
            <h2 className="text-lg font-bold">Create deployment</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Field label="Repository URL"><input value={repoUrl} onChange={(e) => setRepoUrl(e.target.value)} placeholder="https://github.com/org/repo" className="input" /></Field>
              <Field label="Domain"><input value={domain} onChange={(e) => setDomain(e.target.value)} placeholder="example.com" className="input" /></Field>
              <Field label="Subdomain"><input value={subdomain} onChange={(e) => setSubdomain(e.target.value)} placeholder="app" className="input" /></Field>
              <Field label="Cloudflare Zone ID"><input value={zoneId} onChange={(e) => setZoneId(e.target.value)} placeholder="zone-id" className="input" /></Field>
            </div>
            <div className="flex gap-3">
              <button onClick={runAnalyze} disabled={saving || !repoUrl} className="px-4 py-2 rounded-md border border-border bg-white text-sm font-semibold disabled:opacity-50">
                {saving ? <RefreshCw className="w-4 h-4 inline animate-spin" /> : <Activity className="w-4 h-4 inline" />} Analyze
              </button>
              <button onClick={createDeployment} disabled={saving} className="px-4 py-2 rounded-md bg-primary text-white text-sm font-semibold disabled:opacity-50 inline-flex items-center gap-2">
                <Plus className="w-4 h-4" /> Queue deployment
              </button>
            </div>
            {analysis && <div className="rounded-md border border-border bg-bg p-3 text-xs">Framework: <b>{analysis.framework}</b> · Build: <b>{analysis.build_command}</b> · Start: <b>{analysis.start_command}</b></div>}
          </section>
        )}

        {activeTab === 'settings' && (
          <section className="bg-card-bg border border-border rounded-lg p-6 space-y-3 max-w-xl">
            <h2 className="text-lg font-bold flex items-center gap-2"><SettingsIcon className="w-4 h-4" /> Settings</h2>
            <Field label="GitHub repository path for workflow dispatch">
              <input value={settingsRepoPath} onChange={(e) => setSettingsRepoPath(e.target.value)} placeholder="owner/repository" className="input" />
            </Field>
            <button onClick={() => localStorage.setItem('actionhost.githubRepoPath', settingsRepoPath)} className="px-4 py-2 rounded-md bg-primary text-white text-sm font-semibold">Save settings</button>
            <p className="text-xs text-text-muted">Settings are saved locally in this browser and loaded automatically on startup.</p>
          </section>
        )}

        {selectedProject && <ProjectDetail project={selectedProject} onBack={() => setSelectedProject(null)} />}
      </main>
    </div>
  );
}

function ProjectDetail({ project, onBack }: { project: Project; onBack: () => void }) {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [logs, setLogs] = useState<Log[]>([]);

  useEffect(() => {
    if (!supabase) return;
    const load = async () => {
      const { data: dep } = await supabase.from('deployments').select('*').eq('project_id', project.id).order('created_at', { ascending: false });
      setDeployments(dep ?? []);
      if (dep?.length) {
        const { data: logRows } = await supabase.from('logs').select('*').eq('deployment_id', dep[0].id).order('created_at', { ascending: true });
        setLogs(logRows ?? []);
      }
    };
    load();
    const channel = supabase
      .channel(`deployment-live-${project.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments', filter: `project_id=eq.${project.id}` }, load)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'logs' }, load)
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [project.id]);

  const active = deployments[0] ?? null;

  return (
    <section className="space-y-4">
      <button onClick={onBack} className="text-sm text-text-muted">← Back</button>
      <div className="bg-card-bg border border-border rounded-lg p-6 space-y-4">
        <h2 className="text-xl font-bold">{project.name}</h2>
        <p className="text-xs text-text-muted">{project.repo_url}</p>
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm">
          <div className="p-3 border border-border rounded-md">Status: {active ? <StatusBadge status={active.status} /> : 'No deployments'}</div>
          <div className="p-3 border border-border rounded-md">Created: {active ? new Date(active.created_at).toLocaleString() : 'N/A'}</div>
          <div className="p-3 border border-border rounded-md">URL: {active?.public_url ? <a href={active.public_url} target="_blank" rel="noreferrer" className="text-primary inline-flex items-center gap-1">Open <ExternalLink className="w-3 h-3" /></a> : 'Pending'}</div>
        </div>
      </div>

      <div className="bg-sidebar-bg rounded-lg p-5 h-72 overflow-y-auto">
        <h3 className="text-white text-xs font-bold uppercase tracking-wide flex items-center gap-2 mb-4"><Terminal className="w-4 h-4" /> Deployment logs</h3>
        <div className="space-y-2 text-xs text-[#cbd5e1] font-mono">
          {logs.length === 0 && <p>No logs yet for the latest deployment.</p>}
          {logs.map((log) => (
            <p key={log.id}><span className="text-[#64748b]">[{new Date(log.created_at).toLocaleTimeString()}]</span> {log.message}</p>
          ))}
        </div>
      </div>
    </section>
  );
}

function StatusBadge({ status }: { status: ProjectStatus }) {
  return <span className={cn('px-2 py-1 rounded-full text-[10px] uppercase font-bold border', statusClass[status])}>{status}</span>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="space-y-1 block">
      <span className="text-[10px] uppercase font-bold text-text-muted">{label}</span>
      {children}
    </label>
  );
}

function StatCard({ label, value, icon }: { label: string; value: string; icon: ReactNode }) {
  return (
    <div className="bg-card-bg border border-border rounded-lg p-4">
      <p className="text-xs uppercase text-text-muted font-bold flex items-center gap-2">{icon}{label}</p>
      <p className="text-2xl font-bold mt-2">{value}</p>
    </div>
  );
}
