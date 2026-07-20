import type {
  AppRole,
  CreateUserRequest,
  PublicUser,
  Session,
  UpdateRolesRequest,
  UpdateUserRequest,
} from '@factuflow/shared-schemas';

export interface RequestContext {
  readonly requestId: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
}

export interface AuthenticatedSession {
  readonly user: PublicUser;
  readonly sessionId: string;
  readonly csrfTokenHash: string;
}

export interface LoginResult {
  readonly user: PublicUser;
  readonly sessionToken: string;
  readonly csrfToken: string;
}

export interface TemporaryPasswordResult {
  readonly user: PublicUser;
  readonly temporaryPassword: string;
}

export interface AuditSummary {
  readonly id: string;
  readonly occurredAt: string;
  readonly actorUserId: string | null;
  readonly actorRoles: AppRole[] | null;
  readonly action: string;
  readonly entity: string;
  readonly entityId: string | null;
  readonly result: 'success' | 'failure';
  readonly requestId: string | null;
  readonly reason: string | null;
}

export interface IdentityService {
  login(identifier: string, password: string, context: RequestContext): Promise<LoginResult>;
  authenticate(sessionToken: string, context: RequestContext): Promise<AuthenticatedSession | null>;
  verifyCsrf(auth: AuthenticatedSession, csrfToken: string | undefined): boolean;
  logout(auth: AuthenticatedSession, context: RequestContext): Promise<void>;
  changePassword(
    auth: AuthenticatedSession,
    currentPassword: string,
    newPassword: string,
    context: RequestContext,
  ): Promise<void>;
  listOwnSessions(auth: AuthenticatedSession): Promise<Session[]>;
  revokeOwnSession(
    auth: AuthenticatedSession,
    sessionId: string,
    context: RequestContext,
  ): Promise<void>;
  revokeOtherSessions(auth: AuthenticatedSession, context: RequestContext): Promise<void>;

  listUsers(search?: string, active?: boolean): Promise<PublicUser[]>;
  getUser(userId: string): Promise<PublicUser>;
  createUser(
    actor: AuthenticatedSession,
    input: CreateUserRequest,
    context: RequestContext,
  ): Promise<TemporaryPasswordResult>;
  updateUser(
    actor: AuthenticatedSession,
    userId: string,
    input: UpdateUserRequest,
    context: RequestContext,
  ): Promise<PublicUser>;
  setUserActive(
    actor: AuthenticatedSession,
    userId: string,
    active: boolean,
    context: RequestContext,
  ): Promise<PublicUser>;
  resetPassword(
    actor: AuthenticatedSession,
    userId: string,
    context: RequestContext,
  ): Promise<TemporaryPasswordResult>;
  listUserSessions(userId: string): Promise<Session[]>;
  revokeAllUserSessions(
    actor: AuthenticatedSession,
    userId: string,
    context: RequestContext,
  ): Promise<void>;
  updateRoles(
    actor: AuthenticatedSession,
    userId: string,
    input: UpdateRolesRequest,
    context: RequestContext,
  ): Promise<PublicUser>;
  listAuthAudit(): Promise<AuditSummary[]>;
}
