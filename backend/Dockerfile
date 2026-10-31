
# Build the Fastify backend
FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig*.json ./
COPY src ./src

RUN npm run build && npm prune --omit=dev


# Production image
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Install system dependencies, Deno, Python and yt-dlp
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
    python3 \
    python3-venv \
    ffmpeg \
    ca-certificates \
    curl \
    git \
    unzip \
 && curl -fsSL https://deno.land/install.sh -o /tmp/install-deno.sh \
 && DENO_INSTALL=/usr/local sh /tmp/install-deno.sh \
 && python3 -m venv /opt/yt-dlp-venv \
 && /opt/yt-dlp-venv/bin/pip install --no-cache-dir --upgrade pip \
    "yt-dlp[default]" \
    bgutil-ytdlp-pot-provider \
 && ln -s /opt/yt-dlp-venv/bin/yt-dlp /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/* /tmp/install-deno.sh


# Install and build the PO Token HTTP provider
# Version 2.0.2 is used to keep the provider and plugin setup consistent.
RUN git clone --depth 1 --single-branch --branch 2.0.2 \
    https://github.com/Brainicism/bgutil-ytdlp-pot-provider.git \
    /opt/bgutil-ytdlp-pot-provider \
 && cd /opt/bgutil-ytdlp-pot-provider/server \
 && npm ci --include=dev --no-audit --no-fund \
 && ./node_modules/.bin/tsc


# Copy compiled Fastify backend
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./


# Create application directories
RUN mkdir -p /app/data /tmp/vidfetch \
 && chown -R node:node /app/data /tmp/vidfetch

ENV DATA_DIR=/app/data
ENV TMP_DIR=/tmp/vidfetch

USER node

EXPOSE 4000

# Start the PO Token provider privately, then start Fastify.
CMD ["sh", "-c", "node /opt/bgutil-ytdlp-pot-provider/server/build/main.js --host 127.0.0.1 --port 4416 & exec node dist/server.js"]
