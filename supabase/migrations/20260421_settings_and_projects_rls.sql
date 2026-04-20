-- Add missing RLS policies so the client (anon key) can update projects
-- and read/write env vars in the settings table.

-- Allow updating existing projects (repo URL, domain, DNS key etc.)
create policy "public update projects" on public.projects
  for update using (true) with check (true);

-- Allow reading settings (for env var key listing)
create policy "public read settings" on public.settings
  for select using (true);

-- Allow inserting new settings rows (for env vars on first save)
create policy "public insert settings" on public.settings
  for insert with check (true);

-- Allow updating existing settings rows (for subsequent env var updates)
create policy "public update settings" on public.settings
  for update using (true) with check (true);
