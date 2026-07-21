import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import {
  CalculationPreview,
  formatClpString,
  normalizeDecimalInput,
} from './CalculationPreview.js';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const createdAt = '2026-01-01T00:00:00.000Z';
const client = {
  id: '3a355399-6904-41cc-8cb7-bbb756d409b7',
  shortName: 'Cliente cálculo',
  legalName: 'Cliente cálculo SpA',
  taxId: '12.345.678-5',
  businessActivity: 'Pruebas',
  address: 'Dirección ficticia',
  defaultCoordinatorProfileId: null,
  defaultCoordinatorDisplayName: null,
  dataStatus: 'COMPLETE',
  isActive: true,
  createdAt,
  updatedAt: createdAt,
};
const center = {
  id: '7da262b9-7414-4113-a84f-7acff9ee5b00',
  clientId: client.id,
  productId: 'c5442c90-65df-407b-a27e-bd75eb5f672e',
  productName: 'Producto ficticio',
  code: 'CP-TEST',
  projectName: 'Proyecto ficticio',
  projectCenterType: 'DEVELOPMENT_HOURS',
  isActive: true,
  createdAt,
  updatedAt: createdAt,
};
const uf = {
  id: '15181291-68fa-4246-8dda-404945c1e81a',
  date: '2024-01-10',
  value: '40543.07',
  source: 'sii.cl',
  fetchedAt: createdAt,
  sourceReference: 'https://www.sii.cl/valores_y_fechas/uf/uf2024.htm',
  fromCache: true,
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('previsualización técnica frontend', () => {
  it('normaliza coma o punto y formatea CLP grandes sin Number', () => {
    expect(normalizeDecimalInput('010,500')).toBe('10.500');
    expect(normalizeDecimalInput('.5')).toBe('0.5');
    expect(normalizeDecimalInput('1,2.3')).toBeNull();
    expect(normalizeDecimalInput('0')).toBeNull();
    expect(formatClpString('2027153500')).toBe('$2.027.153.500');
  });

  it('consulta UF, agrega CP con teclado y muestra desglose afecto', async () => {
    vi.useFakeTimers();
    let previewBody: unknown;
    vi.spyOn(globalThis, 'fetch').mockImplementation((input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/uf-values/')) return Promise.resolve(response(uf));
      if (url.includes('/clients/search')) {
        return Promise.resolve(response({ items: [client], page: 1, pageSize: 8, total: 1 }));
      }
      if (url.includes('/project-centers')) {
        return Promise.resolve(response({ items: [center], page: 1, pageSize: 10, total: 1 }));
      }
      if (url.includes('/calculations/invoice-preview')) {
        if (typeof init?.body !== 'string') throw new Error('Body de preview inesperado');
        previewBody = JSON.parse(init.body) as unknown;
        return Promise.resolve(
          response({
            algorithmVersion: 'LEGACY_V1',
            taxTreatment: 'AFFECTED',
            taxRate: '0.19',
            ufDate: uf.date,
            ufValue: uf.value,
            ufSource: 'sii.cl',
            ufFromCache: true,
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
      throw new Error(`URL no simulada: ${url}`);
    });

    const { container } = render(<CalculationPreview />);
    expect(screen.getByText(/No crea una solicitud ni reserva un folio/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Guardar|Exportar/i })).toBeNull();

    fireEvent.change(screen.getByLabelText('Fecha UF'), { target: { value: uf.date } });
    fireEvent.click(screen.getByRole('button', { name: 'Consultar UF' }));
    await vi.waitFor(() => expect(screen.getByText('40543.07 CLP')).toBeTruthy());
    expect(screen.getByText('Sí')).toBeTruthy();

    const clientInput = screen.getByLabelText('Cliente de los CP/MS');
    fireEvent.change(clientInput, { target: { value: 'Cli' } });
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() =>
      expect(screen.getByRole('option', { name: /Cliente cálculo/ })).toBeTruthy(),
    );
    fireEvent.keyDown(clientInput, { key: 'Enter' });

    const centerInput = screen.getByLabelText('Buscar CP/MS');
    fireEvent.change(centerInput, { target: { value: 'CP' } });
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(screen.getByRole('option', { name: /CP-TEST/ })).toBeTruthy());
    fireEvent.keyDown(centerInput, { key: 'Enter' });
    fireEvent.change(screen.getByLabelText('Cantidad UF'), { target: { value: '10,5' } });
    fireEvent.click(screen.getByRole('button', { name: 'Agregar línea' }));
    fireEvent.click(screen.getByRole('button', { name: 'Calcular previsualización' }));

    await vi.waitFor(() => expect(screen.getByText('$506.592')).toBeTruthy());
    expect(previewBody).toMatchObject({
      ufDate: uf.date,
      taxTreatment: 'AFFECTED',
      lines: [{ projectCenterId: center.id, ufAmount: '10.5', position: 1 }],
    });
    expect(container.querySelector('.calculation-lines')).toBeTruthy();
  });

  it('cambia a exento, valida decimal y presenta error de proveedor', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response(
        {
          error: {
            code: 'UF_PROVIDER_UNAVAILABLE',
            message: 'Proveedor no disponible',
          },
        },
        503,
      ),
    );
    render(<CalculationPreview />);
    fireEvent.change(screen.getByLabelText('Tratamiento tributario'), {
      target: { value: 'EXEMPT' },
    });
    expect(screen.getByLabelText<HTMLSelectElement>('Tratamiento tributario').value).toBe('EXEMPT');
    fireEvent.click(screen.getByRole('button', { name: 'Agregar línea' }));
    expect(screen.getByRole('alert').textContent).toContain('cantidad UF positiva');
    fireEvent.change(screen.getByLabelText('Fecha UF'), { target: { value: uf.date } });
    fireEvent.click(screen.getByRole('button', { name: 'Consultar UF' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('fuentes UF'));
  });
});
