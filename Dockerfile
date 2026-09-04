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
#
# ⚠ These are MARIADB's tools, not Oracle MySQL's — Alpine has no Oracle client
# in its repos, and `mysqldump` here is a symlink to `mariadb-dump`. Our SERVERS
# are MySQL 8 (the schema uses utf8mb4_0900_ai_ci, a MySQL-8-only collation), so
# client and server are different lineages. Two consequences:
#   1. MySQL-only dump flags are rejected at ARG-PARSE time, before connecting —
#      see the flag list in dumpFromReplica().
#   2. MariaDB's client cannot do MySQL 8's default `caching_sha2_password`
#      auth. The dump user must therefore be created with
#      `IDENTIFIED WITH mysql_native_password`, or the connection fails.
# If either becomes limiting, the fix is a Debian base + Oracle's MySQL APT repo
# — a heavier change, deliberately deferred until something actually needs it.
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
# The commit this image was built from, surfaced by GET /api/health.
#
# WHY: verifying a deploy previously meant inferring it from `uptime` — "the
# process restarted about two minutes after I pushed, so it is probably the new
# code". That is a correlation, not an answer, and it is unavailable the moment
# anything else restarts the container. A SHA in the health payload turns
# "did my change ship?" into one GET.
#
# Build ARG rather than a file read at runtime: the image has no .git, and
# baking it at build time means the value cannot drift from the layers beside
# it. Defaults to 'unknown' so a local `docker build` with no --build-arg still
# works and says so honestly rather than claiming a commit it does not have.
ARG GIT_COMMIT=unknown

ENV NODE_ENV=production \
    PORT=5100 \
    GIT_COMMIT=${GIT_COMMIT}

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
