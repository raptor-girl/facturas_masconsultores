import { useCallback, useEffect, useState } from 'react';
import type { HealthResponse } from '@factuflow/shared-schemas';

/**
 * Scaffold mínimo de la Fase 1 — deliberadamente austero.
 *
 * Su único trabajo es demostrar que la cadena completa está viva:
 * navegador → Vite → API → PostgreSQL. Nada más.
 *
 * NO se diseña aquí la aplicación real. El flujo de solicitudes, el formulario,
 * la tabla de Inicio y la duplicación están fuera del alcance aprobado, y
 * adelantarlos ahora significaría fijar decisiones de UX que dependen de
 * pendientes abiertos (D-04b, D-07). Ver docs/PHASE_1_STATUS.md.
 */

const API_URL = (import.meta.env['VITE_API_URL'] as string | undefined) ?? 'http://localhost:3000';

type Probe =
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'ok'; health: HealthResponse }
  | { state: 'error'; message: string };

export default function App(): JSX.Element {
  const [probe, setProbe] = useState<Probe>({ state: 'idle' });

  const checkHealth = useCallback(async (): Promise<void> => {
    setProbe({ state: 'checking' });
    try {
      const response = await fetch(`${API_URL}/health`);
      // 503 también trae un cuerpo válido: el API responde, la base no.
      const health = (await response.json()) as HealthResponse;
      setProbe({ state: 'ok', health });
    } catch (error) {
      setProbe({
        state: 'error',
        message: error instanceof Error ? error.message : 'No se pudo contactar al API',
      });
    }
  }, []);

  useEffect(() => {
    void checkHealth();
  }, [checkHealth]);

  return (
    <main className="shell">
      <header>
        <h1>FactuFlow</h1>
        <p className="subtitle">Solicitudes de Factura · Fase 1 — fundaciones técnicas</p>
      </header>

      <section className="card" aria-live="polite">
        <div className="card-head">
          <h2>Estado del sistema</h2>
          <button type="button" onClick={() => void checkHealth()}>
            Comprobar de nuevo
          </button>
        </div>

        {probe.state === 'checking' && <p>Comprobando…</p>}

        {probe.state === 'error' && (
          <p className="bad">
            El API no responde en <code>{API_URL}</code>. {probe.message}
            <br />
            Levanta el API con <code>npm run docker:up</code> o <code>npm run dev</code>.
          </p>
        )}

        {probe.state === 'ok' && (
          <dl>
            <dt>API</dt>
            <dd className="good">responde · v{probe.health.version}</dd>

            <dt>PostgreSQL</dt>
            <dd className={probe.health.status === 'ok' ? 'good' : 'bad'}>
              {probe.health.checks[0]?.status === 'ok'
                ? `conectado · ${String(probe.health.checks[0]?.latencyMs)} ms`
                : 'sin conexión'}
            </dd>

            <dt>Activo desde</dt>
            <dd>{probe.health.uptimeSeconds} s</dd>
          </dl>
        )}
      </section>

      <footer>
        <p>
          Esta pantalla es un scaffold. El flujo de solicitudes llega en fases posteriores, tras
          aprobación explícita.
        </p>
      </footer>
    </main>
  );
}
