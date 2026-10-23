#!/bin/sh
# Deploy do ray-facts NA VPS Hostinger (179.197.237.166) — padrão da casa:
# container na rede "web" + bloco no Caddyfile compartilhado (TLS automático).
#
# Da sua máquina:
#   ssh root@179.197.237.166 'bash -s' < deploy/hostinger.sh
#
# Idempotente: re-executar puxa o código novo e preserva a senha gerada.
# O Caddy emite o certificado de debatejusto.site automaticamente quando o
# DNS do domínio apontar para o IP da VPS.
set -eu

APP_DIR="/opt/ray-facts"
REPO_URL="https://github.com/LMansoldo/ray-facts.git"
DOMAIN="debatejusto.site"
VPS_IP="${VPS_IP:-179.197.237.166}"

echo "[1/5] código em $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch origin
  git -C "$APP_DIR" reset --hard origin/main
else
  rm -rf "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi

echo "[2/5] .env (senha preservada entre runs)"
if [ -f "$APP_DIR/.env" ] && grep -q '^FACTS_PASS=' "$APP_DIR/.env"; then
  echo "  mantendo FACTS_PASS existente"
else
  PASS="$(openssl rand -hex 16)"
  {
    echo "FACTS_USER=ray"
    echo "FACTS_PASS=$PASS"
  } > "$APP_DIR/.env"
  chmod 600 "$APP_DIR/.env"
fi

echo "[3/5] container (rede web do Caddy)"
docker compose -p ray-facts -f "$APP_DIR/docker-compose.yml" up -d --build
docker image prune -f >/dev/null 2>&1 || true
sleep 1
docker ps --format '{{.Names}}\t{{.Status}}' | grep rayfacts

echo "[4/5] bloco no Caddyfile compartilhado"
CADDYFILE="/opt/caddy/Caddyfile"
if grep -q "^$DOMAIN" "$CADDYFILE"; then
  echo "  bloco já existe — mantendo"
else
  cat >> "$CADDYFILE" <<EOF

# Ray Facts — muro de checagens ao vivo
$DOMAIN, www.$DOMAIN, http://$VPS_IP {
	reverse_proxy rayfacts:3000
}
EOF
fi
docker exec caddy-caddy-1 caddy reload --config /etc/caddy/Caddyfile

echo "[5/5] verificação"
sleep 1
curl -fsS "http://127.0.0.1:3000/health" >/dev/null 2>&1 && echo "  app: ok (3000 direto)" || echo "  app: FALHOU na 3000"
curl -fsS "http://127.0.0.1/health" >/dev/null 2>&1 && echo "  caddy → app: ok" || echo "  caddy → app: FALHOU"

PASS="$(grep '^FACTS_PASS=' "$APP_DIR/.env" | cut -d= -f2)"
echo ""
echo "──────────────────────────────────────────────────────────"
echo " ray-facts:        http://$VPS_IP  (+ https://$DOMAIN quando o DNS apontar)"
echo " Endpoint do Ray:  http://$VPS_IP/facts"
echo " FACTS_USER: ray"
echo " FACTS_PASS: $PASS"
echo " Ray › Configurações › Overlay › SSE — Envio de checagem"
echo "──────────────────────────────────────────────────────────"
