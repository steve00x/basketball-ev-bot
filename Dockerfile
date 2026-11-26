# Both bots in one image. Chromium comes from Debian (Puppeteer drives it for Betika).
# Build: docker compose build     Run: docker compose up -d     (see "Run it 24/7" in README.md)
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends chromium fonts-liberation ca-certificates tzdata \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PUPPETEER_SKIP_DOWNLOAD=true \
    CHROME_PATH=/usr/bin/chromium \
    BETIKA_HEADLESS=true

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY bin ./bin
COPY src ./src
COPY sample_data ./sample_data

# Everything the bots write (bet log, trade journal, Betika login) lives in /app/data
RUN mkdir -p /app/data && chown -R node:node /app/data
USER node
ENV STORE_PATH=/app/data/ev-bot-store.json \
    BETIKA_SESSION_DIR=/app/data/.betika-session \
    DERIV_JOURNAL=/app/data/deriv-trades.jsonl \
    DERIV_STATUS_FILE=/app/data/deriv-status.json
VOLUME /app/data

CMD ["node", "bin/deriv-bot.js", "run"]
