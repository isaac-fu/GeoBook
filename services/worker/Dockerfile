FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/guest-web/package.json ./apps/guest-web/package.json
COPY apps/hotel-web/package.json ./apps/hotel-web/package.json
COPY apps/admin-web/package.json ./apps/admin-web/package.json
COPY services/api/package.json ./services/api/package.json
COPY services/worker/package.json ./services/worker/package.json
RUN npm ci --workspace services/worker --include-workspace-root=false
COPY services/worker ./services/worker
WORKDIR /app/services/worker
RUN npm run build
CMD ["node", "dist/worker.js"]
