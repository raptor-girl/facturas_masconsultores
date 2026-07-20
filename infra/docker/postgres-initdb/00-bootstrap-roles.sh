#!/bin/bash
# ═══════════════════════════════════════════════════════════════════════════
# Bootstrap de PostgreSQL — se ejecuta UNA sola vez, al inicializar el volumen.
#
# Es lo único que corre como superusuario. Crea los dos roles y la base; de ahí
# en adelante nadie vuelve a necesitar superusuario:
#
#   factuflow_owner → dueño de la base y del esquema. Sólo migraciones.
#   factuflow_app   → el que usa la aplicación. Permisos mínimos, otorgados
#                     explícitamente por cada migración.
#
# Los permisos finos NO se definen aquí: viven en las migraciones, versionadas
# y revisables. Aquí sólo existe lo que una migración no puede hacer por sí
# misma (CREATE ROLE / CREATE DATABASE).
#
# ⚠️ Si cambias el volumen o los nombres de rol, este script NO se re-ejecuta
# solo. Hay que `docker compose down -v` (npm run docker:reset).
# ═══════════════════════════════════════════════════════════════════════════
set -euo pipefail

: "${FACTUFLOW_OWNER_USER:?falta FACTUFLOW_OWNER_USER}"
: "${FACTUFLOW_OWNER_PASSWORD:?falta FACTUFLOW_OWNER_PASSWORD}"
: "${FACTUFLOW_APP_USER:?falta FACTUFLOW_APP_USER}"
: "${FACTUFLOW_APP_PASSWORD:?falta FACTUFLOW_APP_PASSWORD}"
: "${FACTUFLOW_DB:?falta FACTUFLOW_DB}"

echo "[bootstrap] creando roles ${FACTUFLOW_OWNER_USER} y ${FACTUFLOW_APP_USER}"

# Las contraseñas se pasan como parámetros de psql (:'var'), no interpoladas por
# el shell: así no aparecen en `ps`, ni en el log, ni se rompen con caracteres
# especiales.
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" \
  -v owner_user="$FACTUFLOW_OWNER_USER" \
  -v owner_password="$FACTUFLOW_OWNER_PASSWORD" \
  -v app_user="$FACTUFLOW_APP_USER" \
  -v app_password="$FACTUFLOW_APP_PASSWORD" \
  -v db_name="$FACTUFLOW_DB" <<-'EOSQL'
  -- Rol propietario: crea y modifica el esquema. NO es superusuario.
  CREATE ROLE :"owner_user" WITH LOGIN PASSWORD :'owner_password'
    NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT;

  -- Rol de aplicación: sólo se conecta. Todo lo demás lo otorgan las
  -- migraciones, tabla por tabla.
  CREATE ROLE :"app_user" WITH LOGIN PASSWORD :'app_password'
    NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT;

  CREATE DATABASE :"db_name" OWNER :"owner_user";

  -- Nadie entra por defecto.
  REVOKE ALL ON DATABASE :"db_name" FROM PUBLIC;
  GRANT CONNECT ON DATABASE :"db_name" TO :"app_user";
EOSQL

echo "[bootstrap] listo. Los permisos finos los aplican las migraciones."
