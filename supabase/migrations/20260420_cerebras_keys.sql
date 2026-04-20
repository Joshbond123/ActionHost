-- Cerebras API Keys table for multi-key management with rotation tracking
create extension if not exists "uuid-ossp";

create table if not exists public.cerebras_keys (
  id uuid primary key default uuid_generate_v4(),
  key_value text not null,
  label text not null default 'API Key',
  usage_count integer not null default 0,
  success_count integer not null default 0,
  fail_count integer not null default 0,
  last_used_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

-- Row Level Security — block ALL anon/authenticated access
-- Keys can only be read/written through edge functions (service_role bypasses RLS)
alter table public.cerebras_keys enable row level security;

-- Deny all access from the client (anon + authenticated)
-- Edge functions use service_role which bypasses RLS
create policy "deny_all_client_access" on public.cerebras_keys
  as restrictive
  for all
  using (false);

-- Migrate existing cerebras key from settings table if it exists
do $$
declare
  existing_key text;
begin
  select value into existing_key
  from public.settings
  where key = 'cerebras_api_key'
  limit 1;

  if existing_key is not null and existing_key != '' then
    insert into public.cerebras_keys (key_value, label, is_active)
    values (existing_key, 'Migrated Key', true)
    on conflict do nothing;
  end if;
exception
  when others then
    -- settings table may not exist, that's fine
    null;
end $$;
