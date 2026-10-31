# Node + Fastify backend with yt-dlp, ffmpeg and Deno (yt-dlp uses a JS runtime for YouTube challenges).
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY tsconfig*.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ffmpeg ca-certificates curl unzip \
 && curl -fsSL https://deno.land/install.sh -o /tmp/install-deno.sh \
 && DENO_INSTALL=/usr/local sh /tmp/install-deno.sh \
 && python3 -m venv /opt/yt-dlp-venv \
 && /opt/yt-dlp-venv/bin/pip install --no-cache-dir --upgrade pip "yt-dlp[default]" \
 && ln -s /opt/yt-dlp-venv/bin/yt-dlp /usr/local/bin/yt-dlp \
 && rm -rf /var/lib/apt/lists/* /tmp/install-deno.sh
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./

RUN mkdir -p /app/data /tmp/vidfetch \
    && chown -R node:node /app/data /tmp/vidfetch

ENV DATA_DIR=/app/data
ENV TMP_DIR=/tmp/vidfetch

USER node
EXPOSE 4000
CMD ["node", "dist/server.js"]