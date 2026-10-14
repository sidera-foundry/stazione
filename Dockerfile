# Stazione, self-hosted: the same app as on Vercel, served by Node on Postgres (see docs/INSTALL.md).
FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app

# Runtime dependencies only, at the versions of the lockfile.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY server.js vercel.json ./
COPY lib ./lib
COPY modules ./modules
COPY modules-custom ./modules-custom
COPY public ./public
COPY client ./client
COPY docs ./docs

USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3000) + '/login').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"
CMD ["node", "server.js"]
