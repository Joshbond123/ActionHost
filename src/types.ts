export type ProjectStatus = 'queued' | 'starting' | 'warming' | 'ready' | 'active' | 'draining' | 'stopped' | 'failed';

export interface Project {
  id: string;
  name: string;
  repo_url: string;
  cloudflare_zone_id: string;
  cloudflare_api_token: string;
  github_pat: string;
  domain: string;
  subdomain?: string;
  framework?: string;
  build_command?: string;
  start_command?: string;
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
  workflow_run_id?: string;
  public_url?: string;
  created_at: string;
  expires_at?: string;
}

export interface Log {
  id: string;
  deployment_id: string;
  message: string;
  level: 'info' | 'warn' | 'error';
  created_at: string;
}
