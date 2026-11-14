# syntax=docker/dockerfile:1.7
# Realty OS production images (docs/DEPLOY.md). Portable: no hosting vendor assumed.
#
#   docker build --target api -t realty-api .   one image for the API, the worker and the release step
#   docker build --target web -t realty-web .   the static web app behind nginx (proxies /api to the API)
#
#   api:     node apps/api/dist/main.js                 (default command)
#   worker:  node apps/api/dist/worker/main.js
#   release: node packages/db/dist/scripts/release.js   (migrations as the owner role; run before api/worker)
#
# Behind a TLS-intercepting proxy, pass its CA bundle as a build secret:
#   docker build --secret id=ca,src=/path/to/ca.pem ...   (optional; ignored when absent)

ARG NODE_IMAGE=node:22.23.4-bookworm-slim

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /app

# ---- dependencies (cached on the lockfile and manifests only) ----
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/eslint-plugin/package.json packages/eslint-plugin/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    corepack prepare --activate && pnpm install --frozen-lockfile

# ---- build (typecheck + compile every package, then the web bundle and the chat widget's /widget/chat.js) ----
FROM deps AS build
COPY . .
RUN pnpm --filter @realty/core --filter @realty/db --filter @realty/api build \
 && pnpm --filter @realty/web exec vite build \
 && pnpm --filter @realty/web exec vite build -c vite.widget.config.ts

# ---- production dependencies of the API only ----
FROM base AS prod-deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/core/package.json packages/core/
COPY packages/db/package.json packages/db/
COPY packages/eslint-plugin/package.json packages/eslint-plugin/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN --mount=type=secret,id=ca,required=false \
    if [ -f /run/secrets/ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/ca; fi; \
    corepack prepare --activate && pnpm install --frozen-lockfile --prod --filter "@realty/api..."

# ---- api / worker / release runtime ----
FROM ${NODE_IMAGE} AS api
ENV NODE_ENV=production API_HOST=0.0.0.0 API_PORT=3001
WORKDIR /app
COPY --from=prod-deps --chown=root:root /app /app
COPY --from=build /app/packages/core/dist packages/core/dist
COPY --from=build /app/packages/db/dist packages/db/dist
COPY --from=build /app/packages/db/migrations packages/db/migrations
COPY --from=build /app/apps/api/dist apps/api/dist
# the app writes nothing to its own tree. STORAGE_PROVIDER=local writes under STORAGE_DIR: this directory is
# owned by `node` so that a named volume mounted here (docker-compose.prod.yml) starts out writable.
RUN mkdir -p /var/lib/realty/storage && chown node:node /var/lib/realty/storage
USER node
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.API_PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
CMD ["node", "apps/api/dist/main.js"]

# ---- static web app ----
FROM nginx:1.27-alpine AS web
COPY deploy/nginx.conf /etc/nginx/templates/default.conf.template
# generated from apps/web/security-headers.ts (node deploy/render-security-headers.mjs); included by nginx.conf
COPY deploy/security-headers.conf /etc/nginx/snippets/security-headers.conf
COPY deploy/widget-security-headers.conf /etc/nginx/snippets/widget-security-headers.conf
# module 46: the client portal's /portal.html headers (its own CSP), generated the same way
COPY deploy/portal-security-headers.conf /etc/nginx/snippets/portal-security-headers.conf
# the client's address behind the load balancer (set_real_ip_from the private ranges); included by nginx.conf
COPY deploy/real-ip.conf /etc/nginx/snippets/real-ip.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
# source maps are not served publicly (they hold the whole client source); keep them from the build stage if needed
RUN find /usr/share/nginx/html -name '*.map' -delete
# NGINX_RESOLVER: the DNS server nginx uses to re-resolve API_UPSTREAM (Docker's embedded DNS by default)
ENV API_UPSTREAM=api:3001 NGINX_RESOLVER=127.0.0.11
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
