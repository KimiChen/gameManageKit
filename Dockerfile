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
    GIT_SHA=${GIT_SHA}
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/contract/package.json packages/contract/package.json
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
COPY --from=build /app/packages/contract/dist ./packages/contract/dist
COPY config ./config
COPY migrations ./migrations
USER node
CMD ["node", "dist/main.js"]
