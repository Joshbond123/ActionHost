export type ProjectStatus = 'queued' | 'starting' | 'warming' | 'ready' | 'active' | 'draining' | 'stopped' | 'failed';
export type HealthStatus = 'pending' | 'healthy' | 'unhealthy';

export interface Project {
  id: string;
  name: string;
  repo_url: string;
  ngrok_domain: string;
  auto_deploy_enabled: boolean;
  detected_framework?: string | null;
  detected_branch?: string | null;
  detected_build_command?: string | null;
  detected_start_command?: string | null;
  deployment_strategy?: string | null;
  latest_seen_commit_sha?: string | null;
  latest_deployed_commit_sha?: string | null;
  created_at: string;
  deployments?: Deployment[];
}

export interface Deployment {
  id: string;
  project_id: string;
  repo_url: string;
  branch?: string | null;
  commit_sha?: string | null;
  detected_framework?: string | null;
  detected_build_command?: string | null;
  detected_start_command?: string | null;
  workflow_run_id?: string | null;
  workflow_status?: string | null;
  public_url?: string | null;
  ngrok_domain?: string | null;
  status: ProjectStatus;
  health_status: HealthStatus;
  error_message?: string | null;
  created_at: string;
  became_active_at?: string | null;
  expires_at?: string | null;
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
