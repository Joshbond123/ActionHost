# ActionHost

Deploy any GitHub repository as a temporary host using GitHub Actions with zero-downtime rotation and Cloudflare integration.

## Supabase Schema

Run the following SQL in your Supabase SQL Editor:

```sql
-- Projects Table
CREATE TABLE projects (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  name TEXT NOT NULL,
  repo_url TEXT NOT NULL,
  cloudflare_zone_id TEXT NOT NULL,
  cloudflare_api_token TEXT NOT NULL,
  github_pat TEXT NOT NULL,
  domain TEXT NOT NULL,
  subdomain TEXT,
  framework TEXT,
  build_command TEXT,
  start_command TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Cerebras Keys Table
CREATE TABLE cerebras_keys (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  key TEXT NOT NULL UNIQUE,
  usage_count INTEGER DEFAULT 0,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Deployments Table
CREATE TABLE deployments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'queued',
  workflow_run_id TEXT,
  public_url TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE
);

-- Logs Table
CREATE TABLE logs (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deployment_id UUID REFERENCES deployments(id) ON DELETE CASCADE,
  message TEXT NOT NULL,
  level TEXT DEFAULT 'info',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Enable Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE projects;
ALTER PUBLICATION supabase_realtime ADD TABLE deployments;
ALTER PUBLICATION supabase_realtime ADD TABLE logs;
```

## Setup

1.  **GitHub PAT**: Create a Personal Access Token with `repo` and `workflow` scopes.
2.  **Cloudflare**: Get your API Token (with DNS edit permissions) and Zone ID.
3.  **Supabase**: Create a new project and get the URL and Service Role Key.
4.  **Environment Variables**: Update your `.env` file with the keys above.
5.  **GitHub Actions**: Ensure the `deploy-template.yml` is in your repository's `.github/workflows` folder.

## How it Works

1.  **Analyze**: Paste a GitHub URL. ActionHost uses Gemini AI to detect the framework and commands.
2.  **Deploy**: ActionHost triggers a GitHub Action in *this* repo.
3.  **Host**: The GitHub Action clones the target repo, builds it, and starts it.
4.  **Expose**: A Cloudflare Tunnel is created to expose the local app to the internet.
5.  **Rotate**: Every 4 hours, a new deployment is started. Once ready, the Cloudflare DNS is updated to point to the new tunnel URL, ensuring zero downtime.
