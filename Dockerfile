# QuickBooks Online MCP Server — HTTP transport image for Azure Container Apps.
# Multi-stage: compile TypeScript, then ship a lean production runtime.

# ---- build stage ----
FROM node:20-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# ---- runtime stage ----
FROM node:20-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts

COPY --from=build /app/dist ./dist

# Container Apps sets PORT; default to 3000 for local runs.
ENV PORT=3000
EXPOSE 3000

# Run as the built-in non-root node user.
USER node

CMD ["node", "dist/http-server.js"]
