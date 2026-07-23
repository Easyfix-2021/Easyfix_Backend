# EasyFix_Backend — production image
#
# Single-stage build because the backend is plain JavaScript (no compile
# step). We trade a few hundred MB of npm cache for a much simpler image
# that's easier to debug — `docker exec` lands in a familiar Node layout.
#
# Image size target: ~250 MB. If that becomes a problem, switch to a
# two-stage builder/runner with `npm ci --omit=dev` only in the runner.
#
# Built by .github/workflows/deploy.yml and pushed to ECR. Run via the
# docker-compose.yml on the EC2 (see deploy/docker-compose.yml).

FROM node:20-alpine

# Smaller image + non-root user for runtime hardening. node:20-alpine
# already has a `node` user (uid 1000) — we use it instead of root.
# mariadb-client supplies `mysqldump` + `mysql`, used ONLY by the QA database
# refresh job (services/qa-db-refresh.service.js). It ships in the production
# image too — one Dockerfile serves both — which is precisely why that job's
# first guard is `ENVIRONMENT === 'qa'`: the binaries existing on a prod box must
# never mean the job can run there.
RUN apk add --no-cache tini curl mariadb-client \
    && mkdir -p /app /app/uploads /app/dbdumps \
    && chown -R node:node /app

WORKDIR /app
USER node

# Install production deps first so layer cache survives source edits.
# Bind-mount style: we copy package files only, run npm ci, then copy
# the rest. A code change won't bust this layer.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev \
    && npm cache clean --force

# Application source.
COPY --chown=node:node . .

# Tell PM2-less runtime + Express to listen on 0.0.0.0:5100. The compose
# file maps host:5100 → container:5100.
ENV NODE_ENV=production \
    PORT=5100

EXPOSE 5100

# Container-level health check — Docker / compose can read this and mark
# the service "unhealthy" if the API stops responding. The route is
# JWT-free and DB-free; it just confirms the process is up.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS http://127.0.0.1:5100/api/health || exit 1

# Tini = PID-1 reaper. Without it, signals (docker stop) don't propagate
# cleanly to Node and the container takes 10s to exit.
ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
