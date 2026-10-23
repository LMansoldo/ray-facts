#!/bin/sh
# Deploy do ray-facts NA VPS (rodar como root NA PRÓPRIA VPS).
#
# Da sua máquina, quando a VPS estiver ligada e com a porta 22 aberta:
#
#   ssh root@SEU_IP 'FACTS_USER=ray bash -s' < deploy/vps.sh
#
# Ou direto na VPS:
#
#   FACTS_USER=ray sh deploy/vps.sh
#
# O que faz (idempotente — pode rodar de novo para atualizar o código):
#   1. instala Node 20 LTS (apt ou dnf) e git/nginx se faltarem
#   2. clona/puxa o repo em /opt/ray-facts
#   3. cria usuário de sistema rayfacts + /etc/ray-facts.env (chmod 600)
#   4. unit systemd ray-facts.service (Restart=always)
#   5. nginx na porta 80 com proxy SSE-safe (sem buffering em /stream)
#   6. libera 80/443 no firewall (ufw ou firewalld)
#   7. DOMAIN=x.com sh deploy/vps.sh → server_name + certbot --nginx (HTTPS)
#   8. imprime URL + credenciais no fim (a senha vai para o Ray: Configurações
#      › Overlay › SSE — Envio de checagem)
set -eu

REPO_URL="https://github.com/LMansoldo/ray-facts.git"
APP_DIR="/opt/ray-facts"
SERVICE_USER="rayfacts"
BIND_PORT="${PORT:-3000}"
DOMAIN="${DOMAIN:-}"
FACTS_USER="${FACTS_USER:-ray}"
FACTS_PASS="${FACTS_PASS:-}"

if [ -z "$FACTS_PASS" ]; then
  # Preserva a senha gerada em re-runs (o env já existe no disco).
  if [ -f /etc/ray-facts.env ] && grep -q '^FACTS_PASS=' /etc/ray-facts.env; then
    FACTS_PASS="$(grep '^FACTS_PASS=' /etc/ray-facts.env | cut -d= -f2-)"
  else
    FACTS_PASS="$(openssl rand -hex 16 2>/dev/null || head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  fi
fi

echo "[1/7] pacotes"
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -y
  if ! command -v node >/dev/null 2>&1; then
    apt-get install -y curl ca-certificates gnupg
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
  apt-get install -y git nginx openssl
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y nodejs git nginx openssl || dnf module install -y nodejs:20
else
  echo "gerenciador de pacotes não suportado (apt/dnf)" >&2
  exit 1
fi
echo "  node=$(node -v) nginx=$(nginx -v 2>&1 | head -1)"

echo "[2/7] código em $APP_DIR"
if [ -d "$APP_DIR/.git" ]; then
  git -C "$APP_DIR" fetch --all
  git -C "$APP_DIR" reset --hard origin/HEAD 2>/dev/null || git -C "$APP_DIR" reset --hard origin/main
else
  rm -rf "$APP_DIR"
  git clone "$REPO_URL" "$APP_DIR"
fi

echo "[3/7] usuário de sistema + env"
id "$SERVICE_USER" >/dev/null 2>&1 || useradd --system --shell /usr/sbin/nologin "$SERVICE_USER" 2>/dev/null || useradd --system --shell /sbin/nologin "$SERVICE_USER"
cat > /etc/ray-facts.env <<EOF
HOST=127.0.0.1
PORT=$BIND_PORT
FACTS_USER=$FACTS_USER
FACTS_PASS=$FACTS_PASS
NODE_ENV=production
EOF
chmod 600 /etc/ray-facts.env
chown -R "$SERVICE_USER": "$APP_DIR"

echo "[4/7] systemd ray-facts.service"
cat > /etc/systemd/system/ray-facts.service <<EOF
[Unit]
Description=Ray Facts — muro de checagens ao vivo (SSE)
After=network-online.target
Wants=network-online.target

[Service]
User=$SERVICE_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/ray-facts.env
ExecStart=$(command -v node) server/src/index.js
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now ray-facts
sleep 1
systemctl is-active ray-facts

echo "[5/7] nginx (proxy com SSE sem buffering)"
SERVER_BLOCK="server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;
    client_max_body_size 1m;

    location / {
        proxy_pass http://127.0.0.1:$BIND_PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
    }

    # SSE: sem buffering e timeout longo para o stream não morrer.
    location /stream {
        proxy_pass http://127.0.0.1:$BIND_PORT;
        proxy_http_version 1.1;
        proxy_set_header Connection \"\";
        proxy_buffering off;
        proxy_cache off;
        proxy_read_timeout 24h;
        chunked_transfer_encoding off;
    }
}"
if [ -d /etc/nginx/sites-available ]; then
  printf '%s\n' "$SERVER_BLOCK" > /etc/nginx/sites-available/ray-facts
  ln -sf /etc/nginx/sites-available/ray-facts /etc/nginx/sites-enabled/ray-facts
  rm -f /etc/nginx/sites-enabled/default
else
  printf '%s\n' "$SERVER_BLOCK" > /etc/nginx/conf.d/ray-facts.conf
fi
nginx -t
systemctl enable --now nginx 2>/dev/null || systemctl restart nginx
systemctl reload nginx

echo "[6/7] firewall"
if command -v ufw >/dev/null 2>&1; then
  ufw allow 80/tcp >/dev/null 2>&1 || true
  ufw allow 443/tcp >/dev/null 2>&1 || true
  ufw status | grep -q "Status: active" && ufw reload >/dev/null 2>&1 || true
elif command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --permanent --add-service=http >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-service=https >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
fi

echo "[7/7] verificação"
sleep 1
curl -fsS "http://127.0.0.1:$BIND_PORT/health" && echo " (app direto)"
curl -fsS "http://127.0.0.1/health" && echo " (via nginx)"

if [ -n "$DOMAIN" ] && command -v certbot >/dev/null 2>&1; then
  echo "certbot para $DOMAIN"
  certbot --nginx -d "$DOMAIN" --non-interactive --agree-tos -m "admin@$DOMAIN" || \
    echo "  certbot falhou (DNS ainda não aponta pra cá?) — rode de novo quando resolver"
elif [ -n "$DOMAIN" ]; then
  echo "  (DOMAIN definido mas certbot ausente — instale certbot python3-certbot-nginx e rode de novo)"
fi

SERVER_IP="$(curl -fsS -m 5 --connect-timeout 3 ifconfig.me 2>/dev/null || hostname -I | awk '{print $1}')"
SCHEME="http"
[ -n "$DOMAIN" ] && SCHEME="https"
BASE="${DOMAIN:-$SERVER_IP}"
echo ""
echo "──────────────────────────────────────────────────────"
echo " ray-facts no ar:  $SCHEME://$BASE"
echo " Endpoint p/ o Ray: $SCHEME://$BASE/facts"
echo " FACTS_USER: $FACTS_USER"
echo " FACTS_PASS: $FACTS_PASS"
echo " Configure no Ray: Configurações › Overlay › SSE — Envio de checagem"
echo "──────────────────────────────────────────────────────"
