# WebCollector Studio - Optimized for low-RAM Render/Docker
FROM mcr.microsoft.com/playwright:v1.48.0-jammy
WORKDIR /app

COPY package.json ./
RUN npm pkg set dependencies.playwright=1.48.0 && npm install --omit=dev

COPY . .

# মেমোরি বাঁচানোর জন্য Screencast কোয়ালিটি কমানো এবং থ্রোটল করা হয়েছে
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=7860 \
    TEMP_ROOT=/tmp/webcollector \
    HOME=/tmp \
    CHROMIUM_NO_SANDBOX=true \
    TRUST_PROXY=true \
    COOKIE_SECURE=auto \
    MAX_SESSIONS=1 \
    SCREENCAST_QUALITY=35 \
    SCREENCAST_EVERY_NTH=3 \
    MAX_CONCURRENT_COLLECT=2 \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    NODE_OPTIONS="--max-old-space-size=256"

RUN mkdir -p /tmp/webcollector && chown -R 1000:1000 /app /tmp/webcollector
USER 1000
EXPOSE 7860
CMD ["node", "server.js"]
