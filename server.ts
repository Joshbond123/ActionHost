import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { Octokit } from "octokit";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

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

  // Cerebras Key Rotation Helper
  const getRotatedCerebrasKey = async () => {
    const supabase = getSupabase();
    const { data: keys, error } = await supabase
      .from("cerebras_keys")
      .select("*")
      .eq("is_active", true)
      .order("usage_count", { ascending: true })
      .limit(1);

    if (error || !keys || keys.length === 0) {
      return null;
    }

    const selectedKey = keys[0];
    
    // Increment usage count asynchronously
    supabase
      .from("cerebras_keys")
      .update({ 
        usage_count: selectedKey.usage_count + 1,
        last_used_at: new Date().toISOString()
      })
      .eq("id", selectedKey.id)
      .then();

    return { key: selectedKey.key_value, id: selectedKey.id };
  };

  // Track Cerebras key success/failure
  const trackCerebrasResult = async (keyId: string, success: boolean) => {
    const supabase = getSupabase();
    const field = success ? "success_count" : "fail_count";
    const { data: key } = await supabase.from("cerebras_keys").select(field).eq("id", keyId).single();
    if (key) {
      await supabase.from("cerebras_keys").update({ [field]: (key[field] || 0) + 1 }).eq("id", keyId);
    }
  };

  // API Routes
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Trigger Deployment - calls deploy-worker.yml (not deprecated deploy-template.yml)
  app.post("/api/deploy", async (req, res) => {
    const { projectId, repoUrl, buildCommand, startCommand, githubPat } = req.body;
    
    try {
      const supabase = getSupabase();
      
      const token = githubPat || process.env.GITHUB_PAT;
      if (!token) throw new Error("GITHUB_PAT is required.");
      const octokit = new Octokit({ auth: token });

      // 1. Create deployment record in Supabase
      const { data: deployment, error: depError } = await supabase
        .from("deployments")
        .insert({
          project_id: projectId,
          repo_url: repoUrl || "",
          domain: "",
          status: "queued",
          health_status: "pending",
          detected_build_command: buildCommand,
          detected_start_command: startCommand,
          expires_at: new Date(Date.now() + 4 * 60 * 60 * 1000).toISOString(),
        })
        .select()
        .single();

      if (depError) throw depError;

      // 2. Trigger GitHub Action - uses deploy-worker.yml (not deprecated deploy-template.yml)
      const [owner, repo] = (process.env.ACTIONHOST_REPO_PATH || "Joshbond123/ActionHost").split("/");
      await octokit.rest.actions.createWorkflowDispatch({
        owner,
        repo,
        workflow_id: "deploy-worker.yml",
        ref: "main",
        inputs: {
          project_id: projectId,
          deployment_id: deployment.id,
        },
      });

      res.json({ status: "queued", deploymentId: deployment.id });
    } catch (error: any) {
      console.error("Deployment error:", error);
      res.status(500).json({ error: error.message });
    }
  });

  // Cerebras AI proxy - rotates keys and tracks usage
  app.post("/api/cerebras", async (req, res) => {
    const keyData = await getRotatedCerebrasKey();
    if (!keyData) {
      return res.status(503).json({ error: "No Cerebras API keys configured." });
    }

    try {
      const response = await fetch("https://api.cerebras.ai/v1/chat/completions", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${keyData.key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(req.body),
      });

      const data = await response.json();
      
      if (!response.ok) {
        await trackCerebrasResult(keyData.id, false);
        return res.status(response.status).json(data);
      }

      await trackCerebrasResult(keyData.id, true);
      res.status(response.status).json(data);
    } catch (error: any) {
      await trackCerebrasResult(keyData.id, false);
      res.status(500).json({ error: error.message });
    }
  });

  // Background Rotation Logic
  setInterval(async () => {
    try {
      const supabase = getSupabase();
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
          await fetch(`http://localhost:${PORT}/api/deploy`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              projectId: dep.project_id,
              repoUrl: dep.projects?.repo_url,
              buildCommand: dep.projects?.detected_build_command,
              startCommand: dep.projects?.detected_start_command,
            })
          });
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes("required")) return;
      console.error("Background task error:", error);
    }
  }, 60000);

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
