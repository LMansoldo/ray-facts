// Store em memória das checagens (muro ao vivo): anel limitado + normalização
// do contrato do Ray. Sem banco de propósito — o muro é efêmero por design
// (stories do dia); persistir é uma extensão natural (JSON/SQLite) se/ quando
// o produto pedir.

const MAX_FACTS = 100;

let seq = 0;

const VERDICTS = new Set(["TRUE", "FALSE", "UNCERTAIN"]);
const CONFIDENCE = new Set(["alta", "media", "baixa"]);

function str(value, max = 2000) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

/** Links das fontes: aceita [{title,url}] ou strings cruas do chamador. */
function normalizeLinks(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    let title = "";
    let url = "";
    if (typeof item === "string") {
      url = item.trim();
    } else if (item && typeof item === "object") {
      title = str(item.title, 160);
      url = str(item.url, 800);
    }
    if (!/^https?:\/\//i.test(url)) continue;
    const key = url.replace(/[#?].*$/, "");
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ title: title || url.replace(/^https?:\/\//, "").slice(0, 60), url });
    if (out.length >= 6) break;
  }
  return out;
}

/** Termos de busca: strings curtas, sem duplicatas, máx. 4. */
function normalizeTerms(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    const term = str(item, 120);
    if (!term) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= 4) break;
  }
  return out;
}

/**
 * Normaliza o payload do Ray para o shape canônico do muro. Null quando não
 * há o mínimo exibível (quote e checagem).
 */
export function normalizeFact(body) {
  if (typeof body !== "object" || body === null) return null;
  const quote = str(body.quote, 600);
  const checagem = str(body.checagem, 2000);
  if (!quote && !checagem) return null;

  const isTrueRaw = str(body.isTrue, 20).toUpperCase();
  const isTrue = VERDICTS.has(isTrueRaw) ? isTrueRaw : "UNCERTAIN";
  const confiancaRaw = str(body.confianca, 20)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, ""); // média → media
  const confianca = CONFIDENCE.has(confiancaRaw) ? confiancaRaw : "baixa";

  return {
    id: `f${Date.now().toString(36)}${(seq++).toString(36)}`,
    quote,
    isTrue,
    confianca,
    checagem,
    resultadoBusca: normalizeLinks(body.resultadoBusca),
    termosBusca: normalizeTerms(body.termosBusca),
    receivedAt: new Date().toISOString(),
  };
}

/** Anel em memória — mais novo primeiro. */
const facts = [];

export function addFact(fact) {
  facts.unshift(fact);
  if (facts.length > MAX_FACTS) facts.length = MAX_FACTS;
  return fact;
}

export function listFacts() {
  return [...facts];
}

/** Reset (testes). */
export function resetFacts() {
  facts.length = 0;
  seq = 0;
}
