import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import type {
  Client,
  ClientDetail,
  CoordinatorProfile,
  InvoicePreviewResponse,
  InvoiceRequestDetail,
  InvoiceRequestDuplicateSource,
  InvoiceRequestListItem,
  InvoiceRule,
  IssuerCompany,
  ProjectCenter,
  Receiver,
  UfValue,
} from '@factuflow/shared-schemas';
import { api, apiFile, ApiError, saveDownloadedFile } from './api.js';
import { ClientAutocomplete } from './ClientAutocomplete.js';
import { ProjectCenterAutocomplete } from './ProjectCenterAutocomplete.js';
import { formatClpString, normalizeDecimalInput } from './CalculationPreview.js';

type Navigate = (path: string) => void;

interface DraftLine {
  projectCenter: ProjectCenter;
  ufAmount: string;
}

interface DraftReceiver {
  receiverId: string | null;
  displayName: string;
  email: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'UF_VALUE_CHANGED') {
      return 'El valor UF cambió. Consulte nuevamente la fecha antes de exportar.';
    }
    if (error.code === 'DOCUMENT_REQUIREMENT_NOT_MET') return error.message;
    return error.message;
  }
  return 'No fue posible completar la operación.';
}

function newIdempotencyKey(): string {
  return globalThis.crypto.randomUUID();
}

async function download(path: string): Promise<void> {
  saveDownloadedFile(await apiFile(path));
}

function RequirementField({
  label,
  requirement,
  value,
  onChange,
}: {
  label: string;
  requirement: InvoiceRule['purchaseOrderRequirement'];
  value: string;
  onChange: (value: string) => void;
}): JSX.Element | null {
  if (requirement === 'NOT_APPLICABLE') return null;
  return (
    <label>
      {label} {requirement === 'REQUIRED' ? '(obligatorio)' : '(opcional)'}
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        required={requirement === 'REQUIRED'}
        maxLength={200}
      />
    </label>
  );
}

