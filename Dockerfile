FROM mcr.microsoft.com/playwright:v1.48.0-jammy
WORKDIR /app

COPY package.json ./
RUN npm pkg set dependencies.playwright=1.48.0 && npm install --omit=dev

COPY . .

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=10000 \
    TEMP_ROOT=/tmp/webcollector \
    HOME=/tmp \
    CHROMIUM_NO_SANDBOX=true \
    TRUST_PROXY=true \
    COOKIE_SECURE=auto \
    MAX_SESSIONS=1 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_OPTIONS="--max-old-space-size=200"

RUN mkdir -p /tmp/webcollector && chown -R 1000:1000 /app /tmp/webcollector
USER 1000
EXPOSE 10000
CMD ["node", "server.js"]
