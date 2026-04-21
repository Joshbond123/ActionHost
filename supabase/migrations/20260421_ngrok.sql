-- ngrok migration: add columns for ngrok-based deployments and auto-deploy tracking.
alter table public.projects add column if not exists ngrok_authtoken text not null default '';
alter table public.projects add column if not exists last_deployed_sha text not null default '';
alter table public.projects add column if not exists auto_deploy boolean not null default true;

-- Make legacy DNS-related column tolerant to NULL/empty so we can stop populating it.
alter table public.projects alter column free_domain_dns_api_key drop not null;
alter table public.projects alter column free_domain_dns_api_key set default '';