export function InvoiceRequestForm({
  sourceId,
  navigate,
}: {
  sourceId?: string;
  navigate: Navigate;
}): JSX.Element {
  const [idempotencyKey] = useState(newIdempotencyKey);
  const [client, setClient] = useState<Client | null>(null);
  const [rule, setRule] = useState<InvoiceRule | null>(null);
  const [issuers, setIssuers] = useState<IssuerCompany[]>([]);
  const [coordinators, setCoordinators] = useState<CoordinatorProfile[]>([]);
  const [issuerId, setIssuerId] = useState('');
  const [coordinatorId, setCoordinatorId] = useState('');
  const [period, setPeriod] = useState('');
  const [requestDate, setRequestDate] = useState('');
  const [billingDate, setBillingDate] = useState('');
  const [ufDate, setUfDate] = useState('');
  const [uf, setUf] = useState<UfValue | null>(null);
  const [treatment, setTreatment] = useState<'AFFECTED' | 'EXEMPT'>('AFFECTED');
  const [purchaseOrder, setPurchaseOrder] = useState('');
  const [contract, setContract] = useState('');
  const [hes, setHes] = useState('');
  const [supplierNumber, setSupplierNumber] = useState('');
  const [description, setDescription] = useState('');
  const [observations, setObservations] = useState('');
  const [lines, setLines] = useState<DraftLine[]>([]);
  const [selectedCenter, setSelectedCenter] = useState<ProjectCenter | null>(null);
  const [ufAmount, setUfAmount] = useState('');
  const [receivers, setReceivers] = useState<DraftReceiver[]>([]);
  const [tempName, setTempName] = useState('');
  const [tempEmail, setTempEmail] = useState('');
  const [preview, setPreview] = useState<InvoicePreviewResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadingSource, setLoadingSource] = useState(Boolean(sourceId));
  const [error, setError] = useState('');

  const selectClient = useCallback(async (selected: Client, preserve = false) => {
    if (!selected.isActive || selected.dataStatus !== 'COMPLETE') {
      setError('Sólo puede solicitar factura para un cliente activo y completo.');
      return;
    }
    try {
      const [detailResult, receiverResult] = await Promise.all([
        api<{ client: ClientDetail }>(`/clients/${selected.id}`),
        api<{ items: Receiver[] }>(`/clients/${selected.id}/receivers?pageSize=100&active=true`),
      ]);
      if (!detailResult.client.invoiceRule?.isActive) {
        setError('El cliente no tiene una configuración de facturación activa.');
        return;
      }
      setClient(selected);
      setRule(detailResult.client.invoiceRule);
      if (!preserve) {
        setLines([]);
        setReceivers(
          receiverResult.items.map((receiver) => ({
            receiverId: receiver.id,
            displayName: receiver.displayName ?? '',
            email: receiver.email,
          })),
        );
        setIssuerId(detailResult.client.invoiceRule.defaultIssuerCompanyId ?? '');
        setCoordinatorId(detailResult.client.defaultCoordinatorProfileId ?? '');
        setTreatment(detailResult.client.invoiceRule.defaultTaxTreatment ?? 'AFFECTED');
        setSupplierNumber(detailResult.client.invoiceRule.supplierNumber ?? '');
        setPurchaseOrder('');
        setContract('');
        setHes('');
      }
      setPreview(null);
      setError('');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);

  useEffect(() => {
    void Promise.all([
      api<{ items: IssuerCompany[] }>('/issuer-companies?pageSize=100&active=true'),
      api<{ items: CoordinatorProfile[] }>('/coordinators?pageSize=100&active=true'),
    ])
      .then(([issuerResult, coordinatorResult]) => {
        setIssuers(issuerResult.items);
        setCoordinators(coordinatorResult.items);
      })
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, []);

  useEffect(() => {
    if (!sourceId) return;
    void api<{ source: InvoiceRequestDuplicateSource }>(
      `/invoice-requests/${sourceId}/duplicate-source`,
    )
      .then(async ({ source }) => {
        const [clientResult, projectCenters] = await Promise.all([
          api<{ client: ClientDetail }>(`/clients/${source.clientId}`),
          Promise.all(
            source.lines.map((line) =>
              api<{ projectCenter: ProjectCenter }>(`/project-centers/${line.projectCenterId}`),
            ),
          ),
        ]);
        await selectClient(clientResult.client, true);
        setIssuerId(source.issuerCompanyId);
        setCoordinatorId(source.coordinatorProfileId);
        setPeriod(source.period);
        setRequestDate(source.requestDate);
        setBillingDate(source.billingDate);
        setUfDate(source.ufDate);
        setUf(null);
        setTreatment(source.taxTreatment);
        setPurchaseOrder(source.purchaseOrderNumber ?? '');
        setContract(source.contractNumber ?? '');
        setHes(source.hesNumber ?? '');
        setSupplierNumber(source.supplierNumber ?? '');
        setDescription(source.description);
        setObservations(source.observations ?? '');
        setLines(
          source.lines.map((line, index) => ({
            projectCenter: projectCenters[index]?.projectCenter as ProjectCenter,
            ufAmount: line.ufAmount,
          })),
        );
        setReceivers(
          source.receivers.map((receiver) => ({
            receiverId: receiver.receiverId,
            displayName: receiver.displayName ?? '',
            email: receiver.email,
          })),
        );
      })
      .catch((cause: unknown) => setError(errorMessage(cause)))
      .finally(() => setLoadingSource(false));
  }, [selectClient, sourceId]);

  const lookupUf = async () => {
    if (!ufDate) {
      setError('Seleccione una fecha UF.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      setUf(await api<UfValue>(`/uf-values/${ufDate}`));
      setPreview(null);
    } catch (cause) {
      setUf(null);
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
      setError('Ese CP/MS ya fue agregado.');
      return;
    }
    setLines([...lines, { projectCenter: selectedCenter, ufAmount: amount }]);
    setSelectedCenter(null);
    setUfAmount('');
    setPreview(null);
    setError('');
  };

  const addTemporaryReceiver = () => {
    const email = tempEmail.trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email)) {
      setError('Ingrese un correo receptor válido.');
      return;
    }
    if (receivers.some((receiver) => receiver.email.toLowerCase() === email)) {
      setError('Ese correo receptor ya está incluido.');
      return;
    }
    setReceivers([...receivers, { receiverId: null, displayName: tempName.trim(), email }]);
    setTempName('');
    setTempEmail('');
    setError('');
  };

  const requestPayload = useMemo(() => {
    if (!client || !uf) return null;
    return {
      sourceRequestId: sourceId ?? null,
      clientId: client.id,
      issuerCompanyId: issuerId,
      coordinatorProfileId: coordinatorId,
      period,
      requestDate,
      billingDate,
      ufDate,
      ufValue: uf.value,
      taxTreatment: treatment,
      area: 'Plataformas' as const,
      purchaseOrderNumber:
        rule?.purchaseOrderRequirement === 'NOT_APPLICABLE' ? null : purchaseOrder || null,
      contractNumber: rule?.contractRequirement === 'NOT_APPLICABLE' ? null : contract || null,
      hesNumber: rule?.hesRequirement === 'NOT_APPLICABLE' ? null : hes || null,
      supplierNumber: supplierNumber || null,
      description,
      observations: observations || null,
      lines: lines.map((line, index) => ({
        projectCenterId: line.projectCenter.id,
        ufAmount: line.ufAmount,
        position: index + 1,
      })),
      receivers: receivers.map((receiver, index) => ({
        receiverId: receiver.receiverId,
        displayName: receiver.displayName || null,
        email: receiver.email,
        position: index + 1,
      })),
    };
  }, [
    billingDate,
    client,
    contract,
    coordinatorId,
    description,
    hes,
    issuerId,
    lines,
    observations,
    period,
    purchaseOrder,
    receivers,
    requestDate,
    rule,
    sourceId,
    supplierNumber,
    treatment,
    uf,
    ufDate,
  ]);

  const validateComplete = (): boolean => {
    if (!requestPayload || !issuerId || !coordinatorId || !period || !requestDate || !billingDate) {
      setError('Complete cliente, emisor, responsable, período, fechas y UF.');
      return false;
    }
    if (!lines.length || !receivers.length || !description.trim()) {
      setError('Agregue líneas, al menos un receptor y una glosa.');
      return false;
    }
    return true;
  };

  const calculate = async () => {
    if (!validateComplete() || !requestPayload) return;
    setBusy(true);
    setError('');
    try {
      setPreview(
        await api<InvoicePreviewResponse>('/calculations/invoice-preview', {
          method: 'POST',
          body: JSON.stringify({
            ufDate: requestPayload.ufDate,
            ufValue: requestPayload.ufValue,
            taxTreatment: requestPayload.taxTreatment,
            lines: requestPayload.lines,
          }),
        }),
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const exportRequest = async (event: FormEvent) => {
    event.preventDefault();
    if (!validateComplete() || !requestPayload) return;
    setBusy(true);
    setError('');
    try {
      const file = await apiFile('/invoice-requests/export', {
        method: 'POST',
        headers: { 'Idempotency-Key': idempotencyKey },
        body: JSON.stringify(requestPayload),
      });
      saveDownloadedFile(file);
      navigate(`/solicitudes/${file.invoiceRequestId}`);
    } catch (cause) {
      // La misma clave permanece en memoria para que un retry de red no cree
      // otra solicitud ni reserve un segundo folio.
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  if (loadingSource) return <p aria-live="polite">Cargando solicitud para duplicar…</p>;

  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">Solicitud en memoria</p>
          <h1>{sourceId ? 'Duplicar solicitud' : 'Nueva solicitud de factura'}</h1>
          <p>No se crea ningún registro ni folio hasta exportar correctamente el Excel.</p>
        </div>
        <button type="button" onClick={() => navigate('/solicitudes')}>
          Volver al historial
        </button>
      </div>

      <form onSubmit={(event) => void exportRequest(event)}>
        <section className="panel request-form-grid">
          <ClientAutocomplete
            label="Cliente activo y completo"
            completeOnly
            onSelect={(selected) => void selectClient(selected)}
          />
          {client && <p className="selection-note">Seleccionado: {client.shortName}</p>}
          <label>
            Empresa emisora
            <select required value={issuerId} onChange={(event) => setIssuerId(event.target.value)}>
              <option value="">Seleccione</option>
              {issuers.map((issuer) => (
                <option key={issuer.id} value={issuer.id}>
                  {issuer.legalName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Responsable
            <select
              required
              value={coordinatorId}
              onChange={(event) => setCoordinatorId(event.target.value)}
            >
              <option value="">Seleccione</option>
              {coordinators.map((coordinator) => (
                <option key={coordinator.id} value={coordinator.id}>
                  {coordinator.displayName}
                </option>
              ))}
            </select>
          </label>
          <label>
            Área
            <input value="Plataformas" readOnly aria-readonly="true" />
          </label>
          <label>
            Período
            <input
              type="month"
              required
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
            />
          </label>
          <label>
            Fecha de solicitud
            <input
              type="date"
              required
              value={requestDate}
              onChange={(event) => setRequestDate(event.target.value)}
            />
          </label>
          <label>
            Fecha de facturación
            <input
              type="date"
              required
              value={billingDate}
              onChange={(event) => setBillingDate(event.target.value)}
            />
          </label>
        </section>

        <section className="panel request-form-grid">
          <h2>UF y tratamiento tributario</h2>
          <label>
            Fecha UF explícita
            <input
              type="date"
              required
              value={ufDate}
              onChange={(event) => {
                setUfDate(event.target.value);
                setUf(null);
                setPreview(null);
              }}
            />
          </label>
          <button type="button" onClick={() => void lookupUf()} disabled={busy}>
            Consultar UF
          </button>
          {uf && (
            <p className="selection-note" aria-live="polite">
              UF {uf.value} · {uf.source} · {uf.fromCache ? 'caché' : 'proveedor'}
            </p>
          )}
          <label>
            Tratamiento tributario
            <select
              value={treatment}
              onChange={(event) => {
                setTreatment(event.target.value as 'AFFECTED' | 'EXEMPT');
                setPreview(null);
              }}
            >
              <option value="AFFECTED">Afecto — IVA 0.19</option>
              <option value="EXEMPT">Exento — IVA 0</option>
            </select>
          </label>
        </section>

        <section className="panel request-form-grid">
          <h2>Documentos y glosa</h2>
          {rule && (
            <>
              <RequirementField
                label="Orden de compra"
                requirement={rule.purchaseOrderRequirement}
                value={purchaseOrder}
                onChange={setPurchaseOrder}
              />
              <RequirementField
                label="Contrato"
                requirement={rule.contractRequirement}
                value={contract}
                onChange={setContract}
              />
              <RequirementField
                label="HES"
                requirement={rule.hesRequirement}
                value={hes}
                onChange={setHes}
              />
            </>
          )}
          <label>
            Número de proveedor (opcional)
            <input
              value={supplierNumber}
              onChange={(event) => setSupplierNumber(event.target.value)}
              maxLength={200}
            />
          </label>
          <label className="wide-field">
            Glosa
            <textarea
              required
              maxLength={1000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <label className="wide-field">
            Observaciones (opcional)
            <textarea
              maxLength={4000}
              value={observations}
              onChange={(event) => setObservations(event.target.value)}
            />
          </label>
        </section>

        <section className="panel">
          <h2>Líneas CP/MS</h2>
          <div className="line-builder">
            <ProjectCenterAutocomplete clientId={client?.id ?? ''} onSelect={setSelectedCenter} />
            <label>
              Cantidad UF
              <input
                type="text"
                inputMode="decimal"
                value={ufAmount}
                onChange={(event) => setUfAmount(event.target.value)}
                placeholder="10,5 o 10.5"
              />
            </label>
            <button type="button" onClick={addLine}>
              Agregar línea
            </button>
          </div>
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
                  onClick={() => {
                    setLines(lines.filter((candidate) => candidate !== line));
                    setPreview(null);
                  }}
                >
                  Quitar
                </button>
              </article>
            ))}
          </div>
        </section>

        <section className="panel">
          <h2>Receptores de esta solicitud</h2>
          <p>Puede ajustar estos snapshots sin modificar el maestro del cliente.</p>
          <div className="receiver-list">
            {receivers.map((receiver, index) => (
              <article key={`${receiver.receiverId ?? 'temporary'}-${index}`}>
                <label>
                  Nombre
                  <input
                    value={receiver.displayName}
                    onChange={(event) =>
                      setReceivers(
                        receivers.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, displayName: event.target.value } : item,
                        ),
                      )
                    }
                  />
                </label>
                <label>
                  Correo
                  <input
                    type="email"
                    required
                    value={receiver.email}
                    onChange={(event) =>
                      setReceivers(
                        receivers.map((item, itemIndex) =>
                          itemIndex === index ? { ...item, email: event.target.value } : item,
                        ),
                      )
                    }
                  />
                </label>
                <button
                  type="button"
                  onClick={() =>
                    setReceivers(receivers.filter((_, itemIndex) => itemIndex !== index))
                  }
                >
                  Quitar
                </button>
              </article>
            ))}
          </div>
          <div className="line-builder">
            <label>
              Nombre temporal
              <input value={tempName} onChange={(event) => setTempName(event.target.value)} />
            </label>
            <label>
              Correo temporal
              <input
                type="email"
                value={tempEmail}
                onChange={(event) => setTempEmail(event.target.value)}
              />
            </label>
            <button type="button" onClick={addTemporaryReceiver}>
              Agregar receptor puntual
            </button>
          </div>
        </section>

        {preview && (
          <section className="panel" aria-live="polite">
            <h2>Previsualización LEGACY_V1</h2>
            <dl className="totals">
              <dt>Neto</dt>
              <dd>{formatClpString(preview.netClp)}</dd>
              <dt>IVA</dt>
              <dd>{formatClpString(preview.ivaClp)}</dd>
              <dt>Total</dt>
              <dd>{formatClpString(preview.totalClp)}</dd>
            </dl>
          </section>
        )}

        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="final-actions">
          <button type="button" onClick={() => void calculate()} disabled={busy}>
            Previsualizar cálculo
          </button>
          <button className="primary" disabled={busy}>
            {busy ? 'Generando y validando…' : 'Exportar Excel y guardar solicitud'}
          </button>
        </div>
      </form>
    </>
  );
}

export function InvoiceRequestHistory({ navigate }: { navigate: Navigate }): JSX.Element {
  const pageSize = 20;
  const [items, setItems] = useState<InvoiceRequestListItem[]>([]);
  const [q, setQ] = useState('');
  const [period, setPeriod] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [billingFrom, setBillingFrom] = useState('');
  const [billingTo, setBillingTo] = useState('');
  const [taxTreatment, setTaxTreatment] = useState('');
  const [status, setStatus] = useState('EXPORTED');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    const query = new URLSearchParams({ page: String(page), pageSize: String(pageSize) });
    if (q) query.set('q', q);
    if (period) query.set('period', period);
    if (from) query.set('from', from);
    if (to) query.set('to', to);
    if (billingFrom) query.set('billingFrom', billingFrom);
    if (billingTo) query.set('billingTo', billingTo);
    if (taxTreatment) query.set('taxTreatment', taxTreatment);
    if (status) query.set('status', status);
    setLoading(true);
    try {
      const result = await api<{ items: InvoiceRequestListItem[]; total?: number }>(
        `/invoice-requests?${query.toString()}`,
      );
      setItems(result.items);
      setTotal(result.total ?? result.items.length);
      setError('');
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [billingFrom, billingTo, from, page, period, q, status, taxTreatment, to]);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">Historial inmutable</p>
          <h1>Solicitudes de factura</h1>
          <p>Todas las solicitudes exportadas son visibles para ADMIN y COORDINATOR.</p>
        </div>
        <button className="primary" onClick={() => navigate('/solicitudes/nueva')}>
          Nueva solicitud
        </button>
      </div>
      <section className="panel">
        <form
          className="request-filters"
          onSubmit={(event) => {
            event.preventDefault();
            if (page === 1) void load();
            else setPage(1);
          }}
        >
          <label>
            Buscar
            <input value={q} onChange={(event) => setQ(event.target.value)} />
          </label>
          <label>
            Período
            <input
              type="month"
              value={period}
              onChange={(event) => setPeriod(event.target.value)}
            />
          </label>
          <label>
            Desde
            <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} />
          </label>
          <label>
            Hasta
            <input type="date" value={to} onChange={(event) => setTo(event.target.value)} />
          </label>
          <label>
            Facturación desde
            <input
              type="date"
              value={billingFrom}
              onChange={(event) => setBillingFrom(event.target.value)}
            />
          </label>
          <label>
            Facturación hasta
            <input
              type="date"
              value={billingTo}
              onChange={(event) => setBillingTo(event.target.value)}
            />
          </label>
          <label>
            Tratamiento
            <select value={taxTreatment} onChange={(event) => setTaxTreatment(event.target.value)}>
              <option value="">Todos</option>
              <option value="AFFECTED">Afecto</option>
              <option value="EXEMPT">Exento</option>
            </select>
          </label>
          <label>
            Estado
            <select value={status} onChange={(event) => setStatus(event.target.value)}>
              <option value="">Todos</option>
              <option value="EXPORTED">Factura solicitada</option>
            </select>
          </label>
          <button>Aplicar</button>
        </form>
      </section>
      {error && <p className="field-error">{error}</p>}
      <section className="panel request-table-wrap">
        {loading ? (
          <p aria-live="polite">Cargando historial…</p>
        ) : (
          <table className="request-table">
            <thead>
              <tr>
                <th>Folio</th>
                <th>Cliente</th>
                <th>Período</th>
                <th>Fecha facturación</th>
                <th>Responsable</th>
                <th>Neto</th>
                <th>IVA</th>
                <th>Total</th>
                <th>Estado</th>
                <th>Acciones</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td data-label="Folio">{item.folio}</td>
                  <td data-label="Cliente">{item.clientShortName}</td>
                  <td data-label="Período">{item.period}</td>
                  <td data-label="Fecha facturación">{item.billingDate}</td>
                  <td data-label="Responsable">{item.coordinatorDisplayName}</td>
                  <td data-label="Neto">{formatClpString(item.netClp)}</td>
                  <td data-label="IVA">{formatClpString(item.ivaClp)}</td>
                  <td data-label="Total">{formatClpString(item.totalClp)}</td>
                  <td data-label="Estado">{item.statusLabel}</td>
                  <td data-label="Acciones">
                    <div className="row-actions">
                      <button onClick={() => navigate(`/solicitudes/${item.id}`)}>Ver</button>
                      <button onClick={() => void download(`/invoice-requests/${item.id}/export`)}>
                        Descargar
                      </button>
                      <button onClick={() => navigate(`/solicitudes/${item.id}/duplicar`)}>
                        Duplicar
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <nav className="pagination" aria-label="Paginación de solicitudes">
        <button disabled={page === 1 || loading} onClick={() => setPage(page - 1)}>
          Anterior
        </button>
        <span>
          Página {page} · {total} solicitudes
        </span>
        <button disabled={loading || page * pageSize >= total} onClick={() => setPage(page + 1)}>
          Siguiente
        </button>
      </nav>
    </>
  );
}

export function InvoiceRequestDetailPage({
  id,
  navigate,
}: {
  id: string;
  navigate: Navigate;
}): JSX.Element {
  const [request, setRequest] = useState<InvoiceRequestDetail | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    void api<{ invoiceRequest: InvoiceRequestDetail }>(`/invoice-requests/${id}`)
      .then((result) => setRequest(result.invoiceRequest))
      .catch((cause: unknown) => setError(errorMessage(cause)));
  }, [id]);

  if (error) return <p className="field-error">{error}</p>;
  if (!request) return <p aria-live="polite">Cargando solicitud…</p>;
  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">{request.statusLabel}</p>
          <h1>{request.folio}</h1>
          <p>Registro histórico de solo lectura.</p>
        </div>
        <div className="actions">
          <button onClick={() => navigate('/solicitudes')}>Historial</button>
          <button onClick={() => navigate(`/solicitudes/${request.id}/duplicar`)}>Duplicar</button>
          <button
            className="primary"
            onClick={() => void download(`/invoice-requests/${request.id}/export`)}
          >
            Descargar Excel
          </button>
        </div>
      </div>
      <section className="panel detail-grid">
        <dl className="details">
          <dt>Cliente</dt>
          <dd>{request.clientShortName}</dd>
          <dt>Emisor</dt>
          <dd>{request.issuerCompanyLegalName}</dd>
          <dt>Responsable</dt>
          <dd>{request.coordinatorDisplayName}</dd>
          <dt>Período</dt>
          <dd>{request.period}</dd>
          <dt>Fecha solicitud</dt>
          <dd>{request.requestDate}</dd>
          <dt>Fecha facturación</dt>
          <dd>{request.billingDate}</dd>
          <dt>UF</dt>
          <dd>
            {request.ufValue} · {request.ufDate} · {request.ufSource}
          </dd>
          <dt>Tratamiento</dt>
          <dd>{request.taxTreatment}</dd>
          <dt>Área</dt>
          <dd>{request.area}</dd>
          <dt>OC</dt>
          <dd>{request.purchaseOrderNumber ?? 'N/A'}</dd>
          <dt>Contrato</dt>
          <dd>{request.contractNumber ?? 'N/A'}</dd>
          <dt>HES</dt>
          <dd>{request.hesNumber ?? 'N/A'}</dd>
          <dt>Número de proveedor</dt>
          <dd>{request.supplierNumber ?? 'N/A'}</dd>
          <dt>Glosa</dt>
          <dd>{request.description}</dd>
          <dt>Observaciones</dt>
          <dd>{request.observations ?? 'Sin observaciones'}</dd>
          <dt>Origen de duplicación</dt>
          <dd>{request.sourceRequestId ?? 'Solicitud original'}</dd>
          <dt>Versiones</dt>
          <dd>
            {request.calculationAlgorithmVersion} · {request.excelTemplateVariant} ·{' '}
            {request.excelTemplateVersion}
          </dd>
          <dt>Archivo</dt>
          <dd>
            {request.export.filename} · SHA-256 {request.export.sha256}
          </dd>
        </dl>
        <dl className="totals">
          <dt>Neto</dt>
          <dd>{formatClpString(request.netClp)}</dd>
          <dt>IVA</dt>
          <dd>{formatClpString(request.ivaClp)}</dd>
          <dt>Total</dt>
          <dd>{formatClpString(request.totalClp)}</dd>
        </dl>
      </section>
      <section className="panel">
        <h2>Líneas congeladas</h2>
        <div className="calculation-lines">
          {request.lines.map((line) => (
            <article key={line.id}>
              <div>
                <strong>{line.projectCenterCode}</strong>
                <span>
                  {line.projectName} · {line.productName}
                </span>
                <small>
                  {line.ufAmount} UF × {line.ufValue}
                </small>
              </div>
              <strong>{formatClpString(line.clpAmount)}</strong>
            </article>
          ))}
        </div>
      </section>
      <section className="panel">
        <h2>Receptores congelados</h2>
        <ul>
          {request.receivers.map((receiver) => (
            <li key={receiver.id}>
              {receiver.displayName ? `${receiver.displayName} — ` : ''}
              {receiver.email}
            </li>
          ))}
        </ul>
      </section>
    </>
  );
}
