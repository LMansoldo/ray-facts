# Ray Facts — imagem de produção (VPS Hostinger, atrás do Caddy compartilhado).
# Zero dependências: o server é node:http puro — nada de npm install.
FROM node:22-alpine

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY web ./web

# build sem cache de camadas grandes: o app não tem node_modules.
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "server/src/index.js"]
