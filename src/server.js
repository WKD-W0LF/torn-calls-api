const express = require("express");
const helmet = require("helmet");
const { Pool } = require("pg");
const https = require("https");

const PORT = Number(process.env.PORT || 3000);
const FACTION_ID = Number(process.env.FACTION_ID || 56966);
const CLAIM_TTL_SECONDS = Number(process.env.CLAIM_TTL_SECONDS || 90);
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "https://www.torn.com";
// How long (ms) to cache a valid Torn API key verification result
const AUTH_CACHE_TTL_MS = Number(process.env.AUTH_CACHE_TTL_MS || 60000);

for (const key of ["PGHOST", "PGPORT", "PGDATABASE", "PGUSER", "PGPASSWORD"]) {
  if (!process.env[key]) {
    console.error(`Missing required environment variable: ${key}`);
    process.exit(1);
  }
}

const pool = new Pool({
  host: process.env.PGHOST,
  port: Number(process.env.PGPORT),
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  ssl: process.env.PGSSLMODE === "require" ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PGPOOL_MAX || 5),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000
});

const app = express();
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// --- Torn API faction membership verification with short-lived cache ---
const authCache = new Map(); // apiKey -> { valid: bool, expiresAt: Date.now() }

function tornApiGet(path) {
  return new Promise((resolve, reject) => {
    const req = https.get(`https://api.torn.com${path}`, { timeout: 8000 }, (res) => {
      let body = "";
      res.on("data", (chunk) => { body += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(body)); }
        catch (e) { reject(new Error("Invalid JSON from Torn API")); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("Torn API timeout")); });
  });
}

async function verifyFactionMembership(apiKey) {
  const cached = authCache.get(apiKey);
  if (cached && cached.expiresAt > Date.now()) return cached.valid;

  try {
    const data = await tornApiGet(`/user/?selections=profile&key=${apiKey}`);
    // Torn API error codes: https://www.torn.com/api.html
    if (data.error) {
      console.warn(`Torn API error for key verification: ${data.error.error} (code ${data.error.code})`);
      authCache.set(apiKey, { valid: false, expiresAt: Date.now() + 10000 }); // short cache for errors
      return false;
    }
    const valid = data.faction && data.faction.faction_id === FACTION_ID;
    authCache.set(apiKey, { valid, expiresAt: Date.now() + AUTH_CACHE_TTL_MS });
    return valid;
  } catch (err) {
    console.error("Torn API verification failed:", err.message);
    return false;
  }
}

async function requireAuth(req, res, next) {
  const auth = req.get("authorization") || "";
  if (!auth.startsWith("Bearer ")) {
    return res.status(401).json({ success: false, error: "unauthorized" });
  }
  const apiKey = auth.slice(7).trim();
  if (!apiKey) {
    return res.status(401).json({ success: false, error: "unauthorized" });
  }
  const valid = await verifyFactionMembership(apiKey);
  if (!valid) {
    return res.status(401).json({ success: false, error: "unauthorized" });
  }
  next();
}

async function removeExpired(client = pool) {
  await client.query("DELETE FROM torn_target_calls WHERE expires_at <= NOW()");
}

async function initialiseDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS torn_target_calls (
      target_id BIGINT PRIMARY KEY,
      target_name VARCHAR(64) NOT NULL,
      called_by_id BIGINT NOT NULL,
      called_by_name VARCHAR(64) NOT NULL,
      called_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      priority BOOLEAN NOT NULL DEFAULT FALSE,
      assist_requested BOOLEAN NOT NULL DEFAULT FALSE
    )
  `);
  await pool.query(`ALTER TABLE torn_target_calls ADD COLUMN IF NOT EXISTS priority BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`ALTER TABLE torn_target_calls ADD COLUMN IF NOT EXISTS assist_requested BOOLEAN NOT NULL DEFAULT FALSE`);
  await pool.query(`CREATE INDEX IF NOT EXISTS torn_target_calls_expires_at_idx ON torn_target_calls (expires_at)`);
}

const callSelect = `
  SELECT
    target_id::text AS "targetId",
    target_name AS "targetName",
    called_by_id::text AS "calledById",
    called_by_name AS "calledByName",
    called_at AS "calledAt",
    expires_at AS "expiresAt",
    priority AS "priority",
    assist_requested AS "assistRequested"
  FROM torn_target_calls
`;

app.get("/health", (_req, res) => res.json({ status: "ok" }));
app.get("/ready", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ready" });
  } catch (error) {
    console.error("Readiness check failed:", error.message);
    res.status(503).json({ status: "not_ready" });
  }
});

