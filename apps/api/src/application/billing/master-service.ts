import type {
  Client,
  ClientDetail,
  CoordinatorProfile,
  CreateClient,
  CreateCoordinator,
  CreateIssuerCompany,
  CreateProduct,
  CreateProjectCenter,
  CreateReceiver,
  InvoiceRule,
  IssuerCompany,
  MasterListQuery,
  Product,
  ProjectCenter,
  PutInvoiceRule,
  Receiver,
  UpdateClient,
  UpdateCoordinator,
  UpdateIssuerCompany,
  UpdateProduct,
  UpdateProjectCenter,
  UpdateReceiver,
} from '@factuflow/shared-schemas';
import type { AuthenticatedSession, RequestContext } from '../auth/identity-service.js';

export interface Page<T> {
  readonly items: T[];
  readonly page: number;
  readonly pageSize: number;
  readonly total: number;
}

export interface MasterService {
  listIssuerCompanies(query: MasterListQuery): Promise<Page<IssuerCompany>>;
  getIssuerCompany(id: string): Promise<IssuerCompany>;
  createIssuerCompany(
    actor: AuthenticatedSession,
    input: CreateIssuerCompany,
    context: RequestContext,
  ): Promise<IssuerCompany>;
  updateIssuerCompany(
    actor: AuthenticatedSession,
    id: string,
    input: UpdateIssuerCompany,
    context: RequestContext,
  ): Promise<IssuerCompany>;
  setIssuerCompanyActive(
    actor: AuthenticatedSession,
    id: string,
    active: boolean,
    context: RequestContext,
  ): Promise<IssuerCompany>;

  listCoordinators(query: MasterListQuery): Promise<Page<CoordinatorProfile>>;
  getCoordinator(id: string): Promise<CoordinatorProfile>;
  createCoordinator(
    actor: AuthenticatedSession,
    input: CreateCoordinator,
    context: RequestContext,
  ): Promise<CoordinatorProfile>;
  updateCoordinator(
    actor: AuthenticatedSession,
    id: string,
    input: UpdateCoordinator,
    context: RequestContext,
  ): Promise<CoordinatorProfile>;
  setCoordinatorActive(
    actor: AuthenticatedSession,
    id: string,
    active: boolean,
    context: RequestContext,
  ): Promise<CoordinatorProfile>;
  linkCoordinatorUser(
    actor: AuthenticatedSession,
    id: string,
    appUserId: string | null,
    context: RequestContext,
  ): Promise<CoordinatorProfile>;

  listClients(query: MasterListQuery): Promise<Page<Client>>;
  getClient(id: string): Promise<ClientDetail>;
  createClient(
    actor: AuthenticatedSession,
    input: CreateClient,
    context: RequestContext,
  ): Promise<ClientDetail>;
  updateClient(
    actor: AuthenticatedSession,
    id: string,
    input: UpdateClient,
    context: RequestContext,
  ): Promise<ClientDetail>;
  setClientActive(
    actor: AuthenticatedSession,
    id: string,
    active: boolean,
    context: RequestContext,
  ): Promise<ClientDetail>;
  putInvoiceRule(
    actor: AuthenticatedSession,
    clientId: string,
    input: PutInvoiceRule,
    context: RequestContext,
  ): Promise<InvoiceRule>;

  listReceivers(clientId: string, query: MasterListQuery): Promise<Page<Receiver>>;
  createReceiver(
    actor: AuthenticatedSession,
    clientId: string,
    input: CreateReceiver,
    context: RequestContext,
  ): Promise<Receiver>;
  updateReceiver(
    actor: AuthenticatedSession,
    id: string,
    input: UpdateReceiver,
    context: RequestContext,
  ): Promise<Receiver>;
  setReceiverActive(
    actor: AuthenticatedSession,
    id: string,
    active: boolean,
    context: RequestContext,
  ): Promise<Receiver>;

  listProducts(query: MasterListQuery): Promise<Page<Product>>;
  getProduct(id: string): Promise<Product>;
  createProduct(
    actor: AuthenticatedSession,
    input: CreateProduct,
    context: RequestContext,
  ): Promise<Product>;
  updateProduct(
    actor: AuthenticatedSession,
    id: string,
    input: UpdateProduct,
    context: RequestContext,
  ): Promise<Product>;
  setProductActive(
    actor: AuthenticatedSession,
    id: string,
    active: boolean,
    context: RequestContext,
  ): Promise<Product>;

  listProjectCenters(clientId: string, query: MasterListQuery): Promise<Page<ProjectCenter>>;
  getProjectCenter(id: string): Promise<ProjectCenter>;
  createProjectCenter(
    actor: AuthenticatedSession,
    clientId: string,
    input: CreateProjectCenter,
    context: RequestContext,
  ): Promise<ProjectCenter>;
  updateProjectCenter(
    actor: AuthenticatedSession,
    id: string,
    input: UpdateProjectCenter,
    context: RequestContext,
  ): Promise<ProjectCenter>;
  setProjectCenterActive(
    actor: AuthenticatedSession,
    id: string,
    active: boolean,
    context: RequestContext,
  ): Promise<ProjectCenter>;
}
