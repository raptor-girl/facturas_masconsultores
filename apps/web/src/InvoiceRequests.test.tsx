import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import type { InvoiceRequestDetail } from '@factuflow/shared-schemas';
import {
  InvoiceRequestDetailPage,
  InvoiceRequestForm,
  InvoiceRequestHistory,
} from './InvoiceRequests.js';

const createdAt = '2026-07-20T12:00:00.000Z';
const client = {
  id: '11111111-1111-4111-8111-111111111111',
  shortName: 'Cliente Ficticio',
  legalName: 'Cliente Ficticio SpA',
  taxId: '12.345.678-5',
  businessActivity: 'Actividad ficticia',
  address: 'Calle Ficticia 1',
  defaultCoordinatorProfileId: '22222222-2222-4222-8222-222222222222',
  defaultCoordinatorDisplayName: 'Responsable Ficticio',
  dataStatus: 'COMPLETE' as const,
  isActive: true,
  createdAt,
  updatedAt: createdAt,
};
const rule = {
  clientId: client.id,
  purchaseOrderRequirement: 'REQUIRED' as const,
  hesRequirement: 'OPTIONAL' as const,
  contractRequirement: 'NOT_APPLICABLE' as const,
  supplierNumber: 'PROV-1',
  defaultIssuerCompanyId: '33333333-3333-4333-8333-333333333333',
  defaultTaxTreatment: 'AFFECTED' as const,
  excelTemplateVariant: 'STANDARD' as const,
  billingNotes: null,
  isActive: true,
  createdAt,
  updatedAt: createdAt,
};
const issuer = {
  id: rule.defaultIssuerCompanyId,
  code: 'ISS-1',
  legalName: 'Emisora Ficticia SpA',
  taxId: '76.543.210-5',
  businessActivity: 'Servicios ficticios',
  address: 'Calle Ficticia 2',
  isActive: true,
  defaultTaxTreatment: 'AFFECTED' as const,
  defaultIvaRate: '0.19',
  createdAt,
  updatedAt: createdAt,
};
const coordinator = {
  id: client.defaultCoordinatorProfileId,
  appUserId: null,
  displayName: 'Responsable Ficticio',
  email: 'responsible@example.invalid',
  isActive: true,
  createdAt,
  updatedAt: createdAt,
};
const receiver = {
  id: '44444444-4444-4444-8444-444444444444',
  clientId: client.id,
  displayName: 'Receptor Ficticio',
  email: 'receiver@example.invalid',
  isActive: true,
  createdAt,
  updatedAt: createdAt,
};
const center = {
  id: '55555555-5555-4555-8555-555555555555',
  clientId: client.id,
  productId: '66666666-6666-4666-8666-666666666666',
  productName: 'Producto Ficticio',
  code: 'CP-TEST-1',
  projectName: 'Proyecto Ficticio',
  projectCenterType: 'DEVELOPMENT_HOURS' as const,
  isActive: true,
  createdAt,
  updatedAt: createdAt,
};
const uf = {
  id: '77777777-7777-4777-8777-777777777777',
  date: '2024-01-10',
  value: '40543.07',
  source: 'sii.cl' as const,
  fetchedAt: createdAt,
  sourceReference: 'https://www.sii.cl/valores_y_fechas/uf/uf2024.htm',
  fromCache: true,
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fetchUrl(input: string | URL | Request): string {
  return typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('solicitudes de factura frontend', () => {
  it('mantiene el formulario en memoria, previsualiza y exporta con una idempotency key', async () => {
    vi.useFakeTimers();
    let exportBody: Record<string, unknown> | undefined;
    let idempotencyKey = '';
    const navigate = vi.fn();
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: vi.fn(() => 'blob:phase5-test'),
    });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined);
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/issuer-companies')) return Promise.resolve(json({ items: [issuer] }));
      if (url.includes('/coordinators')) return Promise.resolve(json({ items: [coordinator] }));
      if (url.includes('/clients/search')) return Promise.resolve(json({ items: [client] }));
      if (url.endsWith(`/clients/${client.id}`)) {
        return Promise.resolve(json({ client: { ...client, invoiceRule: rule } }));
      }
      if (url.includes('/receivers')) return Promise.resolve(json({ items: [receiver] }));
      if (url.includes('/uf-values/')) return Promise.resolve(json(uf));
      if (url.includes('/project-centers')) return Promise.resolve(json({ items: [center] }));
      if (url.includes('/calculations/invoice-preview')) {
        return Promise.resolve(
          json({
            algorithmVersion: 'LEGACY_V1',
            taxTreatment: 'AFFECTED',
            taxRate: '0.19',
            ufDate: uf.date,
            ufValue: uf.value,
            ufSource: null,
            ufFromCache: null,
            sumUf: '10.5',
            netClp: '425702',
            ivaClp: '80890',
            totalClp: '506592',
            clientId: client.id,
            lines: [
              {
                projectCenterId: center.id,
                projectCenterCode: center.code,
                projectName: center.projectName,
                ufAmount: '10.5',
                ufValue: uf.value,
                clpAmount: '425702',
                position: 1,
              },
            ],
          }),
        );
      }
      if (url.endsWith('/invoice-requests/export')) {
        if (typeof init?.body !== 'string') throw new Error('Export sin JSON');
        exportBody = JSON.parse(init.body) as Record<string, unknown>;
        idempotencyKey = new Headers(init.headers).get('idempotency-key') ?? '';
        return Promise.resolve(
          new Response(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), {
            status: 200,
            headers: {
              'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
              'content-disposition': 'attachment; filename="Solicitud_factura_TEST.xlsx"',
              'x-invoice-request-id': '88888888-8888-4888-8888-888888888888',
              'x-invoice-folio': 'SF-2026-00001',
              'x-export-sha256': 'a'.repeat(64),
            },
          }),
        );
      }
      throw new Error(`URL no simulada: ${url}`);
    });

    render(<InvoiceRequestForm navigate={navigate} />);
    expect(screen.getByText(/No se crea ningún registro ni folio/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Guardar borrador/i })).toBeNull();
    expect(
      fetchMock.mock.calls.some(([input]) => fetchUrl(input).includes('/invoice-requests/export')),
    ).toBe(false);

    const clientInput = screen.getByLabelText('Cliente activo y completo');
    fireEvent.change(clientInput, { target: { value: 'Cliente' } });
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() =>
      expect(screen.getByRole('option', { name: /Cliente Ficticio/ })).toBeTruthy(),
    );
    fireEvent.keyDown(clientInput, { key: 'Enter' });
    await vi.waitFor(() => expect(screen.getByText(/Seleccionado: Cliente Ficticio/)).toBeTruthy());
    expect(screen.getByLabelText<HTMLInputElement>('Área').readOnly).toBe(true);
    expect(screen.getByLabelText<HTMLSelectElement>('Responsable').value).toBe(coordinator.id);
    expect(screen.getByLabelText(/Orden de compra/)).toBeTruthy();
    expect(screen.queryByLabelText(/Contrato/)).toBeNull();

    fireEvent.change(screen.getByLabelText('Período'), { target: { value: '2026-07' } });
    fireEvent.change(screen.getByLabelText('Fecha de solicitud'), {
      target: { value: '2026-07-20' },
    });
    fireEvent.change(screen.getByLabelText('Fecha de facturación'), {
      target: { value: '2026-07-25' },
    });
    fireEvent.change(screen.getByLabelText('Fecha UF explícita'), {
      target: { value: uf.date },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Consultar UF' }));
    await vi.waitFor(() => expect(screen.getByText(/40543.07/)).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/Orden de compra/), { target: { value: 'OC-TEST' } });
    fireEvent.change(screen.getByLabelText('Glosa'), {
      target: { value: 'Servicio ficticio' },
    });

    const centerInput = screen.getByLabelText('Buscar CP/MS');
    fireEvent.change(centerInput, { target: { value: 'CP' } });
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(screen.getByRole('option', { name: /CP-TEST-1/ })).toBeTruthy());
    fireEvent.keyDown(centerInput, { key: 'Enter' });
    fireEvent.change(screen.getByLabelText('Cantidad UF'), { target: { value: '10,5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar línea' }));
    fireEvent.change(screen.getByLabelText('Nombre temporal'), {
      target: { value: 'Receptor Puntual' },
    });
    fireEvent.change(screen.getByLabelText('Correo temporal'), {
      target: { value: 'temporary@example.invalid' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar receptor puntual' }));

    expect(
      fetchMock.mock.calls.some(([input]) => fetchUrl(input).includes('/invoice-requests/export')),
    ).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Previsualizar cálculo' }));
    await vi.waitFor(() => expect(screen.getByText('$506.592')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: 'Exportar Excel y guardar solicitud' }));
    await vi.waitFor(() =>
      expect(navigate).toHaveBeenCalledWith('/solicitudes/88888888-8888-4888-8888-888888888888'),
    );
    expect(idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(exportBody).toMatchObject({
      clientId: client.id,
      area: 'Plataformas',
      ufValue: '40543.07',
      contractNumber: null,
      lines: [{ projectCenterId: center.id, ufAmount: '10.5', position: 1 }],
      receivers: [
        { email: 'receiver@example.invalid', position: 1 },
        { receiverId: null, email: 'temporary@example.invalid', position: 2 },
      ],
    });
  });

  it('muestra historial responsive lógico y navega a detalle o duplicación', async () => {
    const navigate = vi.fn();
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      json({
        items: [
          {
            id: '88888888-8888-4888-8888-888888888888',
            folio: 'SF-2026-00001',
            status: 'EXPORTED',
            statusLabel: 'Factura solicitada',
            clientId: client.id,
            clientShortName: client.shortName,
            issuerCompanyId: issuer.id,
            issuerCompanyLegalName: issuer.legalName,
            coordinatorProfileId: coordinator.id,
            coordinatorDisplayName: coordinator.displayName,
            period: '2026-07',
            requestDate: '2026-07-20',
            billingDate: '2026-07-25',
            taxTreatment: 'AFFECTED',
            netClp: '425702',
            ivaClp: '80890',
            totalClp: '506592',
            exportedAt: createdAt,
            createdBy: '99999999-9999-4999-8999-999999999999',
            sourceRequestId: null,
          },
        ],
      }),
    );
    const { container } = render(<InvoiceRequestHistory navigate={navigate} />);
    expect(await screen.findByText('SF-2026-00001')).toBeTruthy();
    expect(screen.getAllByText('Factura solicitada').length).toBeGreaterThanOrEqual(1);
    expect(container.querySelector('td[data-label="Cliente"]')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Ver' }));
    expect(navigate).toHaveBeenCalledWith('/solicitudes/88888888-8888-4888-8888-888888888888');
    fireEvent.click(screen.getByRole('button', { name: 'Duplicar' }));
    expect(navigate).toHaveBeenCalledWith(
      '/solicitudes/88888888-8888-4888-8888-888888888888/duplicar',
    );
  });

  it('presenta el detalle histórico como solo lectura y ofrece descargar/duplicar', async () => {
    const navigate = vi.fn();
    const detail = {
      id: '88888888-8888-4888-8888-888888888888',
      folio: 'SF-2026-00001',
      status: 'EXPORTED',
      statusLabel: 'Factura solicitada',
      clientId: client.id,
      clientShortName: client.shortName,
      issuerCompanyId: issuer.id,
      issuerCompanyLegalName: issuer.legalName,
      coordinatorProfileId: coordinator.id,
      coordinatorDisplayName: coordinator.displayName,
      period: '2026-07',
      requestDate: '2026-07-20',
      billingDate: '2026-07-25',
      taxTreatment: 'AFFECTED',
      netClp: '425702',
      ivaClp: '80890',
      totalClp: '506592',
      exportedAt: createdAt,
      createdBy: '99999999-9999-4999-8999-999999999999',
      sourceRequestId: null,
      ufDate: uf.date,
      ufValue: uf.value,
      ufSource: uf.source,
      ivaRate: '0.19',
      area: 'Plataformas',
      purchaseOrderNumber: 'OC-TEST',
      contractNumber: null,
      hesNumber: null,
      supplierNumber: null,
      description: 'Servicio ficticio',
      observations: null,
      calculationAlgorithmVersion: 'LEGACY_V1',
      excelTemplateVariant: 'STANDARD',
      excelTemplateVersion: 'TECHNICAL_V1_UNAPPROVED',
      clientSnapshot: { schemaVersion: 1 },
      issuerCompanySnapshot: { schemaVersion: 1 },
      coordinatorSnapshot: { schemaVersion: 1 },
      invoiceRuleSnapshot: { schemaVersion: 1 },
      createdAt,
      lines: [
        {
          id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
          position: 1,
          projectCenterId: center.id,
          projectCenterCode: center.code,
          projectName: center.projectName,
          projectCenterType: center.projectCenterType,
          productId: center.productId,
          productCode: null,
          productName: center.productName,
          ufAmount: '10.5',
          ufValue: uf.value,
          clpAmount: '425702',
        },
      ],
      receivers: [
        {
          id: receiver.id,
          position: 1,
          receiverId: receiver.id,
          displayName: receiver.displayName,
          email: receiver.email,
        },
      ],
      export: {
        id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
        filename: 'Solicitud_factura_TEST.xlsx',
        mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        sizeBytes: '1000',
        sha256: 'a'.repeat(64),
        templateVariant: 'STANDARD',
        templateVersion: 'TECHNICAL_V1_UNAPPROVED',
        createdAt,
      },
    } satisfies InvoiceRequestDetail;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(json({ invoiceRequest: detail }));
    render(<InvoiceRequestDetailPage id={detail.id} navigate={navigate} />);
    expect(await screen.findByRole('heading', { name: detail.folio })).toBeTruthy();
    expect(screen.getByText(/solo lectura/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Guardar|Editar/i })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Duplicar' }));
    expect(navigate).toHaveBeenCalledWith(`/solicitudes/${detail.id}/duplicar`);
  });
});
