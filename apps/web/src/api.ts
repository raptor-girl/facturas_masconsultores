const API_URL = (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:3000';
const SESSION_COOKIE_NAME =
  (import.meta.env['VITE_SESSION_COOKIE_NAME'] as string | undefined) ?? 'factuflow_session';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

function csrfToken(): string | undefined {
  const name = `${SESSION_COOKIE_NAME}_csrf=`;
  return document.cookie
    .split(';')
    .map((value) => value.trim())
    .find((value) => value.startsWith(name))
    ?.slice(name.length);
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const method = init.method?.toUpperCase() ?? 'GET';
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  if (!['GET', 'HEAD'].includes(method)) {
    const csrf = csrfToken();
    if (csrf) headers.set('x-csrf-token', decodeURIComponent(csrf));
  }

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as {
      error?: { code?: string; message?: string };
    } | null;
    if (response.status === 401 && path !== '/auth/login') {
      window.dispatchEvent(new Event('factuflow:unauthorized'));
    }
    throw new ApiError(
      response.status,
      body?.error?.code ?? 'NETWORK_ERROR',
      body?.error?.message ?? 'No fue posible completar la solicitud.',
    );
  }
  return (await response.json()) as T;
}
