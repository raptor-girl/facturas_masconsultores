import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import {
  clientIdParamsSchema,
  clientResponseSchema,
  clientsPageSchema,
  coordinatorResponseSchema,
  coordinatorsPageSchema,
  coordinatorUserLinkSchema,
  createClientSchema,
  createCoordinatorSchema,
  createIssuerCompanySchema,
  createProductSchema,
  createProjectCenterSchema,
  createReceiverSchema,
  invoiceRuleResponseSchema,
  issuerCompaniesPageSchema,
  issuerCompanyResponseSchema,
  masterListQuerySchema,
  productResponseSchema,
  productsPageSchema,
  projectCenterResponseSchema,
  projectCentersPageSchema,
  putInvoiceRuleSchema,
  receiverResponseSchema,
  receiversPageSchema,
  updateClientSchema,
  updateCoordinatorSchema,
  updateIssuerCompanySchema,
  updateProductSchema,
  updateProjectCenterSchema,
  updateReceiverSchema,
  uuidParamsSchema,
  type MasterListQuery,
} from '@factuflow/shared-schemas';
import type { Env } from '../../../config/env.js';
import type { IdentityService } from '../../../application/auth/identity-service.js';
import type { MasterService } from '../../../application/billing/master-service.js';
import { AppError } from '../../../application/errors.js';
import {
  requestContext,
  requireAuthentication,
  requireCsrf,
  requirePasswordChanged,
  requireRole,
} from '../auth-guards.js';

interface Options {
  readonly env: Env;
  readonly identity: IdentityService;
  readonly masters: MasterService;
}

