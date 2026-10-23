// Ray Facts — cliente do muro de stories.
// SSE (/stream) alimenta o tray em tempo real; o viewer segue o UX de stories
// do Instagram (barras de progresso, tocar avança/volta, segurar pausa, fecha).
// Cada story tem o botão Send: Instagram (imagem 1080×1920 via canvas),
// WhatsApp (wa.me) e copiar link (permalink #f<id>).

(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  const el = {
    status: $("[data-status]"),
    statusText: $("[data-status-text]"),
    tray: $("[data-tray]"),
    wallTitle: $("[data-wall-title]"),
    empty: $("[data-empty]"),
    viewer: $("[data-viewer]"),
    viewerBars: $("[data-viewer-bars]"),
    viewerCard: $("[data-viewer-card]"),
    viewerFoot: $("[data-viewer-foot]"),
    viewerClose: $("[data-viewer-close]"),
    viewerPrev: $("[data-viewer-prev]"),
    viewerNext: $("[data-viewer-next]"),
    sheet: $("[data-sheet]"),
    toast: $("[data-toast]"),
  };

  let facts = [];
  let viewIndex = -1;
  let advanceTimer = null;
  let holdTimer = null;
  let holdPaused = false;
  const STEP_MS = 6000;

  // ── Helpers ────────────────────────────────────────────────────────────────

  const VERDICT_LABEL = { TRUE: "Verdadeiro", FALSE: "Falso", UNCERTAIN: "Inconclusivo" };
  const CONF_FILL = { alta: "100%", media: "66%", baixa: "33%" };

  function escapeHtml(text) {
    return String(text ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;");
  }

  /** Markdown mínimo (negrito **x**) sobre texto já escapado. */
  function renderRich(text) {
    return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
  }

  function stripMarks(text) {
    return String(text ?? "").replaceAll("**", "");
  }

  function toast(message) {
    el.toast.textContent = message;
    el.toast.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => {
      el.toast.hidden = true;
    }, 2600);
  }

  function googleUrl(term) {
    return `https://www.google.com/search?q=${encodeURIComponent(term)}`;
  }

  // ── Render de um story (compartilhado por tray e viewer) ──────────────────

  function storyInner(fact, compact) {
    const conf = `<span class="story__conf">confiança <i style="--fill:${
      CONF_FILL[fact.confianca] ?? "33%"
    }"></i> ${escapeHtml(fact.confianca)}</span>`;

    const links = fact.resultadoBusca
      .map(
        (l) =>
          `<a href="${escapeHtml(l.url)}" target="_blank" rel="noreferrer">${escapeHtml(
            l.title || l.url,
          )}</a>`,
      )
      .join("");

    const terms = fact.termosBusca
      .map(
        (t) =>
          `<a href="${googleUrl(t)}" target="_blank" rel="noreferrer">${escapeHtml(t)}</a>`,
      )
      .join("");

    return `
      <div class="story__bg story__bg--${fact.isTrue}" aria-hidden="true"></div>
      <div class="story__inner">
        <div class="story__ring">${"<span></span>".repeat(compact ? 1 : 3)}</div>
        <p class="story__quote">${renderRich(fact.quote || fact.checagem)}</p>
        <span class="stamp stamp--${fact.isTrue}">${VERDICT_LABEL[fact.isTrue] ?? "Inconclusivo"}</span>
        <div class="story__spacer"></div>
        ${
          compact
            ? ""
            : `<div class="story__checagem"><p>${renderRich(fact.checagem)}</p></div>
               ${links ? `<div class="story__links">${links}</div>` : ""}
               ${terms ? `<div class="story__terms">${terms}</div>` : ""}`
        }
        ${conf}
        <button type="button" class="story__send" data-send-open="${escapeHtml(fact.id)}">
          Send ✈
        </button>
      </div>`;
  }

  function renderAll() {
    el.tray.innerHTML = "";
    for (const fact of facts) {
      const card = document.createElement("button");
      card.type = "button";
      card.className = "tray__card story";
      card.dataset.open = fact.id;
      card.setAttribute("aria-label", `Abrir checagem: ${fact.quote || fact.checagem}`);
      card.innerHTML = storyInner(fact, true);
      card.addEventListener("click", (event) => {
        if (event.target.closest("[data-send-open]")) return;
        openViewer(fact.id);
      });
      el.tray.appendChild(card);
    }
    el.empty.hidden = facts.length > 0;
    el.wallTitle.hidden = facts.length === 0;
    el.wallTitle.textContent =
      facts.length === 1 ? "1 checagem" : `${facts.length} checagens`;
  }

  function prependFact(fact, isNew) {
    if (facts.some((f) => f.id === fact.id)) return;
    facts.unshift(fact);
    const card = document.createElement("button");
    card.type = "button";
    card.className = `tray__card story${isNew ? " tray__card--new" : ""}`;
    card.dataset.open = fact.id;
    card.innerHTML = storyInner(fact, true);
    card.addEventListener("click", (event) => {
      if (event.target.closest("[data-send-open]")) return;
      openViewer(fact.id);
    });
    el.tray.prepend(card);
    el.empty.hidden = true;
    el.wallTitle.hidden = false;
    el.wallTitle.textContent =
      facts.length === 1 ? "1 checagem" : `${facts.length} checagens`;
    if (isNew) toast("Nova checagem chegou! 🔥");
  }

  // ── Viewer estilo Instagram ───────────────────────────────────────────────

  function renderBars() {
    el.viewerBars.innerHTML = facts
      .map((f, i) => {
        const state = i < viewIndex ? "is-done" : i === viewIndex ? "is-current" : "";
        return `<span class="${state}" style="--step-ms:${STEP_MS}ms"></span>`;
      })
      .join("");
  }

  function renderViewerCard() {
    const fact = facts[viewIndex];
    if (!fact) return;
    el.viewerCard.classList.add("story");
    el.viewerCard.innerHTML = storyInner(fact, false);
    el.viewerFoot.innerHTML = "";
    history.replaceState(null, "", `#${fact.id}`);
  }

  function armAdvance() {
    clearTimeout(advanceTimer);
    requestAnimationFrame(() => {
      const bar = el.viewerBars.children[viewIndex];
      if (bar) bar.style.setProperty("--p", "1");
    });
    advanceTimer = setTimeout(() => stepViewer(1), STEP_MS);
  }

  function stepViewer(delta) {
    clearTimeout(advanceTimer);
    const next = viewIndex + delta;
    if (next < 0 || next >= facts.length) {
      closeViewer();
      return;
    }
    viewIndex = next;
    renderBars();
    renderViewerCard();
    armAdvance();
  }

  function openViewer(factId) {
    const index = facts.findIndex((f) => f.id === factId);
    if (index < 0) return;
    viewIndex = index;
    el.viewer.hidden = false;
    document.body.style.overflow = "hidden";
    renderBars();
    renderViewerCard();
    armAdvance();
  }

  function closeViewer() {
    clearTimeout(advanceTimer);
    el.viewer.hidden = true;
    viewIndex = -1;
    document.body.style.overflow = "";
    history.replaceState(null, "", location.pathname);
  }

  // Segurar pausa o story (como no Instagram).
  function holdStart() {
    holdTimer = setTimeout(() => {
      holdPaused = true;
      clearTimeout(advanceTimer);
      const bar = el.viewerBars.children[viewIndex];
      if (bar) bar.classList.remove("is-current");
    }, 220);
  }

  function holdEnd() {
    clearTimeout(holdTimer);
    if (holdPaused) {
      holdPaused = false;
      armAdvance();
    }
  }

  el.viewerClose.addEventListener("click", closeViewer);
  el.viewerPrev.addEventListener("click", () => stepViewer(-1));
  el.viewerNext.addEventListener("click", () => stepViewer(1));
  el.viewer.addEventListener("pointerdown", holdStart);
  el.viewer.addEventListener("pointerup", holdEnd);
  el.viewer.addEventListener("pointercancel", holdEnd);
  document.addEventListener("keydown", (event) => {
    if (el.viewer.hidden) return;
    if (event.key === "Escape") closeViewer();
    if (event.key === "ArrowRight") stepViewer(1);
    if (event.key === "ArrowLeft") stepViewer(-1);
  });

  // ── Sheet de envio ────────────────────────────────────────────────────────

  let sheetFact = null;

  function openSheet(fact) {
    sheetFact = fact;
    el.sheet.hidden = false;
  }

  function closeSheet() {
    el.sheet.hidden = true;
    sheetFact = null;
  }

  el.sheet.addEventListener("click", (event) => {
    if (event.target.closest("[data-sheet-close]")) closeSheet();
  });

  function shareText(fact) {
    const verdict = VERDICT_LABEL[fact.isTrue] ?? "Inconclusivo";
    const link = `${location.origin}/#${fact.id}`;
    return (
      `❝ ${stripMarks(fact.quote || fact.checagem)} ❞\n` +
      `Veredito: ${verdict.toUpperCase()} (confiança ${fact.confianca})\n` +
      `Confira: ${link}`
    );
  }

  /** Story 1080×1920 desenhado no canvas (sem dependências). */
  function drawStoryCanvas(fact) {
    const W = 1080;
    const H = 1920;
    const canvas = document.createElement("canvas");
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext("2d");

    const palettes = {
      TRUE: ["#0c4a34", "#0f7a52", "#3ddc97"],
      FALSE: ["#571227", "#a01f3f", "#ff5c7f"],
      UNCERTAIN: ["#3f2f07", "#8a6410", "#ffb020"],
    };
    const [c1, c2, c3] = palettes[fact.isTrue] ?? palettes.UNCERTAIN;
    const grad = ctx.createLinearGradient(0, 0, W, H);
    grad.addColorStop(0, c1);
    grad.addColorStop(0.55, c2);
    grad.addColorStop(1, c3);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, W, H);

    const wrap = (text, font, maxWidth) => {
      ctx.font = font;
      const words = String(text).split(/\s+/);
      const lines = [];
      let line = "";
      for (const word of words) {
        const attempt = line ? `${line} ${word}` : word;
        if (ctx.measureText(attempt).width > maxWidth && line) {
          lines.push(line);
          line = word;
        } else {
          line = attempt;
        }
      }
      if (line) lines.push(line);
      return lines;
    };

    // cabeçalho
    ctx.fillStyle = "rgba(255,255,255,0.9)";
    ctx.font = "700 44px 'Trebuchet MS', sans-serif";
    ctx.fillText("🕵️ RAY · CHECAGEM DE FATOS", 80, 150);

    // quote
    ctx.fillStyle = "#fff";
    const quoteLines = wrap(`❝ ${stripMarks(fact.quote || fact.checagem)} ❞`, "700 64px 'Trebuchet MS', sans-serif", W - 160);
    let y = 380;
    for (const line of quoteLines.slice(0, 8)) {
      ctx.fillText(line, 80, y);
      y += 78;
    }

    // carimbo do veredito
    ctx.save();
    ctx.translate(80, y + 90);
    ctx.rotate(-0.06);
    ctx.strokeStyle = "rgba(255,255,255,0.95)";
    ctx.lineWidth = 8;
    ctx.font = "900 72px 'Trebuchet MS', sans-serif";
    const label = (VERDICT_LABEL[fact.isTrue] ?? "INCONCLUSIVO").toUpperCase();
    const w = ctx.measureText(label).width;
    ctx.strokeRect(0, -64, w + 60, 100);
    ctx.fillStyle = "rgba(255,255,255,0.95)";
    ctx.fillText(label, 30, 8);
    ctx.restore();

    // checagem
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    y += 280;
    const bodyLines = wrap(stripMarks(fact.checagem), "400 44px 'Trebuchet MS', sans-serif", W - 160);
    for (const line of bodyLines.slice(0, 12)) {
      ctx.fillText(line, 80, y);
      y += 60;
    }

    // fontes + termos
    ctx.fillStyle = "rgba(255,255,255,0.75)";
    ctx.font = "600 36px 'Trebuchet MS', sans-serif";
    if (fact.resultadoBusca.length) {
      ctx.fillText(`🔗 ${fact.resultadoBusca.length} fonte(s) consultada(s)`, 80, y + 60);
    }
    if (fact.termosBusca.length) {
      ctx.fillText(`🔎 ${fact.termosBusca.map((t) => `“${t}”`).join(" · ")}`, 80, y + 130);
    }

    // rodapé
    ctx.fillStyle = "rgba(0,0,0,0.3)";
    ctx.fillRect(0, H - 190, W, 190);
    ctx.fillStyle = "#fff";
    ctx.font = "800 40px 'Trebuchet MS', sans-serif";
    ctx.fillText("CHECAGEM DE FATOS · AO VIVO", 80, H - 100);
    ctx.font = "400 32px 'Trebuchet MS', sans-serif";
    ctx.fillText(`checagemdefatos · ${location.host}`, 80, H - 50);

    return canvas;
  }

  function downloadCanvas(canvas, filename) {
    canvas.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
    }, "image/png");
  }

  const isMobile = /android|iphone|ipad/i.test(navigator.userAgent);

  el.sheet.addEventListener("click", async (event) => {
    const button = event.target.closest("[data-send]");
    if (!button || !sheetFact) return;
    const fact = sheetFact;
    closeSheet();

    const kind = button.dataset.send;
    if (kind === "instagram") {
      downloadCanvas(drawStoryCanvas(fact), `checagem-${fact.id}-1080x1920.png`);
      // No celular, o deep link abre a câmera de stories direto.
      if (isMobile) {
        window.location.href = "instagram://story-camera";
        toast("Imagem baixada! Escolha-a no Instagram 📸");
      } else {
        toast("Imagem 1080×1920 baixada — poste como story 📸");
      }
      return;
    }
    if (kind === "whatsapp") {
      window.open(`https://wa.me/?text=${encodeURIComponent(shareText(fact))}`, "_blank");
      return;
    }
    if (kind === "link") {
      const link = `${location.origin}/#${fact.id}`;
      try {
        await navigator.clipboard.writeText(link);
        toast("Link copiado! 🔗");
      } catch {
        toast(link);
      }
    }
  });

  // Delegação: botões Send do tray (compact e viewer).
  document.addEventListener("click", (event) => {
    const send = event.target.closest("[data-send-open]");
    if (send) {
      event.stopPropagation();
      const fact = facts.find((f) => f.id === send.dataset.sendOpen);
      if (fact) openSheet(fact);
    }
  });

  // ── SSE ───────────────────────────────────────────────────────────────────

  function setStatus(state, text) {
    el.status.dataset.status = state;
    el.statusText.textContent = text;
  }

  function connect() {
    const source = new EventSource("/stream");
    source.addEventListener("seed", (event) => {
      try {
        const { facts: seeded } = JSON.parse(event.data);
        facts = seeded ?? [];
        renderAll();
        // Permalink: #f<id> abre o story direto.
        const target = /^#(f\w+)$/.exec(location.hash);
        if (target && facts.some((f) => f.id === target[1])) openViewer(target[1]);
      } catch {
        // frame inválido — segue
      }
    });
    source.addEventListener("fact", (event) => {
      try {
        prependFact(JSON.parse(event.data), true);
      } catch {
        // frame inválido — segue
      }
    });
    source.onopen = () => setStatus("live", "ao vivo");
    source.onerror = () => setStatus("down", "reconectando…");
  }

  connect();
})();
