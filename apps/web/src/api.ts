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

function requestHeaders(init: RequestInit): Headers {
  const method = init.method?.toUpperCase() ?? 'GET';
  const headers = new Headers(init.headers);
  if (init.body) headers.set('content-type', 'application/json');
  if (!['GET', 'HEAD'].includes(method)) {
    const csrf = csrfToken();
    if (csrf) headers.set('x-csrf-token', decodeURIComponent(csrf));
  }
  return headers;
}

async function throwApiError(response: Response, path: string): Promise<never> {
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

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: requestHeaders(init),
    credentials: 'include',
  });
  if (!response.ok) await throwApiError(response, path);
  return (await response.json()) as T;
}

export interface DownloadedFile {
  readonly blob: Blob;
  readonly filename: string;
  readonly invoiceRequestId: string;
  readonly folio: string;
  readonly sha256: string;
}

export async function apiFile(path: string, init: RequestInit = {}): Promise<DownloadedFile> {
  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: requestHeaders(init),
    credentials: 'include',
  });
  if (!response.ok) await throwApiError(response, path);

  const disposition = response.headers.get('content-disposition') ?? '';
  const filename = /filename="([A-Za-z0-9_.-]+\.xlsx)"/.exec(disposition)?.[1];
  if (!filename)
    throw new ApiError(500, 'INVALID_DOWNLOAD', 'La descarga no tiene un nombre seguro.');
  const invoiceRequestId = response.headers.get('x-invoice-request-id');
  const folio = response.headers.get('x-invoice-folio');
  const sha256 = response.headers.get('x-export-sha256');
  if (!invoiceRequestId || !folio || !sha256) {
    throw new ApiError(500, 'INVALID_DOWNLOAD', 'La descarga no contiene trazabilidad completa.');
  }
  return {
    blob: await response.blob(),
    filename,
    invoiceRequestId,
    folio,
    sha256,
  };
}

export function saveDownloadedFile(file: DownloadedFile): void {
  const url = URL.createObjectURL(file.blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.filename;
  anchor.rel = 'noopener';
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}
