# ═══════════════════════════════════════════════════════════════════════════
# Web — Fase 1: servidor de desarrollo de Vite.
#
# Deliberadamente NO se hace build de producción ni se sirve con nginx: en esta
# fase la web es un scaffold, y un pipeline de assets estáticos sería
# infraestructura para algo que todavía no existe. Cuando el frontend real
# llegue, esta imagen cambia a build + servidor estático.
# ═══════════════════════════════════════════════════════════════════════════
FROM node:22-alpine
WORKDIR /repo

COPY package.json package-lock.json* ./
COPY packages/shared-schemas/package.json packages/shared-schemas/
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
RUN npm ci --workspace @factuflow/web --workspace @factuflow/shared-schemas --include-workspace-root

COPY tsconfig.base.json tsconfig.json ./
COPY packages/shared-schemas packages/shared-schemas
COPY apps/web apps/web
RUN npm run build --workspace @factuflow/shared-schemas

# Vite genera un módulo temporal junto a vite.config.ts al iniciar. El proceso
# corre como `node`, por lo que ese directorio debe ser escribible por el usuario.
RUN chown -R node:node /repo/apps/web

USER node
EXPOSE 5173
WORKDIR /repo/apps/web
CMD ["npm", "run", "dev", "--", "--host", "0.0.0.0"]
