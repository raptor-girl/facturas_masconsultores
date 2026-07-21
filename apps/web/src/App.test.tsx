import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import App from './App.js';

const user = {
  id: '9c3fd6fc-0582-4b54-8d70-65e76430aa10',
  username: 'test.user',
  email: 'test.user@example.invalid',
  displayName: 'Persona de prueba',
  isActive: true,
  mustChangePassword: false,
  roles: ['COORDINATOR'],
  lastLoginAt: null,
  passwordChangedAt: null,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('frontend de autenticación', () => {
  it('muestra el formulario de login y envía con Enter sin revelar la cuenta', async () => {
    const fetchMock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(response({ error: { code: 'UNAUTHENTICATED' } }, 401))
      .mockResolvedValueOnce(
        response(
          { error: { code: 'INVALID_CREDENTIALS', message: 'Credenciales inválidas.' } },
          401,
        ),
      );
    render(<App />);
    const username = await screen.findByLabelText('Username o correo');
    fireEvent.change(username, { target: { value: 'missing@example.invalid' } });
    const password = screen.getByLabelText('Contraseña');
    fireEvent.change(password, { target: { value: 'Wrong-password-42!' } });
    fireEvent.submit(password.closest('form')!);
    expect((await screen.findByRole('alert')).textContent).toContain('Credenciales inválidas.');
    expect(fetchMock.mock.calls[1]?.[1]).toMatchObject({ method: 'POST' });
  });

  it('redirige al cambio obligatorio de contraseña', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      response({ user: { ...user, mustChangePassword: true } }),
    );
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Cambiar contraseña' })).toBeTruthy();
    expect(screen.getByText(/contraseña temporal/i)).toBeTruthy();
  });

  it('oculta la navegación ADMIN a COORDINATOR', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(response({ user }));
    render(<App />);
    expect(await screen.findByRole('heading', { name: /Hola,/ })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Usuarios' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Mi cuenta' })).toBeTruthy();
  });

  it('permite al ADMIN abrir la administración básica', async () => {
    window.history.replaceState({}, '', '/admin/usuarios');
    vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (url.includes('/auth/me')) {
        return Promise.resolve(response({ user: { ...user, roles: ['ADMIN'] } }));
      }
      return Promise.resolve(response({ users: [{ ...user, roles: ['ADMIN'] }] }));
    });
    render(<App />);
    expect(await screen.findByRole('heading', { name: 'Usuarios' })).toBeTruthy();
    await waitFor(() => expect(screen.getAllByText('Persona de prueba').length).toBeGreaterThan(0));
    expect(screen.getByRole('button', { name: /Crear y generar/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Clientes' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'CP/MS' })).toBeTruthy();
  });
});
