FROM node:22-alpine AS build
WORKDIR /app
ARG WORKSPACE=apps/guest-web

# Resolve the guest workspace from the shared, committed lockfile.
COPY package.json package-lock.json ./
COPY apps/guest-web/package.json ./apps/guest-web/package.json
COPY apps/hotel-web/package.json ./apps/hotel-web/package.json
COPY apps/admin-web/package.json ./apps/admin-web/package.json
COPY services/api/package.json ./services/api/package.json
COPY services/worker/package.json ./services/worker/package.json
RUN npm ci --workspace apps/guest-web --workspace apps/hotel-web --workspace apps/admin-web --include-workspace-root=false
COPY apps ./apps
RUN npm --workspace ${WORKSPACE} run build && cp -r ${WORKSPACE}/dist /app/site

FROM nginx:1.28-alpine AS runtime
COPY apps/guest-web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/site /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
