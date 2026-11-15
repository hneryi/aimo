# Aimo: one small Node container (API + MCP + static web UI). TypeScript runs through tsx, no build step.
FROM node:22-slim
ENV NODE_ENV=production PORT=8787
WORKDIR /app/server
COPY server/package.json server/package-lock.json ./
RUN npm ci --no-audit --no-fund && npm cache clean --force
WORKDIR /app
COPY shared ./shared
COPY server/src ./server/src
COPY server/tsconfig.json ./server/
COPY web/dist ./web/dist
COPY demo ./demo
COPY docs ./docs
RUN mkdir -p /app/data && chown node:node /app/data
USER node
WORKDIR /app/server
EXPOSE 8787
HEALTHCHECK --interval=20s --timeout=4s --start-period=20s CMD node -e "fetch('http://127.0.0.1:8787/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "src/index.ts"]
