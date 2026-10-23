# ray-facts 🔍

Muro **ao vivo** de checagens de fatos do [Ray](https://github.com/LMansoldo/ray):
cada verificação que o agente faz vira um **story** (9:16) num layout de stories do
Instagram, com hero **CHECAGEM DE FATOS** e UI lúdica. Chega em tempo real via SSE.

Monorepo de dois apps, **zero dependências** (Node puro):

```
server/   node:http — SSE + ingesto POST (HTTP Basic) + estático de web/
web/      site vanilla (HTML/CSS/JS) — tray de stories + viewer + Send
```

## Rodar

```bash
npm start                      # http://localhost:3000 (creds default ray/ray)
FACTS_USER=joao FACTS_PASS=s3nhA PORT=8080 npm start
npm test                       # node --test (server)
```

## Contrato de ingesto (`POST /facts`)

Protegido por **HTTP Basic** — exatamente o login/senha que o Ray guarda em
Configurações › Overlay › **SSE — Envio de checagem**. Corpo:

```json
{
  "quote": "fala verificada (o outro disse)",
  "isTrue": "TRUE | FALSE | UNCERTAIN",
  "confianca": "alta | media | baixa",
  "checagem": "texto da verificação (aceita **negrito**)",
  "resultadoBusca": [{ "title": "React blog", "url": "https://react.dev/…" }],
  "termosBusca": ["react 19 stable", "node 24 lts"]
}
```

- `resultadoBusca` — links das fontes (aceita `[{title,url}]` ou strings de URL).
- `termosBusca` — viram chips 🔎 que abrem a busca no Google.

O servidor normaliza case/acento (`"média"` → `media`), deduplica links/termos e
guarda tudo **em memória** (anel de 100 — o muro é efêmero como story).

## Consumo

| Rota            | O que faz                                                        |
| --------------- | ---------------------------------------------------------------- |
| `GET /stream`   | SSE: `event: seed` (histórico) e `event: fact` (ao vivo)         |
| `GET /api/facts`| JSON das checagens (fallback/refresh)                            |
| `GET /health`   | liveness + contagem                                              |

## Send de cada story

- **📸 Instagram** — desenha o story em canvas **1080×1920** e baixa o PNG
  (no celular tenta abrir `instagram://story-camera`).
- **💬 WhatsApp** — `wa.me` com veredito + permalink (status ou link).
- **🔗 Link** — permalink `/#f<id>` que abre o story direto no viewer.

## Deploy

Qualquer VPS Linux (Ubuntu/Debian/Oracle) com systemd, uma linha pela SSH
(instala Node 20, nginx com proxy SSE-safe, unit systemd e libera firewall):

```bash
ssh root@SEU_IP 'DOMAIN=debatejusto.site bash -s' < deploy/vps.sh
```

- `DOMAIN` é opcional — sem ele o site sobe em `http://SEU_IP`; com ele, o
  script configura `server_name` e roda `certbot --nginx` (HTTPS automático,
  desde que o DNS do domínio já aponte para o IP da VPS).
- Re-executar atualiza o código e mantém a senha gerada (fica em
  `/etc/ray-facts.env`, chmod 600).
- Ao final o script imprime a URL, o endpoint `/facts` e as credenciais para
  colar no Ray (Configurações › Overlay › SSE — Envio de checagem).

## Integrar com o Ray

No app desktop/extensão: **Configurações › Overlay › SSE — Envio de checagem** →
endpoint deste server (`https://seu-host/facts`), login e senha. O botão
**“Enviar checagem”** do overlay valida a checagem com o agente, formata e
envia — o story nasce aqui.
