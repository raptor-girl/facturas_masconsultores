import { useState, type FormEvent } from 'react';
import type {
  Client,
  InvoicePreviewResponse,
  ProjectCenter,
  UfValue,
} from '@factuflow/shared-schemas';
import { api, ApiError } from './api.js';
import { ClientAutocomplete } from './ClientAutocomplete.js';
import { ProjectCenterAutocomplete } from './ProjectCenterAutocomplete.js';

interface DraftLine {
  projectCenter: ProjectCenter;
  ufAmount: string;
}

export function normalizeDecimalInput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed || (trimmed.includes(',') && trimmed.includes('.'))) return null;
  let canonical = trimmed.replace(',', '.');
  if (canonical.startsWith('.')) canonical = `0${canonical}`;
  if (!/^\d+(?:\.\d+)?$/.test(canonical)) return null;
  const [integer = '', fraction] = canonical.split('.');
  const normalizedInteger = integer.replace(/^0+(?=\d)/, '') || '0';
  const result = fraction === undefined ? normalizedInteger : `${normalizedInteger}.${fraction}`;
  return /[1-9]/.test(result) ? result : null;
}

export function formatClpString(value: string): string {
  if (!/^\d+$/.test(value)) return value;
  const canonical = value.replace(/^0+(?=\d)/, '');
  return `$${canonical.replace(/\B(?=(\d{3})+(?!\d))/g, '.')}`;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'UF_NOT_PUBLISHED') return 'La UF de esa fecha aún no está publicada.';
    if (error.code.startsWith('UF_PROVIDER')) return 'No fue posible consultar las fuentes UF.';
    return error.message;
  }
  return 'No fue posible conectar con FactuFlow.';
}

