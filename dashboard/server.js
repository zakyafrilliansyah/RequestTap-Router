const express = require("express");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const GATEWAY_URL = process.env.GATEWAY_URL || "http://localhost:4402";

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Clean URL routes
app.get("/", (_req, res) => {
  res.redirect("/dashboard");
});
app.get("/dashboard", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});
app.get("/docs", (_req, res) => {
  res.sendFile(path.join(__dirname, "public", "docs.html"));
});

// Proxy fetch for OpenAPI specs (avoids CORS issues)
app.post("/fetch-spec", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url required" });
  try {
    const upstream = await fetch(url);
    if (!upstream.ok) return res.status(upstream.status).json({ error: `Upstream returned ${upstream.status}` });
    const text = await upstream.text();
    res.json({ text });
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch spec", detail: err.message });
  }
});

// Proxy RPC calls (avoids browser CORS issues)
app.post("/rpc-proxy", async (req, res) => {
  const { rpcUrl, body: rpcBody } = req.body;
  if (!rpcUrl) return res.status(400).json({ error: "rpcUrl required" });
  try {
    const upstream = await fetch(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rpcBody),
    });
    const data = await upstream.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "RPC unreachable", detail: err.message });
  }
});

// Proxy /api-test/* → GATEWAY_URL/* (pass-through, no admin key injection)
app.all("/api-test/*", async (req, res) => {
  const targetPath = req.originalUrl.replace(/^\/api-test/, "");
  const url = GATEWAY_URL + targetPath;

  try {
    const headers = {};
    for (const key of ["content-type", "authorization", "x-request-idempotency-key", "x-api-key", "x-mandate", "x-agent-address"]) {
      if (req.headers[key]) headers[key] = req.headers[key];
    }

    const fetchOpts = { method: req.method, headers };
    if (["POST", "PUT", "PATCH"].includes(req.method) && req.body) {
      if (!headers["content-type"]) headers["content-type"] = "application/json";
      fetchOpts.body = JSON.stringify(req.body);
    }

    const upstream = await fetch(url, fetchOpts);
    const body = await upstream.text();

    for (const [k, v] of upstream.headers.entries()) {
      if (!["transfer-encoding", "content-encoding", "connection"].includes(k)) {
        res.setHeader(k, v);
      }
    }
    res.status(upstream.status).send(body);
  } catch (err) {
    res.status(502).json({ error: "Gateway unreachable", detail: err.message });
  }
});

// Proxy /gateway/* → GATEWAY_URL/*
app.all("/gateway/*", async (req, res) => {
  const targetPath = req.originalUrl.replace(/^\/gateway/, "");
  const url = GATEWAY_URL + targetPath;

  try {
    const headers = { "content-type": "application/json" };

    // Use admin key from env var (preferred) or request header
    const adminKey = process.env.RT_ADMIN_KEY || req.headers["x-admin-key"];
    if (adminKey) {
      headers["authorization"] = `Bearer ${adminKey}`;
    }

    const fetchOpts = { method: req.method, headers };
    if (["POST", "PUT", "PATCH"].includes(req.method) && req.body) {
      fetchOpts.body = JSON.stringify(req.body);
    }

    const upstream = await fetch(url, fetchOpts);
    const body = await upstream.text();

    for (const [k, v] of upstream.headers.entries()) {
      if (!["transfer-encoding", "content-encoding", "connection"].includes(k)) {
        res.setHeader(k, v);
      }
    }
    res.status(upstream.status).send(body);
  } catch (err) {
    res.status(502).json({ error: "Gateway unreachable", detail: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n  RequestTap Router Dashboard`);
  console.log(`  ──────────────────────────`);
  console.log(`  Dashboard:  http://localhost:${PORT}`);
  console.log(`  Gateway:    ${GATEWAY_URL}`);
  console.log();
});
