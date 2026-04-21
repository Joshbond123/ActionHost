export type ProjectStatus = 'queued' | 'starting' | 'warming' | 'ready' | 'active' | 'draining' | 'stopped' | 'failed';

export type HealthStatus = 'pending' | 'healthy' | 'unhealthy';

export interface Deployment {
  id: string;
  project_id: string;
  repo_url: string;
  domain: string;
  tunnel_hostname?: string | null;
  public_url?: string | null;
  workflow_run_id?: string | null;
  workflow_status?: string | null;
  status: ProjectStatus;
  health_status: HealthStatus;
  detected_framework?: string | null;
  detected_branch?: string | null;
  detected_build_command?: string | null;
  detected_start_command?: string | null;
  deployment_strategy?: string | null;
  error_message?: string | null;
  created_at: string;
  became_active_at?: string | null;
  expires_at?: string | null;
}

export interface Project {
  id: string;
  name: string;
  repo_url: string;
  domain: string;
  ngrok_authtoken?: string | null;
  last_deployed_sha?: string | null;
  auto_deploy?: boolean | null;
  detected_framework?: string | null;
  detected_branch?: string | null;
  detected_build_command?: string | null;
  detected_start_command?: string | null;
  deployment_strategy?: string | null;
  created_at: string;
  deployments?: Deployment[];
}

export interface DomainMapping {
  id: string;
  domain: string;
  active_deployment_id?: string | null;
  last_dns_update_at?: string | null;
  dns_status: 'pending' | 'active' | 'failed';
  tunnel_hostname?: string | null;
  created_at: string;
}

export interface LogEntry {
  id: string;
  deployment_id: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  created_at: string;
}

export interface CerebrasKey {
  id: string;
  label: string;
  usage_count: number;
  success_count: number;
  fail_count: number;
  last_used_at: string | null;
  is_active: boolean;
  created_at: string;
}
