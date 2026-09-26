FROM node:22-bookworm-slim
WORKDIR /app
ENV NODE_ENV=development
ARG INSTALL_DOCKER_CLI=false
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates git openssl \
  && if [ "$INSTALL_DOCKER_CLI" = "true" ]; then apt-get install -y --no-install-recommends docker.io; fi \
  && rm -rf /var/lib/apt/lists/*
COPY package*.json ./
RUN npm ci
COPY prisma ./prisma
COPY prisma7.config.ts ./
RUN npx prisma generate
ENV NODE_ENV=production
COPY . .
RUN mkdir -p /app/generated
EXPOSE 5000
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s CMD node -e "fetch('http://127.0.0.1:5000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.js"]
