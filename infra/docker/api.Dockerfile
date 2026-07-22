# ═══════════════════════════════════════════════════════════════════════════
# API — build multi-etapa.
#
# El contexto es la RAÍZ del monorepo (ver docker-compose.yml): npm workspaces
# resuelve @factuflow/shared-schemas por enlace, así que el paquete debe estar
# presente al instalar. Construir sólo desde apps/api fallaría.
# ═══════════════════════════════════════════════════════════════════════════

# ── deps ───────────────────────────────────────────────────────────────────
FROM node:22-alpine AS deps
WORKDIR /repo
# Sólo los manifiestos primero: así la capa de node_modules se reutiliza
# mientras no cambien las dependencias.
COPY package.json package-lock.json* ./
COPY packages/shared-schemas/package.json packages/shared-schemas/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @factuflow/api --workspace @factuflow/shared-schemas --include-workspace-root

# ── build ──────────────────────────────────────────────────────────────────
FROM deps AS build
WORKDIR /repo
COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared-schemas packages/shared-schemas
COPY apps/api apps/api
RUN npm run build --workspace @factuflow/shared-schemas \
 && npm run build --workspace @factuflow/api

# ── runtime ────────────────────────────────────────────────────────────────
FROM node:22-alpine AS runtime
WORKDIR /repo
ENV NODE_ENV=production

# Sin dependencias de desarrollo en la imagen final.
COPY package.json package-lock.json* ./
COPY packages/shared-schemas/package.json packages/shared-schemas/
COPY apps/api/package.json apps/api/
RUN npm ci --omit=dev --workspace @factuflow/api --workspace @factuflow/shared-schemas --include-workspace-root \
 && npm cache clean --force

COPY --from=build /repo/packages/shared-schemas/dist packages/shared-schemas/dist
COPY --from=build /repo/apps/api/dist apps/api/dist
COPY templates/approved/solicitud-factura-soprole-clone-v1.xlsx templates/approved/
# Las migraciones viajan en la imagen para poder ejecutarlas desde el
# contenedor si hiciera falta — pero NUNCA se aplican solas al arrancar.
COPY apps/api/migrations apps/api/migrations
COPY apps/api/.migrationrc.json apps/api/

# `node` ya existe en la imagen oficial y no es root. Un API que corre como root
# no tiene ninguna razón para hacerlo.
USER node
EXPOSE 3000
WORKDIR /repo/apps/api
CMD ["node", "dist/index.js"]
