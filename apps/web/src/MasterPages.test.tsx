import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ClientAutocomplete } from './ClientAutocomplete.js';
import { ClientsPage, SimpleMastersPage } from './MasterPages.js';

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const client = {
  id: '3a355399-6904-41cc-8cb7-bbb756d409b7',
  shortName: 'Cliente Ficticio',
  legalName: 'Cliente Ficticio SpA',
  taxId: '12.345.678-5',
  businessActivity: 'Pruebas',
  address: 'Dirección de prueba',
  defaultCoordinatorProfileId: null,
  defaultCoordinatorDisplayName: null,
  dataStatus: 'COMPLETE',
  isActive: true,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('maestros en frontend', () => {
  it('lista productos en tarjetas responsivas y presenta formulario ADMIN', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({
        items: [
          {
            id: '744343d6-9207-472d-9853-edc5bbf802ca',
            code: 'PX',
            name: 'Producto ficticio',
            isActive: true,
            createdAt: client.createdAt,
            updatedAt: client.updatedAt,
          },
        ],
        page: 1,
        pageSize: 20,
        total: 1,
      }),
    );
    const { container } = render(<SimpleMastersPage kind="products" />);
    expect(await screen.findByText('Producto ficticio')).toBeTruthy();
    expect(screen.getByRole('heading', { name: 'Productos' })).toBeTruthy();
    expect(screen.getByLabelText('Nombre')).toBeTruthy();
    expect(container.querySelector('.master-list')).toBeTruthy();
  });

  it('autocomplete espera, cancela y permite elegir con teclado', async () => {
    vi.useFakeTimers();
    const selected = vi.fn();
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(response({ items: [client], page: 1, pageSize: 8, total: 1 }));
    render(<ClientAutocomplete onSelect={selected} />);
    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'Cli' } });
    expect(fetchMock).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(250);
    await vi.waitFor(() => expect(screen.getByRole('option')).toBeTruthy());
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(selected).toHaveBeenCalledWith(client);
    fireEvent.change(input, { target: { value: 'Otro' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(input.getAttribute('aria-expanded')).toBe('false');
  });

  it('listado de clientes no muestra responsable como columna principal', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/coordinators'))
        return Promise.resolve(response({ items: [], page: 1, pageSize: 20, total: 0 }));
      return Promise.resolve(response({ items: [client], page: 1, pageSize: 20, total: 1 }));
    });
    render(<ClientsPage />);
    await waitFor(() => expect(screen.getAllByText('Cliente Ficticio').length).toBeGreaterThan(0));
    const listing = screen.getByLabelText('Listado de clientes');
    expect(listing.textContent).not.toContain('Responsable');
    expect(screen.getByLabelText('Responsable sugerido')).toBeTruthy();
  });
});
