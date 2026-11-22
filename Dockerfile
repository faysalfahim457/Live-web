# WebCollector Studio (Node edition) for Hugging Face Spaces (Docker SDK) or any Docker host.
FROM mcr.microsoft.com/playwright:v1.48.0-jammy
WORKDIR /app
COPY package.json ./
# Pin playwright to the exact version the base image ships browsers for.
RUN npm pkg set dependencies.playwright=1.48.0 && npm install --omit=dev
COPY . .
ENV NODE_ENV=production HOST=0.0.0.0 PORT=7860 TEMP_ROOT=/tmp/webcollector HOME=/tmp \
    CHROMIUM_NO_SANDBOX=true TRUST_PROXY=true COOKIE_SECURE=auto MAX_SESSIONS=2 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
# Hugging Face runs containers as UID 1000
RUN mkdir -p /tmp/webcollector && chown -R 1000:1000 /app /tmp/webcollector
USER 1000
EXPOSE 7860
CMD ["node", "server.js"]