export function registerBillingMasterRoutes(
  app: FastifyInstance,
  { env, identity, masters }: Options,
): void {
  const typed = app.withTypeProvider<ZodTypeProvider>();
  const reader = async (request: FastifyRequest) => {
    const auth = await requireAuthentication(request, identity, env);
    requirePasswordChanged(auth);
    if (!auth.user.roles.some((role) => role === 'ADMIN' || role === 'COORDINATOR'))
      throw new AppError('FORBIDDEN', 'No tiene permisos para esta operación.', 403);
    return auth;
  };
  const admin = async (request: FastifyRequest) => {
    const auth = await reader(request);
    requireRole(auth, 'ADMIN');
    requireCsrf(request, identity, auth);
    return auth;
  };

  typed.route({
    method: 'GET',
    url: '/issuer-companies',
    schema: {
      tags: ['maestros'],
      querystring: masterListQuerySchema,
      response: { 200: issuerCompaniesPageSchema },
    },
    handler: async (request) => {
      await reader(request);
      return masters.listIssuerCompanies(request.query);
    },
  });
  typed.route({
    method: 'GET',
    url: '/issuer-companies/:id',
    schema: {
      tags: ['maestros'],
      params: uuidParamsSchema,
      response: { 200: issuerCompanyResponseSchema },
    },
    handler: async (request) => {
      await reader(request);
      return { issuerCompany: await masters.getIssuerCompany(request.params.id) };
    },
  });
  typed.route({
    method: 'POST',
    url: '/admin/issuer-companies',
    schema: {
      tags: ['administración'],
      body: createIssuerCompanySchema,
      response: { 201: issuerCompanyResponseSchema },
    },
    handler: async (request, reply) => {
      const auth = await admin(request);
      const issuerCompany = await masters.createIssuerCompany(
        auth,
        request.body,
        requestContext(request),
      );
      return reply.status(201).send({ issuerCompany });
    },
  });
  typed.route({
    method: 'PATCH',
    url: '/admin/issuer-companies/:id',
    schema: {
      tags: ['administración'],
      params: uuidParamsSchema,
      body: updateIssuerCompanySchema,
      response: { 200: issuerCompanyResponseSchema },
    },
    handler: async (request) => {
      const auth = await admin(request);
      return {
        issuerCompany: await masters.updateIssuerCompany(
          auth,
          request.params.id,
          request.body,
          requestContext(request),
        ),
      };
    },
  });
  for (const active of [true, false])
    typed.route({
      method: 'POST',
      url: `/admin/issuer-companies/:id/${active ? 'activate' : 'deactivate'}`,
      schema: {
        tags: ['administración'],
        params: uuidParamsSchema,
        response: { 200: issuerCompanyResponseSchema },
      },
      handler: async (request) => {
        const auth = await admin(request);
        return {
          issuerCompany: await masters.setIssuerCompanyActive(
            auth,
            request.params.id,
            active,
            requestContext(request),
          ),
        };
      },
    });

  typed.route({
    method: 'GET',
    url: '/coordinators',
    schema: {
      tags: ['maestros'],
      querystring: masterListQuerySchema,
      response: { 200: coordinatorsPageSchema },
    },
    handler: async (request) => {
      await reader(request);
      return masters.listCoordinators(request.query);
    },
  });
  typed.route({
    method: 'GET',
    url: '/coordinators/:id',
    schema: {
      tags: ['maestros'],
      params: uuidParamsSchema,
      response: { 200: coordinatorResponseSchema },
    },
    handler: async (request) => {
      await reader(request);
      return { coordinator: await masters.getCoordinator(request.params.id) };
    },
  });
  typed.route({
    method: 'POST',
    url: '/admin/coordinators',
    schema: {
      tags: ['administración'],
      body: createCoordinatorSchema,
      response: { 201: coordinatorResponseSchema },
    },
    handler: async (request, reply) => {
      const auth = await admin(request);
      const coordinator = await masters.createCoordinator(
        auth,
        request.body,
        requestContext(request),
      );
      return reply.status(201).send({ coordinator });
    },
  });
  typed.route({
    method: 'PATCH',
    url: '/admin/coordinators/:id',
    schema: {
      tags: ['administración'],
      params: uuidParamsSchema,
      body: updateCoordinatorSchema,
      response: { 200: coordinatorResponseSchema },
    },
    handler: async (request) => {
      const auth = await admin(request);
      return {
        coordinator: await masters.updateCoordinator(
          auth,
          request.params.id,
          request.body,
          requestContext(request),
        ),
      };
    },
  });
  for (const active of [true, false])
    typed.route({
      method: 'POST',
      url: `/admin/coordinators/:id/${active ? 'activate' : 'deactivate'}`,
      schema: {
        tags: ['administración'],
        params: uuidParamsSchema,
        response: { 200: coordinatorResponseSchema },
      },
      handler: async (request) => {
        const auth = await admin(request);
        return {
          coordinator: await masters.setCoordinatorActive(
            auth,
            request.params.id,
            active,
            requestContext(request),
          ),
        };
      },
    });
  typed.route({
    method: 'POST',
    url: '/admin/coordinators/:id/link-user',
    schema: {
      tags: ['administración'],
      params: uuidParamsSchema,
      body: coordinatorUserLinkSchema,
      response: { 200: coordinatorResponseSchema },
    },
    handler: async (request) => {
      const auth = await admin(request);
      return {
        coordinator: await masters.linkCoordinatorUser(
          auth,
          request.params.id,
          request.body.appUserId,
          requestContext(request),
        ),
      };
    },
  });
  typed.route({
    method: 'POST',
    url: '/admin/coordinators/:id/unlink-user',
    schema: {
      tags: ['administración'],
      params: uuidParamsSchema,
      response: { 200: coordinatorResponseSchema },
    },
    handler: async (request) => {
      const auth = await admin(request);
      return {
        coordinator: await masters.linkCoordinatorUser(
          auth,
          request.params.id,
          null,
          requestContext(request),
        ),
      };
    },
  });

  const listClients = async (request: FastifyRequest<{ Querystring: MasterListQuery }>) => {
    await reader(request);
    return masters.listClients(request.query);
  };
  typed.route({
    method: 'GET',
    url: '/clients/search',
    schema: {
      tags: ['maestros'],
      querystring: masterListQuerySchema,
      response: { 200: clientsPageSchema },
    },
    handler: listClients,
  });
  typed.route({
    method: 'GET',
    url: '/clients',
    schema: {
      tags: ['maestros'],
      querystring: masterListQuerySchema,
      response: { 200: clientsPageSchema },
    },
    handler: listClients,
  });
  typed.route({
    method: 'GET',
    url: '/clients/:id',
    schema: {
      tags: ['maestros'],
      params: uuidParamsSchema,
      response: { 200: clientResponseSchema },
    },
    handler: async (request) => {
      await reader(request);
      return { client: await masters.getClient(request.params.id) };
    },
  });
  typed.route({
    method: 'POST',
    url: '/admin/clients',
    schema: {
      tags: ['administración'],
      body: createClientSchema,
      response: { 201: clientResponseSchema },
    },
    handler: async (request, reply) => {
      const auth = await admin(request);
      const client = await masters.createClient(auth, request.body, requestContext(request));
      return reply.status(201).send({ client });
    },
  });
  typed.route({
    method: 'PATCH',
    url: '/admin/clients/:id',
    schema: {
      tags: ['administración'],
      params: uuidParamsSchema,
      body: updateClientSchema,
      response: { 200: clientResponseSchema },
    },
    handler: async (request) => {
      const auth = await admin(request);
      return {
        client: await masters.updateClient(
          auth,
          request.params.id,
          request.body,
          requestContext(request),
        ),
      };
    },
  });
  for (const active of [true, false])
    typed.route({
      method: 'POST',
      url: `/admin/clients/:id/${active ? 'activate' : 'deactivate'}`,
      schema: {
        tags: ['administración'],
        params: uuidParamsSchema,
        response: { 200: clientResponseSchema },
      },
      handler: async (request) => {
        const auth = await admin(request);
        return {
          client: await masters.setClientActive(
            auth,
            request.params.id,
            active,
            requestContext(request),
          ),
        };
      },
    });
  typed.route({
    method: 'PUT',
    url: '/admin/clients/:id/invoice-rule',
    schema: {
      tags: ['administración'],
      params: uuidParamsSchema,
      body: putInvoiceRuleSchema,
      response: { 200: invoiceRuleResponseSchema },
    },
    handler: async (request) => {
      const auth = await admin(request);
      return {
        invoiceRule: await masters.putInvoiceRule(
          auth,
          request.params.id,
          request.body,
          requestContext(request),
        ),
      };
    },
  });

  typed.route({
    method: 'GET',
    url: '/clients/:clientId/receivers',
    schema: {
      tags: ['maestros'],
      params: clientIdParamsSchema,
      querystring: masterListQuerySchema,
      response: { 200: receiversPageSchema },
    },
    handler: async (request) => {
      await reader(request);
      return masters.listReceivers(request.params.clientId, request.query);
    },
  });
  typed.route({
    method: 'POST',
    url: '/admin/clients/:clientId/receivers',
    schema: {
      tags: ['administración'],
      params: clientIdParamsSchema,
      body: createReceiverSchema,
      response: { 201: receiverResponseSchema },
    },
    handler: async (request, reply) => {
      const auth = await admin(request);
      const receiver = await masters.createReceiver(
        auth,
        request.params.clientId,
        request.body,
        requestContext(request),
      );
      return reply.status(201).send({ receiver });
    },
  });
  typed.route({
    method: 'PATCH',
    url: '/admin/receivers/:id',
    schema: {
      tags: ['administración'],
      params: uuidParamsSchema,
      body: updateReceiverSchema,
      response: { 200: receiverResponseSchema },
    },
    handler: async (request) => {
      const auth = await admin(request);
      return {
        receiver: await masters.updateReceiver(
          auth,
          request.params.id,
          request.body,
          requestContext(request),
        ),
      };
    },
  });
  for (const active of [true, false])
    typed.route({
      method: 'POST',
      url: `/admin/receivers/:id/${active ? 'activate' : 'deactivate'}`,
      schema: {
        tags: ['administración'],
        params: uuidParamsSchema,
        response: { 200: receiverResponseSchema },
      },
      handler: async (request) => {
        const auth = await admin(request);
        return {
          receiver: await masters.setReceiverActive(
            auth,
            request.params.id,
            active,
            requestContext(request),
          ),
        };
      },
    });

  typed.route({
    method: 'GET',
    url: '/products',
    schema: {
      tags: ['maestros'],
      querystring: masterListQuerySchema,
      response: { 200: productsPageSchema },
    },
    handler: async (request) => {
      await reader(request);
      return masters.listProducts(request.query);
    },
  });
  typed.route({
    method: 'GET',
    url: '/products/:id',
    schema: {
      tags: ['maestros'],
      params: uuidParamsSchema,
      response: { 200: productResponseSchema },
    },
    handler: async (request) => {
      await reader(request);
      return { product: await masters.getProduct(request.params.id) };
    },
  });
  typed.route({
    method: 'POST',
    url: '/admin/products',
    schema: {
      tags: ['administración'],
      body: createProductSchema,
      response: { 201: productResponseSchema },
    },
    handler: async (request, reply) => {
      const auth = await admin(request);
      const product = await masters.createProduct(auth, request.body, requestContext(request));
      return reply.status(201).send({ product });
    },
  });
  typed.route({
    method: 'PATCH',
    url: '/admin/products/:id',
    schema: {
      tags: ['administración'],
      params: uuidParamsSchema,
      body: updateProductSchema,
      response: { 200: productResponseSchema },
    },
    handler: async (request) => {
      const auth = await admin(request);
      return {
        product: await masters.updateProduct(
          auth,
          request.params.id,
          request.body,
          requestContext(request),
        ),
      };
    },
  });
  for (const active of [true, false])
    typed.route({
      method: 'POST',
      url: `/admin/products/:id/${active ? 'activate' : 'deactivate'}`,
      schema: {
        tags: ['administración'],
        params: uuidParamsSchema,
        response: { 200: productResponseSchema },
      },
      handler: async (request) => {
        const auth = await admin(request);
        return {
          product: await masters.setProductActive(
            auth,
            request.params.id,
            active,
            requestContext(request),
          ),
        };
      },
    });

  typed.route({
    method: 'GET',
    url: '/clients/:clientId/project-centers',
    schema: {
      tags: ['maestros'],
      params: clientIdParamsSchema,
      querystring: masterListQuerySchema,
      response: { 200: projectCentersPageSchema },
    },
    handler: async (request) => {
      await reader(request);
      return masters.listProjectCenters(request.params.clientId, request.query);
    },
  });
  typed.route({
    method: 'GET',
    url: '/project-centers/:id',
    schema: {
      tags: ['maestros'],
      params: uuidParamsSchema,
      response: { 200: projectCenterResponseSchema },
    },
    handler: async (request) => {
      await reader(request);
      return { projectCenter: await masters.getProjectCenter(request.params.id) };
    },
  });
  typed.route({
    method: 'POST',
    url: '/admin/clients/:clientId/project-centers',
    schema: {
      tags: ['administración'],
      params: clientIdParamsSchema,
      body: createProjectCenterSchema,
      response: { 201: projectCenterResponseSchema },
    },
    handler: async (request, reply) => {
      const auth = await admin(request);
      const projectCenter = await masters.createProjectCenter(
        auth,
        request.params.clientId,
        request.body,
        requestContext(request),
      );
      return reply.status(201).send({ projectCenter });
    },
  });
  typed.route({
    method: 'PATCH',
    url: '/admin/project-centers/:id',
    schema: {
      tags: ['administración'],
      params: uuidParamsSchema,
      body: updateProjectCenterSchema,
      response: { 200: projectCenterResponseSchema },
    },
    handler: async (request) => {
      const auth = await admin(request);
      return {
        projectCenter: await masters.updateProjectCenter(
          auth,
          request.params.id,
          request.body,
          requestContext(request),
        ),
      };
    },
  });
  for (const active of [true, false])
    typed.route({
      method: 'POST',
      url: `/admin/project-centers/:id/${active ? 'activate' : 'deactivate'}`,
      schema: {
        tags: ['administración'],
        params: uuidParamsSchema,
        response: { 200: projectCenterResponseSchema },
      },
      handler: async (request) => {
        const auth = await admin(request);
        return {
          projectCenter: await masters.setProjectCenterActive(
            auth,
            request.params.id,
            active,
            requestContext(request),
          ),
        };
      },
    });
}
