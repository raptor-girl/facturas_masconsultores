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
type DateOnly = ColumnType<string | Date, string, string>;

export type JsonValue =
  string | number | boolean | null | { [key: string]: JsonValue } | JsonValue[];

export interface AppRoleTable {
  code: 'ADMIN' | 'COORDINATOR';
  label: string;
}

export interface AppUserTable {
  id: Generated<string>;
  display_name: string;
  email: string;
  username: string;
  password_hash: string;
  must_change_password: Generated<boolean>;
  is_active: Generated<boolean>;
  failed_login_count: Generated<number>;
  failed_login_window_started_at: Timestamp | null;
  locked_until: Timestamp | null;
  last_login_at: Timestamp | null;
  password_changed_at: Timestamp | null;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface AppUserRoleTable {
  app_user_id: string;
  role_code: string;
  granted_at: Timestamp;
}

export interface AppSessionTable {
  id: Generated<string>;
  app_user_id: string;
  token_hash: string;
  csrf_token_hash: string;
  created_at: Timestamp;
  last_seen_at: Timestamp;
  idle_expires_at: Timestamp;
  absolute_expires_at: Timestamp;
  revoked_at: Timestamp | null;
  revoked_reason:
    | 'LOGOUT'
    | 'SESSION_REVOKED'
    | 'REVOKE_OTHERS'
    | 'PASSWORD_CHANGED'
    | 'PASSWORD_RESET'
    | 'USER_DEACTIVATED'
    | 'EXPIRED'
    | 'ADMIN_REVOKED'
    | 'SCHEMA_UPGRADE'
    | null;
  ip: string | null;
  user_agent: string | null;
}

export interface LoginAttemptTable {
  id: Generated<string>;
  attempted_at: Timestamp;
  identifier_hash: string;
  app_user_id: string | null;
  succeeded: boolean;
  failure_reason: 'INVALID_CREDENTIALS' | 'INACTIVE' | 'LOCKED' | null;
  request_id: string | null;
  ip: string | null;
  user_agent: string | null;
}

export interface AuditEventTable {
  id: Generated<string>;
  occurred_at: Timestamp;
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
  updated_at: Timestamp;
}

export type TaxTreatment = 'AFFECTED' | 'EXEMPT';
export type DataStatus = 'COMPLETE' | 'PENDING_COMPLETION';
export type DocumentRequirement = 'REQUIRED' | 'OPTIONAL' | 'NOT_APPLICABLE';
export type ExcelTemplateVariant = 'STANDARD' | 'HABITAT';
export type ProjectCenterType = 'ADMINISTRATION_OPERATION' | 'DEVELOPMENT_HOURS' | 'CONSTRUCTION';

export interface IssuerCompanyTable {
  id: Generated<string>;
  code: string;
  legal_name: string;
  tax_id: string;
  business_activity: string;
  address: string;
  is_active: Generated<boolean>;
  default_tax_treatment: TaxTreatment;
  /** NUMERIC(5,4): se conserva exacto como string. */
  default_iva_rate: string;
  created_at: Timestamp;
  updated_at: Timestamp;
  created_by: string | null;
}

export interface CoordinatorProfileTable {
  id: Generated<string>;
  app_user_id: string | null;
  display_name: string;
  email: string | null;
  is_active: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
  created_by: string | null;
}

export interface ClientTable {
  id: Generated<string>;
  short_name: string;
  legal_name: string | null;
  tax_id: string | null;
  business_activity: string | null;
  address: string | null;
  default_coordinator_profile_id: string | null;
  data_status: DataStatus;
  is_active: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
  created_by: string | null;
  updated_by: string | null;
}

export interface ClientInvoiceRuleTable {
  client_id: string;
  purchase_order_requirement: DocumentRequirement;
  hes_requirement: DocumentRequirement;
  contract_requirement: DocumentRequirement;
  supplier_number: string | null;
  default_issuer_company_id: string | null;
  default_tax_treatment: TaxTreatment | null;
  excel_template_variant: ExcelTemplateVariant;
  billing_notes: string | null;
  is_active: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
  created_by: string | null;
  updated_by: string | null;
}

export interface ReceiverTable {
  id: Generated<string>;
  client_id: string;
  display_name: string | null;
  email: string;
  is_active: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
  created_by: string | null;
}

export interface ProductTable {
  id: Generated<string>;
  code: string | null;
  name: string;
  normalized_name: string;
  is_active: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
  created_by: string | null;
}

export interface ProjectCenterTable {
  id: Generated<string>;
  client_id: string;
  product_id: string;
  code: string;
  project_name: string;
  project_center_type: ProjectCenterType;
  is_active: Generated<boolean>;
  created_at: Timestamp;
  updated_at: Timestamp;
  created_by: string | null;
}

export type UfSource = 'sii.cl' | 'mindicador.cl';

export interface UfValueTable {
  id: Generated<string>;
  value_date: DateOnly;
  /** NUMERIC(20,6): el driver debe conservarlo como string. */
  value: string;
  source: UfSource;
  fetched_at: Timestamp;
  created_at: Timestamp;
  updated_at: Timestamp;
  source_reference: string | null;
  metadata: JsonValue | null;
}

export interface Database {
  app_role: AppRoleTable;
  app_user: AppUserTable;
  app_user_role: AppUserRoleTable;
  app_session: AppSessionTable;
  audit_event: AuditEventTable;
  login_attempt: LoginAttemptTable;
  folio_counter: FolioCounterTable;
  issuer_company: IssuerCompanyTable;
  coordinator_profile: CoordinatorProfileTable;
  client: ClientTable;
  client_invoice_rule: ClientInvoiceRuleTable;
  receiver: ReceiverTable;
  product: ProductTable;
  project_center: ProjectCenterTable;
  uf_value: UfValueTable;
}
