export type ProjectStatus = 'queued' | 'starting' | 'warming' | 'ready' | 'active' | 'draining' | 'stopped' | 'failed';

export interface Deployment {
  id: string;
  project_id: string;
  status: ProjectStatus;
  workflow_run_id?: string | null;
  public_url?: string | null;
  healthcheck_url?: string | null;
  created_at: string;
  expires_at?: string | null;
}

export interface Project {
  id: string;
  name: string;
  repo_url: string;
  domain: string;
  subdomain?: string | null;
  cloudflare_zone_id: string;
  framework?: string | null;
  branch?: string | null;
  build_command?: string | null;
  start_command?: string | null;
  created_at: string;
  deployments?: Deployment[];
}

export interface DomainMapping {
  id: string;
  project_id: string;
  deployment_id: string;
  fqdn: string;
  target_hostname: string;
  status: 'pending' | 'active' | 'failed';
  created_at: string;
}

export interface WorkflowRun {
  id: string;
  deployment_id: string;
  github_run_id: string;
  status: string;
  created_at: string;
}

export interface LogEntry {
  id: string;
  deployment_id: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  created_at: string;
}
