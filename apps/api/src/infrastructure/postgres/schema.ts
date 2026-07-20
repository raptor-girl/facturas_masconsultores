import type { Generated, ColumnType } from 'kysely';

/**
 * Tipos de la base para Kysely — Fase 1 únicamente.
 *
 * Solo las tablas de fundación. `invoice_request`, `client`, `receiver`,
 * `project_center` y `product` NO están aquí a propósito: están fuera del
 * alcance aprobado y no se adelantan con supuestos.
 *
 * Convención de tipos monetarios: cuando lleguen (Fase 3+), toda columna
 * NUMERIC se declara `string` en este archivo, nunca `number`. Kysely no
 * convierte nada por sí mismo: refleja lo que entrega el driver, y el driver
 * entrega string. Ver numeric-guard.ts.
 */

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export type JsonValue =
  string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];

export interface AppRoleTable {
  code: string;
  label: string;
}

export interface AppUserTable {
  id: Generated<string>;
  full_name: string;
  email: string;
  username: string | null;
  password_hash: string;
  must_change_password: Generated<boolean>;
  is_active: Generated<boolean>;
  created_at: Generated<Timestamp>;
  updated_at: Generated<Timestamp>;
}

export interface AppUserRoleTable {
  app_user_id: string;
  role_code: string;
  granted_at: Generated<Timestamp>;
}

export interface AppSessionTable {
  id: Generated<string>;
  app_user_id: string;
  token_hash: string;
  issued_at: Generated<Timestamp>;
  expires_at: Timestamp;
  revoked_at: Timestamp | null;
  ip: string | null;
  user_agent: string | null;
}

export interface AuditEventTable {
  id: Generated<string>;
  occurred_at: Generated<Timestamp>;
  app_user_id: string | null;
  actor_roles: string[] | null;
  action: string;
  entity: string;
  entity_id: string | null;
  result: 'success' | 'failure';
  request_id: string | null;
  ip: string | null;
  user_agent: string | null;
  reason: string | null;
  // `unknown | null` colapsa a `unknown` y no aporta nada. JsonValue expresa
  // lo que JSONB realmente admite.
  changes_before: JsonValue | null;
  changes_after: JsonValue | null;
  metadata: JsonValue | null;
}

export interface FolioCounterTable {
  year: number;
  /** INTEGER, no NUMERIC: es un correlativo, no dinero. Cabe en number sin riesgo. */
  last_value: Generated<number>;
  updated_at: Generated<Timestamp>;
}

export interface Database {
  app_role: AppRoleTable;
  app_user: AppUserTable;
  app_user_role: AppUserRoleTable;
  app_session: AppSessionTable;
  audit_event: AuditEventTable;
  folio_counter: FolioCounterTable;
}
