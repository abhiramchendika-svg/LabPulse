# ---- build: install everything, build shared + web + gateway
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json .npmrc tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/gateway/package.json apps/gateway/
COPY apps/web/package.json apps/web/
RUN npm ci --no-audit --no-fund
COPY packages packages
COPY apps apps
RUN npm run build && npm prune --omit=dev --no-audit --no-fund

# ---- runtime: only what the server needs
FROM node:22-bookworm-slim
ENV NODE_ENV=production PORT=8080
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules node_modules
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/apps/gateway/package.json apps/gateway/
COPY --from=build /app/apps/gateway/dist apps/gateway/dist
COPY --from=build /app/apps/web/dist apps/web/dist
COPY exercises exercises
USER node
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8080/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "apps/gateway/dist/index.js"]
