import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { GoogleGenAI } from "@google/genai";
import { Octokit } from "octokit";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Lazy clients
  let _supabase: any = null;
  const getSupabase = () => {
    if (!_supabase) {
      const url = process.env.SUPABASE_URL;
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
      if (!url || !key) {
        throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for this operation.");
      }
      _supabase = createClient(url, key);
    }
    return _supabase;
  };

  let _octokit: any = null;
  const getOctokit = () => {
    if (!_octokit) {
      const token = process.env.GITHUB_PAT;
      if (!token) {
        throw new Error("GITHUB_PAT is required for this operation.");
      }
      _octokit = new Octokit({ auth: token });
    }
    return _octokit;
  };

  let _ai: any = null;
  const getAI = () => {
    if (!_ai) {
      const key = process.env.GEMINI_API_KEY;
      if (!key) {
        throw new Error("GEMINI_API_KEY is required for this operation.");
      }
      _ai = new GoogleGenAI({ apiKey: key });
    }
    return _ai;
  };

  // Cerebras Key Rotation Helper
  const getRotatedCerebrasKey = async () => {
    const supabase = getSupabase();
    // Get keys ordered by usage_count (ascending) to rotate
    const { data: keys, error } = await supabase
      .from("cerebras_keys")
      .select("*")
      .order("usage_count", { ascending: true })
      .limit(1);

    if (error || !keys || keys.length === 0) {
      return null;
    }

    const selectedKey = keys[0];
    
    // Increment usage count asynchronously
    supabase
      .from("cerebras_keys")
      .update({ usage_count: selectedKey.usage_count + 1 })
      .eq("id", selectedKey.id)
      .then();

    return selectedKey.key;
  };

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Analyze Repository
  app.post("/api/analyze", async (req, res) => {
    const { repoUrl, githubPat } = req.body;
    if (!repoUrl) return res.status(400).json({ error: "Repo URL is required" });

    try {
      // Use provided PAT or fall back to env
      const token = githubPat || process.env.GITHUB_PAT;
      if (!token) throw new Error("GITHUB_PAT is required.");
      const octokit = new Octokit({ auth: token });
      const ai = getAI();
      
      // Extract owner and repo from URL
      const match = repoUrl.match(/github\.com\/([^/]+)\/([^/]+)/);
      if (!match) return res.status(400).json({ error: "Invalid GitHub URL" });
      const [_, owner, repo] = match;

      // Fetch repo content (simplified: just list files)
      const { data: files } = await octokit.rest.repos.getContent({
        owner,
        repo: repo.replace(".git", ""),
        path: "",
      });

      const fileList = Array.isArray(files) ? files.map((f: any) => f.name).join(", ") : "";

      // Use Gemini to detect framework
      const prompt = `Analyze this list of files from a GitHub repository and detect:
      1. Framework (Next.js, React, Node, Vite, static, Python, etc.)
      2. Build command (e.g., npm run build)
      3. Start command (e.g., npm start)
      4. Main branch (usually main or master)

      Files: ${fileList}

      Return ONLY a JSON object with keys: framework, build_command, start_command, branch.`;

      const model = ai.getGenerativeModel({ model: "gemini-1.5-pro" });
      const result = await model.generateContent(prompt);
      const response = await result.response;
      const text = response.text();
      
      // Clean up JSON response if needed
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      const analysis = JSON.parse(jsonMatch ? jsonMatch[0] : text);
      res.json(analysis);
    } catch (error: any) {
      console.error("Analysis error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Trigger Deployment
  app.post("/api/deploy", async (req, res) => {
    const { projectId, repoUrl, buildCommand, startCommand, githubPat, cloudflareToken } = req.body;
    
    try {
      const supabase = getSupabase();
      
      // Use provided PAT or fall back to env
      const token = githubPat || process.env.GITHUB_PAT;
      if (!token) throw new Error("GITHUB_PAT is required.");
      const octokit = new Octokit({ auth: token });

      // 1. Create deployment record in Supabase
      const { data: deployment, error: depError } = await supabase
        .from("deployments")
        .insert({
          project_id: projectId,
          status: "queued",
        })
        .select()
        .single();

      if (depError) throw depError;

      // 2. Trigger GitHub Action
      const [owner, repo] = process.env.ACTIONHOST_REPO_PATH?.split("/") || ["owner", "repo"];
      await octokit.rest.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: "deploy-template.yml",
        ref: "main",
        inputs: {
          repo_url: repoUrl,
          project_id: projectId,
          deployment_id: deployment.id,
          build_command: buildCommand || "npm run build",
          start_command: startCommand || "npm start",
          supabase_url: process.env.SUPABASE_URL || "",
          supabase_key: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
        },
      });

      res.json({ status: "queued", deploymentId: deployment.id });
    } catch (error: any) {
      console.error("Deployment error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Switch Domain (Cloudflare)
  app.post("/api/switch-domain", async (req, res) => {
    const { projectId, deploymentId } = req.body;
    
    try {
      const supabase = getSupabase();
      const { data: project } = await supabase.from("projects").select("*").eq("id", projectId).single();
      const { data: deployment } = await supabase.from("deployments").select("*").eq("id", deploymentId).single();

      if (!project || !deployment || !deployment.public_url) {
        return res.status(400).json({ error: "Invalid project or deployment" });
      }

      const targetUrl = new URL(deployment.public_url).hostname;
      const zoneId = project.cloudflare_zone_id;
      const domain = project.domain;
      const subdomain = project.subdomain;
      const recordName = subdomain ? `${subdomain}.${domain}` : domain;

      if (!process.env.CLOUDFLARE_API_TOKEN) {
        throw new Error("CLOUDFLARE_API_TOKEN is required.");
      }

      // Update Cloudflare DNS
      const listRes = await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records?name=${recordName}`, {
        headers: {
          "Authorization": `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`,
          "Content-Type": "application/json"
        }
      });
      const listData = await listRes.json();
      const record = listData.result[0];

      if (record) {
        await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records/${record.id}`, {
          method: "PATCH",
          headers: {
            "Authorization": `Bearer ${project.cloudflare_api_token || process.env.CLOUDFLARE_API_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            type: "CNAME",
            name: recordName,
            content: targetUrl,
            proxied: true
          })
        });
      } else {
        await fetch(`https://api.cloudflare.com/client/v4/zones/${zoneId}/dns_records`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${project.cloudflare_api_token || process.env.CLOUDFLARE_API_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            type: "CNAME",
            name: recordName,
            content: targetUrl,
            proxied: true,
            ttl: 1
          })
        });
      }

      await supabase.from("deployments").update({ status: "active" }).eq("id", deploymentId);
      await supabase.from("deployments")
        .update({ status: "draining" })
        .eq("project_id", projectId)
        .neq("id", deploymentId)
        .eq("status", "active");

      res.json({ success: true });
    } catch (error: any) {
      console.error("Switch error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Background Rotation Logic
  setInterval(async () => {
    try {
      const supabase = getSupabase();
      // 1. Check for deployments that are "ready" (have public_url but not active)
      const { data: readyDeployments } = await supabase
        .from("deployments")
        .select("*, projects(*)")
        .eq("status", "queued")
        .not("public_url", "is", null);

      for (const dep of readyDeployments || []) {
        console.log(`Switching domain for project ${dep.project_id} to deployment ${dep.id}`);
        await fetch(`http://localhost:3000/api/switch-domain`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectId: dep.project_id, deploymentId: dep.id })
        });
      }

      // 2. Check for active deployments that are about to expire (e.g., older than 3.5 hours)
      const threeAndHalfHoursAgo = new Date(Date.now() - 3.5 * 60 * 60 * 1000).toISOString();
      const { data: expiringDeployments } = await supabase
        .from("deployments")
        .select("*, projects(*)")
        .eq("status", "active")
        .lt("created_at", threeAndHalfHoursAgo);

      for (const dep of expiringDeployments || []) {
        const { count } = await supabase
          .from("deployments")
          .select("*", { count: "exact", head: true })
          .eq("project_id", dep.project_id)
          .in("status", ["queued", "starting", "warming"]);

        if (count === 0) {
          console.log(`Triggering rotation for project ${dep.project_id}`);
          await fetch(`http://localhost:3000/api/deploy`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectId: dep.project_id,
              repoUrl: dep.projects.repo_url,
              buildCommand: dep.projects.build_command,
              start_command: dep.projects.start_command,
              githubPat: dep.projects.github_pat,
              cloudflareToken: dep.projects.cloudflare_api_token
            })
          });
        }
      }
    } catch (error) {
      // Silently fail background tasks if env vars missing
      if (error instanceof Error && error.message.includes("required")) return;
      console.error("Background task error:", error);
    }
  }, 60000); // Check every minute

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
