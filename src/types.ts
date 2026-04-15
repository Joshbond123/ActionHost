export type ProjectStatus =
  | 'queued'
  | 'starting'
  | 'warming'
  | 'ready'
  | 'active'
  | 'draining'
  | 'stopped'
  | 'failed';

export interface Project {
  id: string;
  name: string;
  repo_url: string;
  domain: string;
  subdomain?: string | null;
  framework?: string | null;
  build_command?: string | null;
  start_command?: string | null;
  cloudflare_zone_id?: string | null;
  created_at: string;
}

export interface CerebrasKey {
  id: string;
  key: string;
  usage_count: number;
  created_at: string;
}

export interface Deployment {
  id: string;
  project_id: string;
  status: ProjectStatus;
  workflow_run_id?: string | null;
  public_url?: string | null;
  created_at: string;
  expires_at?: string | null;
}

export interface Log {
  id: string;
  deployment_id: string;
  message: string;
  level: 'info' | 'warn' | 'error';
  created_at: string;
}
