import React, { useState, useEffect } from "react";
import { 
  Layout, 
  Plus, 
  Settings as SettingsIcon, 
  Activity, 
  Globe, 
  Github, 
  Terminal, 
  Shield, 
  RefreshCw,
  ExternalLink,
  ChevronRight,
  AlertCircle,
  CheckCircle2,
  Clock,
  Menu,
  X
} from "lucide-react";
import { motion, AnimatePresence } from "motion/react";
import { cn } from "@/src/lib/utils";
import { supabase } from "@/src/lib/supabase";
import { Project, Deployment, ProjectStatus, CerebrasKey } from "./types";

// Mock data for initial UI development
const MOCK_PROJECTS: Project[] = [
  {
    id: "1",
    name: "My Awesome App",
    repo_url: "https://github.com/user/repo",
    cloudflare_zone_id: "zone123",
    cloudflare_api_token: "cf_token",
    github_pat: "ghp_pat",
    domain: "example.com",
    subdomain: "app",
    framework: "Next.js",
    created_at: new Date().toISOString(),
  }
];

const MOCK_DEPLOYMENTS: Deployment[] = [
  {
    id: "d1",
    project_id: "1",
    status: "active",
    public_url: "https://temp-url.actionhost.app",
    created_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
  }
];

export default function App() {
  const [activeTab, setActiveTab] = useState<"dashboard" | "new" | "settings">("dashboard");
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedProject, setSelectedProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(false);
  const [repoUrl, setRepoUrl] = useState("");
  const [domain, setDomain] = useState("");
  const [subdomain, setSubdomain] = useState("");
  const [zoneId, setZoneId] = useState("");
  const [analysis, setAnalysis] = useState<any>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(false);
  const [githubPat, setGithubPat] = useState("");
  const [cloudflareToken, setCloudflareToken] = useState("");
  const [cerebrasKeys, setCerebrasKeys] = useState<CerebrasKey[]>([]);
  const [newCerebrasKey, setNewCerebrasKey] = useState("");

  useEffect(() => {
    if (!supabase) return;
    fetchProjects();
    fetchCerebrasKeys();
    
    // Subscribe to changes
    const projectsSub = supabase
      .channel('projects-all')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'projects' }, fetchProjects)
      .subscribe();

    const keysSub = supabase
      .channel('cerebras-keys')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'cerebras_keys' }, fetchCerebrasKeys)
      .subscribe();

    return () => {
      supabase.removeChannel(projectsSub);
      supabase.removeChannel(keysSub);
    };
  }, []);

  const fetchProjects = async () => {
    if (!supabase) return;
    const { data } = await supabase.from("projects").select("*").order("created_at", { ascending: false });
    if (data) setProjects(data);
  };

  const fetchCerebrasKeys = async () => {
    if (!supabase) return;
    const { data } = await supabase.from("cerebras_keys").select("*").order("created_at", { ascending: false });
    if (data) setCerebrasKeys(data);
  };

  const handleAddCerebrasKey = async () => {
    if (!supabase || !newCerebrasKey) return;
    try {
      const { error } = await supabase.from("cerebras_keys").insert({ key: newCerebrasKey });
      if (error) throw error;
      setNewCerebrasKey("");
      fetchCerebrasKeys();
    } catch (error) {
      console.error("Failed to add key", error);
    }
  };

  const handleDeleteCerebrasKey = async (id: string) => {
    if (!supabase) return;
    try {
      const { error } = await supabase.from("cerebras_keys").delete().eq("id", id);
      if (error) throw error;
      fetchCerebrasKeys();
    } catch (error) {
      console.error("Failed to delete key", error);
    }
  };

  const handleAnalyze = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ repoUrl, githubPat })
      });
      const data = await res.json();
      setAnalysis(data);
    } catch (error) {
      console.error("Analysis failed", error);
    } finally {
      setLoading(false);
    }
  };

  const handleDeploy = async () => {
    setLoading(true);
    try {
      if (!supabase) throw new Error("Supabase is not configured. Please add SUPABASE_URL and SUPABASE_ANON_KEY to your secrets.");
      if (!githubPat || !cloudflareToken) throw new Error("GitHub PAT and Cloudflare API Token are required for deployment.");

      // 1. Create project
      const { data: project, error } = await supabase.from("projects").insert({
        name: repoUrl.split("/").pop()?.replace(".git", "") || "New Project",
        repo_url: repoUrl,
        domain,
        subdomain,
        cloudflare_zone_id: zoneId,
        cloudflare_api_token: cloudflareToken,
        github_pat: githubPat,
        framework: analysis?.framework,
        build_command: analysis?.build_command,
        start_command: analysis?.start_command
      }).select().single();

      if (error) throw error;

      // 2. Trigger deployment
      await fetch("/api/deploy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: project.id,
          repoUrl,
          buildCommand: analysis?.build_command,
          startCommand: analysis?.start_command,
          githubPat,
          cloudflareToken
        })
      });

      setActiveTab("dashboard");
      setRepoUrl("");
      setAnalysis(null);
      setGithubPat("");
      setCloudflareToken("");
    } catch (error: any) {
      console.error("Deployment failed", error);
      alert(error.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg text-text-main font-sans selection:bg-primary selection:text-white">
      {/* Mobile Sidebar Overlay */}
      <AnimatePresence>
        {isSidebarOpen && (
          <motion.div 
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            onClick={() => setIsSidebarOpen(false)}
            className="fixed inset-0 bg-black/50 z-[60] md:hidden"
          />
        )}
      </AnimatePresence>

      {/* Sidebar */}
      <aside className={cn(
        "fixed left-0 top-0 h-full w-60 bg-sidebar-bg z-[70] flex flex-col transition-transform duration-300 md:translate-x-0",
        isSidebarOpen ? "translate-x-0" : "-translate-x-full"
      )}>
        <div className="p-6 flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-primary/20 rounded-lg flex items-center justify-center">
              <Activity className="text-[#38BDF8] w-5 h-5" />
            </div>
            <span className="font-bold text-xl tracking-tight text-[#38BDF8]">ActionHost</span>
          </div>
          <button 
            onClick={() => setIsSidebarOpen(false)}
            className="md:hidden text-[#94A3B8] hover:text-white"
          >
            <X className="w-6 h-6" />
          </button>
        </div>
        
        <nav className="flex-grow px-3 space-y-1">
          <button 
            onClick={() => { setActiveTab("dashboard"); setSelectedProject(null); setIsSidebarOpen(false); }}
            className={cn(
              "w-full flex items-center gap-3 px-4 py-3 rounded-md transition-all duration-200 text-sm font-medium",
              activeTab === "dashboard" ? "bg-sidebar-hover text-white border-r-4 border-primary" : "text-[#94A3B8] hover:bg-sidebar-hover hover:text-white"
            )}
          >
            <Activity className="w-4 h-4" />
            <span>Dashboard</span>
          </button>
          
          <button 
            onClick={() => { setActiveTab("settings"); setIsSidebarOpen(false); }}
            className={cn(
              "w-full flex items-center gap-3 px-4 py-3 rounded-md transition-all duration-200 text-sm font-medium",
              activeTab === "settings" ? "bg-sidebar-hover text-white border-r-4 border-primary" : "text-[#94A3B8] hover:bg-sidebar-hover hover:text-white"
            )}
          >
            <SettingsIcon className="w-4 h-4" />
            <span>Settings</span>
          </button>
        </nav>

        <div className="p-4 border-t border-sidebar-hover">
          <div className="flex items-center gap-3 p-2">
            <div className="w-8 h-8 bg-sidebar-hover rounded-full flex items-center justify-center text-xs font-bold text-white">A</div>
            <div className="flex flex-col">
              <span className="text-xs font-bold text-white">Admin</span>
              <span className="text-[10px] text-[#94A3B8]">Pro Plan</span>
            </div>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="md:pl-60 min-h-screen flex flex-col">
        <header className="h-16 bg-white border-b border-border flex items-center justify-between px-4 md:px-8 sticky top-0 z-40">
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setIsSidebarOpen(true)}
              className="md:hidden p-2 hover:bg-bg rounded-md"
            >
              <Menu className="w-6 h-6 text-text-main" />
            </button>
            <div className="flex items-center gap-2 text-sm text-text-muted">
              <span className="font-semibold hidden sm:inline">Project:</span>
              <span className="text-primary font-bold capitalize truncate max-w-[120px] sm:max-w-none">
                {selectedProject ? selectedProject.name : activeTab}
              </span>
            </div>
          </div>
          
          <div className="flex items-center gap-4">
            <button 
              onClick={() => setActiveTab("new")}
              className="bg-primary text-white px-3 py-1.5 md:px-4 md:py-2 rounded-md flex items-center gap-2 text-xs md:text-sm font-semibold hover:opacity-90 transition-all shadow-sm"
            >
              <Plus className="w-4 h-4" />
              <span className="hidden sm:inline">New Project</span>
              <span className="sm:hidden">New</span>
            </button>
          </div>
        </header>

        <div className="p-4 md:p-8 flex-grow">
          <AnimatePresence mode="wait">
            {activeTab === "dashboard" && !selectedProject && (
              <motion.div 
                key="dashboard"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="space-y-6"
              >
                <div className="flex items-end justify-between">
                  <div>
                    <h1 className="text-3xl font-bold tracking-tight text-text-main">Projects</h1>
                    <p className="text-text-muted mt-1">Manage your temporary deployments</p>
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {projects.map((project) => (
                    <ProjectCard 
                      key={project.id} 
                      project={project} 
                      onClick={() => setSelectedProject(project)}
                    />
                  ))}
                </div>
              </motion.div>
            )}

            {activeTab === "new" && (
              <motion.div 
                key="new"
                initial={{ opacity: 0, scale: 0.98 }}
                animate={{ opacity: 1, scale: 1 }}
                exit={{ opacity: 0, scale: 0.98 }}
                className="max-w-3xl mx-auto"
              >
                <div className="bg-card-bg p-6 sm:p-8 rounded-lg border border-border shadow-sm space-y-6">
                  <div>
                    <h2 className="text-sm font-bold uppercase tracking-wider text-text-muted mb-4">New Deployment</h2>
                    <p className="text-sm text-text-muted mb-6">Connect your GitHub repository and set up Cloudflare</p>
                  </div>
                  
                  <div className="space-y-4">
                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold uppercase text-text-muted flex items-center gap-2">
                          <Github className="w-3 h-3" />
                          GitHub Repository URL
                        </label>
                        <input 
                          type="text" 
                          value={repoUrl}
                          onChange={(e) => setRepoUrl(e.target.value)}
                          placeholder="https://github.com/username/repo"
                          className="w-full px-3 py-2 rounded-md border border-border focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all text-sm"
                        />
                      </div>

                      <div className="space-y-1">
                        <label className="text-[10px] font-bold uppercase text-text-muted flex items-center gap-2">
                          <Globe className="w-3 h-3" />
                          Custom Domain
                        </label>
                        <input 
                          type="text" 
                          value={domain}
                          onChange={(e) => setDomain(e.target.value)}
                          placeholder="example.com"
                          className="w-full px-3 py-2 rounded-md border border-border focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all text-sm"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold uppercase text-text-muted flex items-center gap-2">
                          <Shield className="w-3 h-3" />
                          Cloudflare API Token
                        </label>
                        <input 
                          type="password" 
                          value={cloudflareToken}
                          onChange={(e) => setCloudflareToken(e.target.value)}
                          placeholder="cf_********************"
                          className="w-full px-3 py-2 rounded-md border border-border focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold uppercase text-text-muted flex items-center gap-2">
                          <Github className="w-3 h-3" />
                          GitHub PAT
                        </label>
                        <input 
                          type="password" 
                          value={githubPat}
                          onChange={(e) => setGithubPat(e.target.value)}
                          placeholder="ghp_********************"
                          className="w-full px-3 py-2 rounded-md border border-border focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all text-sm"
                        />
                      </div>
                    </div>

                    <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold uppercase text-text-muted flex items-center gap-2">
                          <Shield className="w-3 h-3" />
                          Cloudflare Zone ID
                        </label>
                        <input 
                          type="text" 
                          value={zoneId}
                          onChange={(e) => setZoneId(e.target.value)}
                          placeholder="zone_id_here"
                          className="w-full px-3 py-2 rounded-md border border-border focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all text-sm"
                        />
                      </div>
                      <div className="space-y-1">
                        <label className="text-[10px] font-bold uppercase text-text-muted">Subdomain (Optional)</label>
                        <input 
                          type="text" 
                          value={subdomain}
                          onChange={(e) => setSubdomain(e.target.value)}
                          placeholder="app"
                          className="w-full px-3 py-2 rounded-md border border-border focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary transition-all text-sm"
                        />
                      </div>
                      <div className="flex items-end">
                        {!analysis ? (
                          <button 
                            onClick={handleAnalyze}
                            disabled={loading || !repoUrl}
                            className="w-full bg-primary text-white py-2 rounded-md font-semibold hover:opacity-90 transition-all shadow-sm flex items-center justify-center gap-2 disabled:opacity-50 text-sm"
                          >
                            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Activity className="w-4 h-4" />}
                            Analyze Repo
                          </button>
                        ) : (
                          <button 
                            onClick={handleDeploy}
                            disabled={loading}
                            className="w-full bg-success text-white py-2 rounded-md font-semibold hover:opacity-90 transition-all shadow-sm flex items-center justify-center gap-2 text-sm"
                          >
                            {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />}
                            Deploy Now
                          </button>
                        )}
                      </div>
                    </div>

                    {analysis && (
                      <motion.div 
                        initial={{ opacity: 0, height: 0 }}
                        animate={{ opacity: 1, height: "auto" }}
                        className="p-4 bg-bg rounded-md border border-border space-y-2"
                      >
                        <h4 className="text-[10px] font-bold uppercase text-text-muted">AI Analysis Result</h4>
                        <div className="grid grid-cols-2 gap-2 text-xs">
                          <div>
                            <span className="text-text-muted">Framework:</span>
                            <span className="ml-2 font-bold text-text-main">{analysis.framework}</span>
                          </div>
                          <div>
                            <span className="text-text-muted">Branch:</span>
                            <span className="ml-2 font-bold text-text-main">{analysis.branch}</span>
                          </div>
                        </div>
                      </motion.div>
                    )}
                  </div>
                </div>
              </motion.div>
            )}

            {activeTab === "settings" && (
              <motion.div 
                key="settings"
                initial={{ opacity: 0, x: 20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -20 }}
                className="max-w-3xl mx-auto space-y-8"
              >
                <div>
                  <h2 className="text-3xl font-bold text-text-main">Settings</h2>
                  <p className="text-text-muted">Manage your Cerebras API keys and rotation</p>
                </div>

                <div className="bg-card-bg rounded-lg border border-border overflow-hidden shadow-sm">
                  <div className="p-6 border-b border-border">
                    <h3 className="text-sm font-bold uppercase tracking-wider text-text-muted">Cerebras API Keys</h3>
                    <p className="text-xs text-text-muted mt-1">Add multiple keys for automatic rotation and usage tracking.</p>
                  </div>
                  <div className="p-6 space-y-6">
                    <div className="flex gap-4">
                      <input 
                        type="password" 
                        value={newCerebrasKey}
                        onChange={(e) => setNewCerebrasKey(e.target.value)}
                        placeholder="c_********************"
                        className="flex-grow px-3 py-2 rounded-md border border-border focus:outline-none focus:ring-2 focus:ring-primary/20 focus:border-primary text-sm"
                      />
                      <button 
                        onClick={handleAddCerebrasKey}
                        className="bg-primary text-white px-6 py-2 rounded-md font-semibold hover:opacity-90 transition-all shadow-sm text-sm"
                      >
                        Add Key
                      </button>
                    </div>

                    <div className="space-y-3">
                      {cerebrasKeys.map((key) => (
                        <div key={key.id} className="flex items-center justify-between p-4 bg-bg rounded-md border border-border">
                          <div className="flex flex-col">
                            <span className="text-xs font-mono text-text-main">
                              {key.key.substring(0, 4)}...{key.key.substring(key.key.length - 4)}
                            </span>
                            <span className="text-[10px] text-text-muted uppercase font-bold mt-1">
                              Usages: {key.usage_count}
                            </span>
                          </div>
                          <button 
                            onClick={() => handleDeleteCerebrasKey(key.id)}
                            className="text-xs text-red-500 hover:text-red-700 font-bold uppercase tracking-wider"
                          >
                            Delete
                          </button>
                        </div>
                      ))}
                      {cerebrasKeys.length === 0 && (
                        <div className="text-center py-8 border-2 border-dashed border-border rounded-md">
                          <p className="text-sm text-text-muted">No keys added yet.</p>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {selectedProject && (
              <ProjectDetail 
                project={selectedProject} 
                onBack={() => setSelectedProject(null)} 
              />
            )}
          </AnimatePresence>
        </div>
      </main>
    </div>
  );
}

function ProjectCard({ project, onClick }: { project: Project, onClick: () => void, key?: React.Key }) {
  return (
    <motion.div 
      whileHover={{ y: -4 }}
      onClick={onClick}
      className="bg-card-bg p-6 rounded-lg border border-border shadow-sm hover:shadow-md transition-all cursor-pointer group"
    >
      <div className="flex items-start justify-between mb-4">
        <div className="w-10 h-10 bg-bg rounded-lg flex items-center justify-center group-hover:bg-primary transition-colors">
          <Github className="w-5 h-5 text-text-muted group-hover:text-white transition-colors" />
        </div>
        <StatusBadge status="active" />
      </div>
      
      <h3 className="font-bold text-lg mb-1 text-text-main">{project.name}</h3>
      <p className="text-xs text-text-muted font-mono mb-4 truncate">{project.repo_url}</p>
      
      <div className="flex items-center gap-2 text-xs text-text-muted font-medium">
        <Globe className="w-3 h-3" />
        <span>{project.subdomain ? `${project.subdomain}.` : ""}{project.domain}</span>
      </div>
    </motion.div>
  );
}

function StatusBadge({ status }: { status: ProjectStatus }) {
  const styles = {
    active: "bg-[#DCFCE7] text-[#166534] border-[#BBF7D0]",
    starting: "bg-blue-50 text-blue-700 border-blue-100",
    failed: "bg-red-50 text-red-700 border-red-100",
    queued: "bg-slate-50 text-slate-700 border-slate-100",
    warming: "bg-[#FEF3C7] text-[#92400E] border-[#FDE68A]",
    ready: "bg-indigo-50 text-indigo-700 border-indigo-100",
    draining: "bg-orange-50 text-orange-700 border-orange-100",
    stopped: "bg-slate-50 text-slate-700 border-slate-100",
  };

  return (
    <span className={cn(
      "px-3 py-1 rounded-full text-[10px] font-bold uppercase tracking-wider border",
      styles[status]
    )}>
      {status}
    </span>
  );
}

function ProjectDetail({ project, onBack }: { project: Project, onBack: () => void }) {
  const [deployments, setDeployments] = useState<Deployment[]>([]);
  const [activeDeployment, setActiveDeployment] = useState<Deployment | null>(null);

  useEffect(() => {
    if (!supabase) return;
    fetchDeployments();
    const sub = supabase
      .channel(`project-${project.id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'deployments', filter: `project_id=eq.${project.id}` }, fetchDeployments)
      .subscribe();
    return () => { supabase.removeChannel(sub); };
  }, [project.id]);

  const fetchDeployments = async () => {
    if (!supabase) return;
    const { data } = await supabase
      .from("deployments")
      .select("*")
      .eq("project_id", project.id)
      .order("created_at", { ascending: false });
    
    if (data) {
      setDeployments(data);
      setActiveDeployment(data.find(d => d.status === "active") || data[0] || null);
    }
  };

  const handleRedeploy = async () => {
    await fetch("/api/deploy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectId: project.id,
        repoUrl: project.repo_url,
        buildCommand: project.build_command,
        startCommand: project.start_command
      })
    });
  };

  return (
    <motion.div 
      initial={{ opacity: 0, x: 20 }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: -20 }}
      className="space-y-8"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <button onClick={onBack} className="text-sm text-text-muted hover:text-text-main mb-2 flex items-center gap-1 transition-colors">
            <ChevronRight className="w-4 h-4 rotate-180" />
            Back to Dashboard
          </button>
          <h1 className="text-2xl sm:text-3xl font-bold text-text-main">{project.name}</h1>
        </div>
        <div className="flex gap-3">
          <button 
            onClick={handleRedeploy}
            className="flex-1 sm:flex-none px-4 py-2 rounded-md border border-border font-semibold hover:bg-white transition-all flex items-center justify-center gap-2 text-sm text-text-main"
          >
            <RefreshCw className="w-4 h-4" />
            Redeploy
          </button>
          {activeDeployment?.public_url && (
            <a 
              href={activeDeployment.public_url} 
              target="_blank" 
              rel="noreferrer"
              className="flex-1 sm:flex-none px-4 py-2 rounded-md bg-primary text-white font-semibold hover:opacity-90 transition-all flex items-center justify-center gap-2 text-sm shadow-sm"
            >
              <ExternalLink className="w-4 h-4" />
              Visit Site
            </a>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
        <div className="lg:col-span-2 space-y-8">
          {/* Active Deployment */}
          <div className="bg-card-bg rounded-lg border border-border overflow-hidden shadow-sm">
            <div className="p-6 border-b border-border flex items-center justify-between">
              <h3 className="text-sm font-bold uppercase tracking-wider text-text-muted flex items-center gap-2">
                <Activity className="w-4 h-4" />
                {activeDeployment?.status === "active" ? "Active Deployment" : "Latest Deployment"}
              </h3>
              {activeDeployment && <StatusBadge status={activeDeployment.status} />}
            </div>
            <div className="p-6 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div className="p-4 bg-bg rounded-md border border-border">
                  <span className="text-[10px] uppercase font-bold text-text-muted block mb-1">Public URL</span>
                  <span className="text-sm font-mono truncate block text-text-main">
                    {activeDeployment?.public_url || "Waiting for tunnel..."}
                  </span>
                </div>
                <div className="p-4 bg-bg rounded-md border border-border">
                  <span className="text-[10px] uppercase font-bold text-text-muted block mb-1">Created At</span>
                  <span className="text-sm font-bold flex items-center gap-2 text-text-main">
                    <Clock className="w-4 h-4 text-text-muted" />
                    {activeDeployment ? new Date(activeDeployment.created_at).toLocaleString() : "N/A"}
                  </span>
                </div>
              </div>
            </div>
          </div>

          {/* Logs */}
          <div className="bg-sidebar-bg rounded-lg overflow-hidden shadow-xl">
            <div className="p-4 border-b border-sidebar-hover flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Terminal className="w-4 h-4 text-[#38BDF8]" />
                <span className="text-[10px] font-bold text-white uppercase tracking-widest">Deployment Logs</span>
              </div>
              <div className="flex gap-2">
                <div className="w-2 h-2 rounded-full bg-red-500/50" />
                <div className="w-2 h-2 rounded-full bg-yellow-500/50" />
                <div className="w-2 h-2 rounded-full bg-green-500/50" />
              </div>
            </div>
            <div className="p-6 h-80 overflow-y-auto font-mono text-[11px] space-y-2 text-[#94A3B8]">
              <p><span className="text-[#475569] mr-2">[15:41:12]</span> <span className="text-[#38BDF8] mr-2">[SYS]</span> Initializing deployment workflow...</p>
              <p><span className="text-[#475569] mr-2">[15:41:15]</span> <span className="text-[#38BDF8] mr-2">[GIT]</span> Cloning repository: {project.repo_url}</p>
              <p><span className="text-[#475569] mr-2">[15:41:20]</span> <span className="text-[#38BDF8] mr-2">[AI]</span> Detecting framework: {project.framework}</p>
              <p><span className="text-[#475569] mr-2">[15:41:25]</span> <span className="text-[#38BDF8] mr-2">[BUILD]</span> Running build command: {project.build_command || 'npm run build'}</p>
              <p><span className="text-[#475569] mr-2">[15:42:10]</span> <span className="text-success mr-2">[SUCCESS]</span> Build successful. Starting application...</p>
              <p><span className="text-[#475569] mr-2">[15:42:15]</span> <span className="text-warning mr-2">[WARM]</span> Warming up deployment...</p>
              <p><span className="text-[#475569] mr-2">[15:42:30]</span> <span className="text-success mr-2">[HEALTH]</span> Health check passed. Switching DNS...</p>
              <p className="text-white font-bold tracking-widest mt-4 border-t border-sidebar-hover pt-4">--- DEPLOYMENT READY ---</p>
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="bg-card-bg p-6 rounded-lg border border-border space-y-4 shadow-sm">
            <h3 className="text-[10px] font-bold uppercase tracking-wider text-text-muted">Project Details</h3>
            <div className="space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-text-muted">Framework</span>
                <span className="font-bold text-text-main">{project.framework}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-text-muted">Branch</span>
                <span className="font-bold text-text-main">main</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-text-muted">Region</span>
                <span className="font-bold text-text-main">GitHub Actions</span>
              </div>
            </div>
          </div>

          <div className="bg-card-bg p-6 rounded-lg border border-border space-y-4 shadow-sm">
            <h3 className="text-[10px] font-bold uppercase tracking-wider text-text-muted">Domain Config</h3>
            <div className="space-y-3">
              <div className="p-3 bg-bg rounded-md border border-border">
                <span className="text-[10px] font-bold text-text-muted block uppercase mb-1">Cloudflare Zone</span>
                <span className="text-xs font-mono text-text-main break-all">{project.cloudflare_zone_id}</span>
              </div>
              <div className="p-3 bg-bg rounded-md border border-border">
                <span className="text-[10px] font-bold text-text-muted block uppercase mb-1">Target Domain</span>
                <span className="text-xs font-bold text-primary">{project.subdomain ? `${project.subdomain}.` : ""}{project.domain}</span>
              </div>
            </div>
          </div>

          <div className="bg-card-bg p-6 rounded-lg border border-border space-y-4 shadow-sm">
            <h3 className="text-[10px] font-bold uppercase tracking-wider text-text-muted">Upcoming Rotation</h3>
            <div className="space-y-4">
              <div className="flex justify-between items-center py-2 border-b border-border last:border-0">
                <div>
                  <div className="text-xs font-bold text-text-main">next-rotation-v2</div>
                  <div className="text-[10px] text-text-muted">Queue: 14:40</div>
                </div>
                <StatusBadge status="warming" />
              </div>
              <div className="flex justify-between items-center py-2 border-b border-border last:border-0">
                <div>
                  <div className="text-xs font-bold text-text-main">manual-patch</div>
                  <div className="text-[10px] text-text-muted">Draft</div>
                </div>
                <StatusBadge status="queued" />
              </div>
            </div>
          </div>
        </div>
      </div>
    </motion.div>
  );
}
