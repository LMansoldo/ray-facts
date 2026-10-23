// Testes do servidor ray-facts com node:test (zero dependências).
// Cobertura: Basic auth (401 sem/credencial errada, timing-safe), contrato do
// POST do Ray (normalização de veredito/confiança/links/termos), validação
// (400 json, 422 campos), listagem /api/facts, SSE (seed + fact ao vivo) e
// estático de web/.

import test from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.js";
import { resetFacts } from "../src/facts.js";

process.env.NODE_ENV = "test";
process.env.FACTS_USER = "ray";
process.env.FACTS_PASS = "segredo";

function startServer() {
  const server = createApp();
  return new Promise((resolveStart) => {
    server.listen(0, "127.0.0.1", () => resolveStart(server));
  });
}

function authHeader(user, pass) {
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

const PAYLOAD = {
  quote: "React 19 saiu estável em dezembro",
  isTrue: "true",
  confianca: "média",
  checagem: "A **documentação oficial** confirma o release em dezembro.",
  resultadoBusca: [
    { title: "React blog", url: "https://react.dev/blog/react-19" },
    "javascript:void(0)",
    { title: "Duplicata", url: "https://react.dev/blog/react-19#x" },
  ],
  termosBusca: ["react 19 stable", "react 19 release date", "react 19 stable"],
};

test("POST /facts exige Basic auth — sem header e com credencial errada = 401", async () => {
  const server = await startServer();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const noAuth = await fetch(`${base}/facts`, {
      method: "POST",
      body: JSON.stringify(PAYLOAD),
    });
    assert.equal(noAuth.status, 401);

    const badAuth = await fetch(`${base}/facts`, {
      method: "POST",
      headers: { authorization: authHeader("ray", "errada") },
      body: JSON.stringify(PAYLOAD),
    });
    assert.equal(badAuth.status, 401);
    assert.match(noAuth.headers.get("www-authenticate") ?? "", /Basic/);
  } finally {
    server.close();
    server.closeAllConnections(); // sockets keep-alive (SSE/fetch) não seguram o runner
  }
});

test("POST /facts com auth aceita o contrato do Ray e normaliza o shape", async () => {
  resetFacts();
  const server = await startServer();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(`${base}/facts`, {
      method: "POST",
      headers: {
        authorization: authHeader("ray", "segredo"),
        "content-type": "application/json",
      },
      body: JSON.stringify(PAYLOAD),
    });
    assert.equal(res.status, 201);
    const { ok, value } = await res.json();
    assert.equal(ok, true);
    assert.match(value.id, /^f/);
    // veredito e confiança normalizados (case/acento)
    assert.equal(value.isTrue, "TRUE");
    assert.equal(value.confianca, "media");
    // links: javascript: fora, duplicata (sem hash) fora
    assert.equal(value.resultadoBusca.length, 1);
    assert.equal(value.resultadoBusca[0].url, "https://react.dev/blog/react-19");
    // termos: dedupe preservando ordem
    assert.deepEqual(value.termosBusca, ["react 19 stable", "react 19 release date"]);
    assert.equal(typeof value.receivedAt, "string");
  } finally {
    server.close();
    server.closeAllConnections(); // sockets keep-alive (SSE/fetch) não seguram o runner
  }
});

test("POST /facts recusa json inválido (400) e payload sem campos mínimos (422)", async () => {
  const server = await startServer();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const headers = {
      authorization: authHeader("ray", "segredo"),
      "content-type": "application/json",
    };
    const bad = await fetch(`${base}/facts`, { method: "POST", headers, body: "{nope" });
    assert.equal(bad.status, 400);
    const empty = await fetch(`${base}/facts`, {
      method: "POST",
      headers,
      body: JSON.stringify({ isTrue: "TRUE" }),
    });
    assert.equal(empty.status, 422);
  } finally {
    server.close();
    server.closeAllConnections(); // sockets keep-alive (SSE/fetch) não seguram o runner
  }
});

test("GET /api/facts devolve as checagens; /health reflete a contagem", async () => {
  resetFacts();
  const server = await startServer();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await fetch(`${base}/facts`, {
      method: "POST",
      headers: { authorization: authHeader("ray", "segredo") },
      body: JSON.stringify(PAYLOAD),
    });
    const list = await (await fetch(`${base}/api/facts`)).json();
    assert.equal(list.ok, true);
    assert.equal(list.value.length, 1);
    assert.equal(list.value[0].quote, PAYLOAD.quote);
    const health = await (await fetch(`${base}/health`)).json();
    assert.equal(health.facts, 1);
  } finally {
    server.close();
    server.closeAllConnections(); // sockets keep-alive (SSE/fetch) não seguram o runner
  }
});

test("GET /stream manda seed do histórico e fact em tempo real", async () => {
  resetFacts();
  const server = await startServer();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    await fetch(`${base}/facts`, {
      method: "POST",
      headers: { authorization: authHeader("ray", "segredo") },
      body: JSON.stringify(PAYLOAD),
    });

    const controller = new AbortController();
    const stream = await fetch(`${base}/stream`, { signal: controller.signal });
    assert.equal(stream.headers.get("content-type"), "text/event-stream");

    // seed chega na conexão (histórico)
    const reader = stream.body.getReader();
    const decode = new TextDecoder();
    let buffer = "";
    const readEvent = async (eventName) => {
      for (;;) {
        const frameMatch = buffer.match(new RegExp(`event: ${eventName}\\ndata: (.+)\\n\\n`));
        if (frameMatch) {
          buffer = buffer.slice(buffer.indexOf(frameMatch[0]) + frameMatch[0].length);
          return JSON.parse(frameMatch[1]);
        }
        const { value, done } = await reader.read();
        if (done) throw new Error(`stream fechou antes de ${eventName}`);
        buffer += decode.decode(value, { stream: true });
      }
    };
    const seed = await readEvent("seed");
    assert.equal(seed.facts.length, 1);

    // POST depois da conexão → evento fact ao vivo
    const livePromise = readEvent("fact");
    await fetch(`${base}/facts`, {
      method: "POST",
      headers: { authorization: authHeader("ray", "segredo") },
      body: JSON.stringify({ ...PAYLOAD, quote: "segunda checagem" }),
    });
    const live = await livePromise;
    assert.equal(live.quote, "segunda checagem");
    controller.abort();
  } finally {
    server.close();
    server.closeAllConnections(); // sockets keep-alive (SSE/fetch) não seguram o runner
  }
});

test("GET / serve o index.html da web", async () => {
  const server = await startServer();
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const res = await fetch(base);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    const html = await res.text();
    // O hero quebra o título em dois spans (CHECAGEM / DE FATOS).
    assert.match(html, /CHECAGEM/);
    assert.match(html, /DE FATOS/);
  } finally {
    server.close();
    server.closeAllConnections(); // sockets keep-alive (SSE/fetch) não seguram o runner
  }
});