app.get("/api/v1/calls", requireAuth, async (_req, res) => {
  try {
    await removeExpired();
    const result = await pool.query(`${callSelect} ORDER BY priority DESC, assist_requested DESC, called_at ASC`);
    res.json({ success: true, calls: result.rows });
  } catch (error) {
    console.error("GET calls failed:", error);
    res.status(500).json({ success: false, error: "database_error" });
  }
});

app.post("/api/v1/calls", requireAuth, async (req, res) => {
  const { targetId, targetName, calledById, calledByName, priority = false, assistRequested = false } = req.body || {};
  if (!/^\d+$/.test(String(targetId || "")) || !/^\d+$/.test(String(calledById || "")) ||
      !String(targetName || "").trim() || !String(calledByName || "").trim() ||
      typeof priority !== "boolean" || typeof assistRequested !== "boolean") {
    return res.status(400).json({ success: false, error: "invalid_request" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await removeExpired(client);
    const result = await client.query(`
      INSERT INTO torn_target_calls
        (target_id, target_name, called_by_id, called_by_name, expires_at, priority, assist_requested)
      VALUES ($1, $2, $3, $4, NOW() + ($5 * INTERVAL '1 second'), $6, $7)
      ON CONFLICT (target_id) DO NOTHING
      RETURNING ${callSelect.replace(/\s+FROM torn_target_calls\s*$/, "").trim().replace(/^\s*SELECT\s+/, "")}
    `, [String(targetId), String(targetName).trim().slice(0, 64), String(calledById),
        String(calledByName).trim().slice(0, 64), CLAIM_TTL_SECONDS, priority, assistRequested]);

    if (result.rowCount === 0) {
      const existing = await client.query(`${callSelect} WHERE target_id = $1`, [String(targetId)]);
      await client.query("COMMIT");
      return res.status(409).json({ success: false, error: "already_called", call: existing.rows[0] || null });
    }
    await client.query("COMMIT");
    res.status(201).json({ success: true, call: result.rows[0] });
  } catch (error) {
    await client.query("ROLLBACK");
    console.error("POST call failed:", error);
    res.status(500).json({ success: false, error: "database_error" });
  } finally {
    client.release();
  }
});

app.patch("/api/v1/calls/:targetId", requireAuth, async (req, res) => {
  const targetId = String(req.params.targetId || "");
  const { priority, assistRequested } = req.body || {};
  if (!/^\d+$/.test(targetId)) return res.status(400).json({ success: false, error: "invalid_target_id" });
  if (priority === undefined && assistRequested === undefined) return res.status(400).json({ success: false, error: "no_updates_supplied" });
  if ((priority !== undefined && typeof priority !== "boolean") || (assistRequested !== undefined && typeof assistRequested !== "boolean")) {
    return res.status(400).json({ success: false, error: "invalid_request" });
  }
  try {
    await removeExpired();
    const result = await pool.query(`
      UPDATE torn_target_calls
      SET priority = COALESCE($2, priority), assist_requested = COALESCE($3, assist_requested)
      WHERE target_id = $1
      RETURNING ${callSelect.replace(/\s+FROM torn_target_calls\s*$/, "").trim().replace(/^\s*SELECT\s+/, "")}
    `, [targetId, priority ?? null, assistRequested ?? null]);
    if (result.rowCount === 0) return res.status(404).json({ success: false, error: "call_not_found" });
    res.json({ success: true, call: result.rows[0] });
  } catch (error) {
    console.error("PATCH call failed:", error);
    res.status(500).json({ success: false, error: "database_error" });
  }
});

app.delete("/api/v1/calls/:targetId", requireAuth, async (req, res) => {
  const targetId = String(req.params.targetId || "");
  if (!/^\d+$/.test(targetId)) return res.status(400).json({ success: false, error: "invalid_target_id" });
  try {
    const result = await pool.query("DELETE FROM torn_target_calls WHERE target_id = $1 RETURNING target_id", [targetId]);
    res.json({ success: true, released: result.rowCount > 0 });
  } catch (error) {
    console.error("DELETE call failed:", error);
    res.status(500).json({ success: false, error: "database_error" });
  }
});

app.delete("/api/v1/calls", requireAuth, async (_req, res) => {
  try {
    const result = await pool.query("DELETE FROM torn_target_calls");
    res.json({ success: true, cleared: result.rowCount });
  } catch (error) {
    console.error("DELETE all calls failed:", error);
    res.status(500).json({ success: false, error: "database_error" });
  }
});

async function start() {
  try {
    await initialiseDatabase();
    app.listen(PORT, "0.0.0.0", () => console.log(`Torn Calls API v2 listening on port ${PORT}`));
  } catch (error) {
    console.error("Application startup failed:", error);
    process.exit(1);
  }
}

process.on("SIGTERM", async () => { await pool.end(); process.exit(0); });

start();
