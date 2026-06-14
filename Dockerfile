FROM node:22-slim

# Install dependencies for Puppeteer Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-color-emoji \
    curl \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/*

# Tell Puppeteer to use the installed Chromium
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npx tsc

# Remove devDependencies after build
RUN npm prune --production

EXPOSE 3100

ENV PORT=3100
ENV MAX_CONCURRENT=3

CMD ["node", "dist/server.js"]
