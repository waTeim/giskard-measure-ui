# Giskard Monitor — base runtime image
#
# Ships the prebuilt single-file UI (public/index.html) and the zero-dependency
# Node server. No build step or npm install is required at image-build time.

FROM node:20-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

WORKDIR /app

# Server + prebuilt static UI. (package.json has no dependencies, so no install.)
COPY package.json ./
COPY server.js ./
COPY public ./public

# Run as the unprivileged user that ships with the node image.
USER node

EXPOSE 8080

# Liveness: the process is up and serving. (node:20 ships a global fetch.)
HEALTHCHECK --interval=30s --timeout=4s --start-period=5s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.js"]