export function CalculationPreview(): JSX.Element {
  const [ufDate, setUfDate] = useState('');
  const [uf, setUf] = useState<UfValue | null>(null);
  const [client, setClient] = useState<Client | null>(null);
  const [selectedCenter, setSelectedCenter] = useState<ProjectCenter | null>(null);
  const [ufAmount, setUfAmount] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [treatment, setTreatment] = useState<'AFFECTED' | 'EXEMPT'>('AFFECTED');
  const [result, setResult] = useState<InvoicePreviewResponse | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const lookupUf = async () => {
    setError('');
    setUf(null);
    if (!ufDate) {
      setError('Seleccione una fecha UF.');
      return;
    }
    setBusy(true);
    try {
      setUf(await api<UfValue>(`/uf-values/${ufDate}`));
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const addLine = () => {
    const amount = normalizeDecimalInput(ufAmount);
    if (!selectedCenter || !amount) {
      setError('Seleccione un CP/MS e ingrese una cantidad UF positiva.');
      return;
    }
    if (lines.some((line) => line.projectCenter.id === selectedCenter.id)) {
      setError('Ese CP/MS ya está incluido.');
      return;
    }
    setLines([...lines, { projectCenter: selectedCenter, ufAmount: amount }]);
    setSelectedCenter(null);
    setUfAmount('');
    setResult(null);
    setError('');
  };

  const calculate = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (!ufDate || !uf) {
      setError('Consulte primero el valor UF de la fecha seleccionada.');
      return;
    }
    if (!lines.length) {
      setError('Agregue al menos una línea CP/MS.');
      return;
    }
    setBusy(true);
    try {
      setResult(
        await api<InvoicePreviewResponse>('/calculations/invoice-preview', {
          method: 'POST',
          body: JSON.stringify({
            ufDate,
            taxTreatment: treatment,
            lines: lines.map((line, index) => ({
              projectCenterId: line.projectCenter.id,
              ufAmount: line.ufAmount,
              position: index + 1,
            })),
          }),
        }),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">Herramienta técnica · LEGACY_V1</p>
          <h1>Previsualización tributaria</h1>
          <p>Calcula un desglose temporal. No crea una solicitud ni reserva un folio.</p>
        </div>
      </div>

      <section className="panel calculation-panel">
        <h2>Valor UF explícito</h2>
        <div className="lookup-row">
          <label>
            Fecha UF
            <input
              type="date"
              value={ufDate}
              onChange={(event) => {
                setUfDate(event.target.value);
                setUf(null);
                setResult(null);
              }}
              required
            />
          </label>
          <button type="button" onClick={() => void lookupUf()} disabled={busy}>
            Consultar UF
          </button>
        </div>
        {uf && (
          <dl className="uf-summary" aria-live="polite">
            <dt>Valor</dt>
            <dd>{uf.value} CLP</dd>
            <dt>Fuente</dt>
            <dd>{uf.source}</dd>
            <dt>Caché</dt>
            <dd>{uf.fromCache ? 'Sí' : 'No'}</dd>
          </dl>
        )}
      </section>

      <form onSubmit={(event) => void calculate(event)}>
        <section className="panel calculation-panel">
          <h2>Líneas CP/MS</h2>
          <ClientAutocomplete
            label="Cliente de los CP/MS"
            onSelect={(selected) => {
              setClient(selected);
              setLines([]);
              setSelectedCenter(null);
              setResult(null);
            }}
          />
          {client && <p className="selection-note">Cliente seleccionado: {client.shortName}</p>}
          <div className="line-builder">
            <ProjectCenterAutocomplete clientId={client?.id ?? ''} onSelect={setSelectedCenter} />
            <label>
              Cantidad UF
              <input
                type="text"
                inputMode="decimal"
                value={ufAmount}
                onChange={(event) => setUfAmount(event.target.value)}
                placeholder="Ej.: 10,5 o 10.5"
                aria-describedby="decimal-help"
              />
            </label>
            <button type="button" onClick={addLine}>
              Agregar línea
            </button>
          </div>
          <small id="decimal-help">
            Se acepta coma o punto; internamente se normaliza a un string decimal con punto.
          </small>
          <div className="calculation-lines">
            {lines.map((line, index) => (
              <article key={line.projectCenter.id}>
                <div>
                  <strong>
                    {index + 1}. {line.projectCenter.code}
                  </strong>
                  <span>{line.projectCenter.projectName}</span>
                  <small>{line.ufAmount} UF</small>
                </div>
                <button
                  type="button"
                  aria-label={`Quitar ${line.projectCenter.code}`}
                  onClick={() => {
                    setLines(lines.filter((item) => item !== line));
                    setResult(null);
                  }}
                >
                  Quitar
                </button>
              </article>
            ))}
          </div>
          <label>
            Tratamiento tributario
            <select
              value={treatment}
              onChange={(event) => {
                setTreatment(event.target.value as 'AFFECTED' | 'EXEMPT');
                setResult(null);
              }}
            >
              <option value="AFFECTED">Afecto — IVA 0.19</option>
              <option value="EXEMPT">Exento — IVA 0</option>
            </select>
          </label>
          {error && (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          <button className="primary" disabled={busy}>
            {busy ? 'Calculando…' : 'Calcular previsualización'}
          </button>
        </section>
      </form>

      {result && (
        <section className="panel" aria-live="polite">
          <div className="panel-title">
            <div>
              <h2>Desglose</h2>
              <small>{result.algorithmVersion}</small>
            </div>
            <strong className="preview-warning">Resultado no persistido</strong>
          </div>
          <div className="calculation-lines">
            {result.lines.map((line) => (
              <article key={line.projectCenterId}>
                <div>
                  <strong>{line.projectCenterCode}</strong>
                  <span>{line.projectName}</span>
                  <small>
                    {line.ufAmount} UF × {line.ufValue}
                  </small>
                </div>
                <strong>{formatClpString(line.clpAmount)}</strong>
              </article>
            ))}
          </div>
          <dl className="totals">
            <dt>Suma UF</dt>
            <dd>{result.sumUf}</dd>
            <dt>Neto</dt>
            <dd>{formatClpString(result.netClp)}</dd>
            <dt>IVA</dt>
            <dd>{formatClpString(result.ivaClp)}</dd>
            <dt>Total</dt>
            <dd>{formatClpString(result.totalClp)}</dd>
          </dl>
        </section>
      )}
    </>
  );
}
