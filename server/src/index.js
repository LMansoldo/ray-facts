// Ray Facts — servidor do muro de checagens (SSE) que recebe POST do Ray.
//
// Zero dependências: node:http puro (mesmo espírito do sidecar do Ray,
// ADR-005). Subiu, serve a web/ estática, expõe:
//
//   GET  /health            → liveness
//   GET  /stream            → SSE: event: seed (histórico) + event: fact (ao vivo)
//   GET  /api/facts         → JSON das checagens recentes (fallback/refresh)
//   POST /facts             → ingesto do Ray, protegido por HTTP Basic
//                             ("oauth básica": login/senha configurados no
//                             Ray em Configurações › Overlay › SSE)
//   GET  /*                 → estático de web/
//
// O corpo do POST é o contrato do Ray:
//   { quote, isTrue, confianca, checagem, resultadoBusca, termosBusca }
//   - isTrue: TRUE | FALSE | UNCERTAIN
//   - confianca: alta | media | baixa
//   - resultadoBusca: [{ title, url }] (links das fontes)
//   - termosBusca: string[] (termos viram links de busca no Google)

import { createServer } from "node:http";
import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import {
  addFact,
  listFacts,
  normalizeFact,
} from "./facts.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = resolve(__dirname, "../../web");
const HOST = process.env.HOST ?? "0.0.0.0";
const PORT = Number(process.env.PORT ?? 3000);

// Credenciais lidas POR REQUEST (não em módulo): trocar FACTS_USER/FACTS_PASS
// no ambiente vale sem reiniciar e os testes conseguem injetar as suas.
function basicCreds() {
  return {
    user: process.env.FACTS_USER ?? "ray",
    pass: process.env.FACTS_PASS ?? "ray",
  };
}

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

function sendJson(res, status, value) {
  const data = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(data);
}

/** Comparação em tempo constante das credenciais Basic (não vaza por timing). */
function basicAuthOk(header) {
  if (typeof header !== "string" || !header.startsWith("Basic ")) return false;
  let decoded;
  try {
    decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
  } catch {
    return false;
  }
  const sep = decoded.indexOf(":");
  if (sep < 0) return false;
  const { user: wantUser, pass: wantPass } = basicCreds();
  const user = Buffer.from(decoded.slice(0, sep));
  const pass = Buffer.from(decoded.slice(sep + 1));
  const wantUserBuf = Buffer.from(wantUser);
  const wantPassBuf = Buffer.from(wantPass);
  return (
    user.length === wantUserBuf.length &&
    pass.length === wantPassBuf.length &&
    timingSafeEqual(user, wantUserBuf) &&
    timingSafeEqual(pass, wantPassBuf)
  );
}

function readBody(req, limit = 512 * 1024) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        rejectBody(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", rejectBody);
  });
}

async function handlePostFacts(req, res) {
  if (!basicAuthOk(req.headers.authorization)) {
    res.writeHead(401, {
      "www-authenticate": 'Basic realm="ray-facts", charset="UTF-8"',
    });
    return res.end(JSON.stringify({ ok: false, error: "credenciais inválidas" }));
  }
  let raw;
  try {
    raw = await readBody(req);
  } catch {
    return sendJson(res, 413, { ok: false, error: "payload too large" });
  }
  let body;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return sendJson(res, 400, { ok: false, error: "json inválido" });
  }
  const fact = normalizeFact(body);
  if (!fact) {
    return sendJson(res, 422, {
      ok: false,
      error: "campos obrigatórios ausentes: quote e checagem",
    });
  }
  const stored = addFact(fact);
  broadcast("fact", stored);
  return sendJson(res, 201, { ok: true, value: stored });
}

// ── SSE ─────────────────────────────────────────────────────────────────────

const sseClients = new Set();

function broadcast(event, data) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(frame);
    } catch {
      sseClients.delete(client);
    }
  }
}

function handleStream(req, res) {
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write("retry: 3000\n\n");
  // Histórico primeiro — o muro nasce populado mesmo sem nada "ao vivo".
  res.write(`event: seed\ndata: ${JSON.stringify({ facts: listFacts() })}\n\n`);
  sseClients.add(res);
  const ping = setInterval(() => {
    try {
      res.write(": ping\n\n");
    } catch {
      // fechado — cleanup abaixo cuida
    }
  }, 25_000);
  req.on("close", () => {
    clearInterval(ping);
    sseClients.delete(res);
  });
}

// ── Estático ────────────────────────────────────────────────────────────────

async function serveStatic(url, res) {
  const path = normalize(decodeURIComponent(url.split("?")[0]));
  const relative = path === "/" ? "/index.html" : path;
  // Travessia de caminho bloqueada: o resolvido precisa continuar dentro de web/.
  const target = resolve(join(WEB_DIR, relative));
  if (!target.startsWith(WEB_DIR)) {
    return sendJson(res, 403, { ok: false, error: "forbidden" });
  }
  try {
    const data = await readFile(target);
    res.writeHead(200, {
      "content-type": MIME[extname(target)] ?? "application/octet-stream",
      "cache-control": "no-cache",
    });
    res.end(data);
  } catch {
    // SPA-lite: qualquer rota desconhecida cai no index (permLinks #f<id>).
    try {
      const data = await readFile(join(WEB_DIR, "index.html"));
      res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-cache" });
      res.end(data);
    } catch {
      sendJson(res, 404, { ok: false, error: "not found" });
    }
  }
}

export function handlerForTest(route) {
  return route;
}

export function createApp() {
  return createServer((req, res) => {
    const url = req.url ?? "/";
    const method = req.method ?? "GET";
    if (method === "GET" && url === "/health") {
      return sendJson(res, 200, { ok: true, facts: listFacts().length });
    }
    if (method === "POST" && (url === "/facts" || url === "/api/facts")) {
      return void handlePostFacts(req, res).catch(() =>
        sendJson(res, 500, { ok: false, error: "erro interno" }),
      );
    }
    if (method === "GET" && (url === "/stream" || url === "/api/stream")) {
      return handleStream(req, res);
    }
    if (method === "GET" && (url === "/api/facts" || url.startsWith("/api/facts?"))) {
      res.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
        "access-control-allow-origin": "*",
      });
      return res.end(JSON.stringify({ ok: true, value: listFacts() }));
    }
    return void serveStatic(url, res).catch(() =>
      sendJson(res, 500, { ok: false, error: "erro interno" }),
    );
  });
}

/** Hash curto e estável de um texto (id de permalink determinístico no seed). */
export function shortHash(text) {
  return createHash("sha1").update(text).digest("hex").slice(0, 8);
}

// Auto-listen SÓ na execução direta (node server/src/index.js): imports do
// teste (hoisted em ESM) não sobem servidor na porta default.
const isMain =
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const server = createApp();
  server.listen(PORT, HOST, () => {
    const { user, pass } = basicCreds();
    const warn =
      user === "ray" && pass === "ray"
        ? " — CREDENCIAIS DEFAULT (ray/ray): defina FACTS_USER e FACTS_PASS em produção"
        : "";
    console.log(`[ray-facts] http://${HOST}:${PORT}${warn}`);
  });
}
