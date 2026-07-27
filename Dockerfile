FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contract/package.json packages/contract/package.json
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY openapi openapi
COPY scripts scripts
COPY packages packages
COPY src src
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ARG SERVICE_VERSION=1.0.0
ARG GIT_SHA=unknown
ENV NODE_ENV=production \
    SERVICE_VERSION=${SERVICE_VERSION} \
    GIT_SHA=${GIT_SHA} \
    GAME_MANAGE_KIT_PUBLIC_HOST=0.0.0.0 \
    GAME_MANAGE_KIT_INTERNAL_HOST=0.0.0.0
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contract/package.json packages/contract/package.json
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/packages/contract/dist ./packages/contract/dist
COPY config ./config
COPY migrations ./migrations
COPY web ./web
COPY scripts/docker-smoke.mjs ./scripts/docker-smoke.mjs
EXPOSE 2570 2571
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:2570/readyz').then((response)=>{if(!response.ok)process.exit(1)}).catch(()=>process.exit(1))"]
USER node
CMD ["node", "dist/main.js"]
