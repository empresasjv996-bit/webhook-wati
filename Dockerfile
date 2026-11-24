# =========================================================
# QGC TEAM by JV - painel + Chromium para o extrator automático
# ---------------------------------------------------------
# O runtime nativo do Render não permite instalar pacotes do
# sistema, e sem navegador o extrator não consegue falar com
# o extratorgov.online. Esta imagem instala o Chromium e roda
# o painel em modo headless (veja EXTRATOR-CHROME.md).
# =========================================================

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=10000 \
    TZ=America/Sao_Paulo \
    CHROME_PATH=/usr/bin/chromium \
    EXTRATOR_HEADLESS=1

# Chromium + fontes (nomes com acento) + certificados
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        ca-certificates \
        fonts-liberation \
        fonts-dejavu-core \
        tzdata \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

EXPOSE 10000

# /dev/shm do Docker é pequeno; o extrator já passa --disable-dev-shm-usage
CMD ["node", "index.js"]
