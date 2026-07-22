import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type {
  Client,
  ClientDetail,
  CoordinatorProfile,
  IssuerCompany,
  Product,
  ProjectCenter,
  Receiver,
} from '@factuflow/shared-schemas';
import { api, ApiError } from './api.js';
import { ClientAutocomplete } from './ClientAutocomplete.js';

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message : 'No fue posible completar la operación.';
}

type SimpleKind = 'issuer-companies' | 'coordinators' | 'products';
type SimpleItem = IssuerCompany | CoordinatorProfile | Product;

const simpleMeta = {
  'issuer-companies': { title: 'Empresas emisoras', singular: 'empresa emisora' },
  coordinators: { title: 'Responsables', singular: 'responsable' },
  products: { title: 'Productos', singular: 'producto' },
} as const;

export function SimpleMastersPage({ kind }: { readonly kind: SimpleKind }): JSX.Element {
  const meta = simpleMeta[kind];
  const [items, setItems] = useState<SimpleItem[]>([]);
  const [editing, setEditing] = useState<SimpleItem | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const result = await api<{ items: SimpleItem[] }>(
        `/${kind}?active=all&q=${encodeURIComponent(query)}`,
      );
      setItems(result.items);
      setError('');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [kind, query]);
  useEffect(() => {
    void load();
  }, [load]);

  const reset = () => {
    setEditing(null);
    setForm({});
  };
  const startEdit = (item: SimpleItem) => {
    setEditing(item);
    if (kind === 'issuer-companies') {
      const value = item as IssuerCompany;
      setForm({
        code: value.code,
        legalName: value.legalName,
        taxId: value.taxId,
        businessActivity: value.businessActivity,
        address: value.address,
        defaultTaxTreatment: value.defaultTaxTreatment,
        defaultIvaRate: value.defaultIvaRate,
      });
    } else if (kind === 'coordinators') {
      const value = item as CoordinatorProfile;
      setForm({ displayName: value.displayName, email: value.email ?? '' });
    } else {
      const value = item as Product;
      setForm({ code: value.code ?? '', name: value.name });
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    const body: Record<string, unknown> = { ...form };
    if (kind === 'products') body['code'] = form['code'] || null;
    if (kind === 'coordinators') {
      body['email'] = form['email'] || null;
      if (!editing) body['appUserId'] = null;
    }
    try {
      await api(`/admin/${kind}${editing ? `/${editing.id}` : ''}`, {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify(body),
      });
      reset();
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  };

  const toggle = async (item: SimpleItem) => {
    if (!window.confirm(`¿Confirma ${item.isActive ? 'desactivar' : 'activar'} este registro?`))
      return;
    try {
      await api(`/admin/${kind}/${item.id}/${item.isActive ? 'deactivate' : 'activate'}`, {
        method: 'POST',
      });
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">Maestros de facturación</p>
          <h1>{meta.title}</h1>
          <p>Administración sin eliminación física.</p>
        </div>
      </div>
      <section className="panel">
        <h2>{editing ? `Editar ${meta.singular}` : `Crear ${meta.singular}`}</h2>
        <form className="master-form" onSubmit={(event) => void submit(event)}>
          {kind === 'issuer-companies' && (
            <>
              <label>
                Código
                <input
                  required
                  value={form['code'] ?? ''}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                />
              </label>
              <label>
                Razón social
                <input
                  required
                  value={form['legalName'] ?? ''}
                  onChange={(e) => setForm({ ...form, legalName: e.target.value })}
                />
              </label>
              <label>
                RUT
                <input
                  required
                  placeholder="12.345.678-5"
                  value={form['taxId'] ?? ''}
                  onChange={(e) => setForm({ ...form, taxId: e.target.value })}
                />
              </label>
              <label>
                Giro
                <input
                  required
                  value={form['businessActivity'] ?? ''}
                  onChange={(e) => setForm({ ...form, businessActivity: e.target.value })}
                />
              </label>
              <label>
                Dirección
                <input
                  required
                  value={form['address'] ?? ''}
                  onChange={(e) => setForm({ ...form, address: e.target.value })}
                />
              </label>
              <label>
                Tratamiento
                <select
                  required
                  value={form['defaultTaxTreatment'] ?? 'AFFECTED'}
                  onChange={(e) => setForm({ ...form, defaultTaxTreatment: e.target.value })}
                >
                  <option value="AFFECTED">Afecto</option>
                  <option value="EXEMPT">Exento</option>
                </select>
              </label>
              <label>
                Tasa IVA
                <input
                  required
                  inputMode="decimal"
                  value={form['defaultIvaRate'] ?? '0.19'}
                  onChange={(e) => setForm({ ...form, defaultIvaRate: e.target.value })}
                />
              </label>
            </>
          )}
          {kind === 'coordinators' && (
            <>
              <label>
                Nombre visible
                <input
                  required
                  value={form['displayName'] ?? ''}
                  onChange={(e) => setForm({ ...form, displayName: e.target.value })}
                />
              </label>
              <label>
                Correo opcional
                <input
                  type="email"
                  value={form['email'] ?? ''}
                  onChange={(e) => setForm({ ...form, email: e.target.value })}
                />
              </label>
            </>
          )}
          {kind === 'products' && (
            <>
              <label>
                Código opcional
                <input
                  value={form['code'] ?? ''}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                />
              </label>
              <label>
                Nombre
                <input
                  required
                  value={form['name'] ?? ''}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </label>
            </>
          )}
          <div className="actions">
            <button className="primary" disabled={busy}>
              {editing ? 'Guardar cambios' : 'Crear'}
            </button>
            {editing && (
              <button type="button" onClick={reset}>
                Cancelar
              </button>
            )}
          </div>
        </form>
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
      </section>
      <section className="panel">
        <div className="filters">
          <label>
            Buscar
            <input value={query} onChange={(e) => setQuery(e.target.value)} />
          </label>
        </div>
        <div className="master-list" aria-label={`Listado de ${meta.title}`}>
          {items.map((item) => {
            const title =
              'legalName' in item
                ? item.legalName
                : 'displayName' in item
                  ? item.displayName
                  : item.name;
            const detail = 'taxId' in item ? item.taxId : 'email' in item ? item.email : item.code;
            return (
              <article key={item.id} className={item.isActive ? '' : 'inactive'}>
                <div>
                  <strong>{title}</strong>
                  <span>{detail || 'Sin dato opcional'}</span>
                </div>
                <div className="row-actions">
                  <button onClick={() => startEdit(item)}>Editar</button>
                  <button onClick={() => void toggle(item)}>
                    {item.isActive ? 'Desactivar' : 'Activar'}
                  </button>
                </div>
              </article>
            );
          })}
        </div>
      </section>
    </>
  );
}

const emptyClient = {
  shortName: '',
  legalName: '',
  taxId: '',
  businessActivity: '',
  address: '',
  dataStatus: 'PENDING_COMPLETION',
  defaultCoordinatorProfileId: '',
};

export function ClientsPage(): JSX.Element {
  const [items, setItems] = useState<Client[]>([]);
  const [coordinators, setCoordinators] = useState<CoordinatorProfile[]>([]);
  const [selected, setSelected] = useState<ClientDetail | null>(null);
  const [editing, setEditing] = useState<Client | null>(null);
  const [form, setForm] = useState(emptyClient);
  const [query, setQuery] = useState('');
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const [clients, responsible] = await Promise.all([
        api<{ items: Client[] }>(`/clients?active=all&q=${encodeURIComponent(query)}`),
        api<{ items: CoordinatorProfile[] }>('/coordinators?pageSize=100'),
      ]);
      setItems(clients.items);
      setCoordinators(responsible.items);
      setError('');
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [query]);
  useEffect(() => {
    void load();
  }, [load]);

  const open = async (client: Client) => {
    try {
      setSelected((await api<{ client: ClientDetail }>(`/clients/${client.id}`)).client);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const edit = (client: Client) => {
    setEditing(client);
    setForm({
      shortName: client.shortName,
      legalName: client.legalName ?? '',
      taxId: client.taxId ?? '',
      businessActivity: client.businessActivity ?? '',
      address: client.address ?? '',
      dataStatus: client.dataStatus,
      defaultCoordinatorProfileId: client.defaultCoordinatorProfileId ?? '',
    });
  };
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const payload = {
      ...form,
      legalName: form.legalName || null,
      taxId: form.taxId || null,
      businessActivity: form.businessActivity || null,
      address: form.address || null,
      defaultCoordinatorProfileId: form.defaultCoordinatorProfileId || null,
    };
    try {
      await api(`/admin/clients${editing ? `/${editing.id}` : ''}`, {
        method: editing ? 'PATCH' : 'POST',
        body: JSON.stringify(payload),
      });
      setEditing(null);
      setForm(emptyClient);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const toggle = async (client: Client) => {
    if (!window.confirm(`¿Confirma ${client.isActive ? 'desactivar' : 'activar'} este cliente?`))
      return;
    try {
      await api(`/admin/clients/${client.id}/${client.isActive ? 'deactivate' : 'activate'}`, {
        method: 'POST',
      });
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">Maestros de facturación</p>
          <h1>Clientes</h1>
          <p>Datos legales, completitud y configuración explícita.</p>
        </div>
      </div>
      <section className="panel">
        <h2>{editing ? 'Editar cliente' : 'Crear cliente'}</h2>
        <form className="master-form" onSubmit={(event) => void submit(event)}>
          <label>
            Nombre corto
            <input
              required
              value={form.shortName}
              onChange={(e) => setForm({ ...form, shortName: e.target.value })}
            />
          </label>
          <label>
            Razón social
            <input
              value={form.legalName}
              onChange={(e) => setForm({ ...form, legalName: e.target.value })}
            />
          </label>
          <label>
            RUT
            <input
              value={form.taxId}
              onChange={(e) => setForm({ ...form, taxId: e.target.value })}
            />
          </label>
          <label>
            Giro
            <input
              value={form.businessActivity}
              onChange={(e) => setForm({ ...form, businessActivity: e.target.value })}
            />
          </label>
          <label>
            Dirección
            <input
              value={form.address}
              onChange={(e) => setForm({ ...form, address: e.target.value })}
            />
          </label>
          <label>
            Completitud
            <select
              value={form.dataStatus}
              onChange={(e) => setForm({ ...form, dataStatus: e.target.value })}
            >
              <option value="PENDING_COMPLETION">Pendiente</option>
              <option value="COMPLETE">Completo</option>
            </select>
          </label>
          <label>
            Responsable sugerido
            <select
              value={form.defaultCoordinatorProfileId}
              onChange={(e) => setForm({ ...form, defaultCoordinatorProfileId: e.target.value })}
            >
              <option value="">Sin sugerencia</option>
              {coordinators.map((value) => (
                <option value={value.id} key={value.id}>
                  {value.displayName}
                </option>
              ))}
            </select>
          </label>
          <div className="actions">
            <button className="primary">{editing ? 'Guardar cambios' : 'Crear cliente'}</button>
            {editing && (
              <button
                type="button"
                onClick={() => {
                  setEditing(null);
                  setForm(emptyClient);
                }}
              >
                Cancelar
              </button>
            )}
          </div>
        </form>
        {error && (
          <p role="alert" className="field-error">
            {error}
          </p>
        )}
      </section>
      <section className="panel">
        <h2>Buscar y seleccionar</h2>
        <ClientAutocomplete onSelect={(client) => void open(client)} />
        <label>
          Filtro del listado
          <input value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
      </section>
      <section className="panel">
        <div className="master-list" aria-label="Listado de clientes">
          {items.map((client) => (
            <article key={client.id} className={client.isActive ? '' : 'inactive'}>
              <div className="client-summary">
                <strong>{client.shortName}</strong>
                <span>{client.legalName ?? 'Razón social pendiente'}</span>
                <span>
                  {client.taxId ?? 'Sin RUT'} ·{' '}
                  {client.dataStatus === 'COMPLETE' ? 'Completo' : 'Pendiente'}
                </span>
              </div>
              <div className="row-actions">
                <button onClick={() => void open(client)}>Detalle</button>
                <button onClick={() => edit(client)}>Editar</button>
                <button onClick={() => void toggle(client)}>
                  {client.isActive ? 'Desactivar' : 'Activar'}
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
      {selected && <ClientDetailPanel client={selected} refresh={() => void open(selected)} />}
    </>
  );
}

function ClientDetailPanel({
  client,
  refresh,
}: {
  readonly client: ClientDetail;
  readonly refresh: () => void;
}): JSX.Element {
  const [receivers, setReceivers] = useState<Receiver[]>([]);
  const [centers, setCenters] = useState<ProjectCenter[]>([]);
  const [email, setEmail] = useState('');
  const [receiverName, setReceiverName] = useState('');
  const [editingReceiver, setEditingReceiver] = useState<Receiver | null>(null);
  const [rule, setRule] = useState<{
    purchaseOrderRequirement: string;
    hesRequirement: string;
    contractRequirement: string;
    supplierNumber: string;
    defaultIssuerCompanyId: string;
    defaultTaxTreatment: string;
    excelTemplateVariant: string;
    billingNotes: string;
  }>({
    purchaseOrderRequirement: client.invoiceRule?.purchaseOrderRequirement ?? 'OPTIONAL',
    hesRequirement: client.invoiceRule?.hesRequirement ?? 'OPTIONAL',
    contractRequirement: client.invoiceRule?.contractRequirement ?? 'OPTIONAL',
    supplierNumber: client.invoiceRule?.supplierNumber ?? '',
    defaultIssuerCompanyId: client.invoiceRule?.defaultIssuerCompanyId ?? '',
    defaultTaxTreatment: client.invoiceRule?.defaultTaxTreatment ?? '',
    excelTemplateVariant: client.invoiceRule?.excelTemplateVariant ?? 'STANDARD',
    billingNotes: client.invoiceRule?.billingNotes ?? '',
  });
  const [issuers, setIssuers] = useState<IssuerCompany[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    setRule({
      purchaseOrderRequirement: client.invoiceRule?.purchaseOrderRequirement ?? 'OPTIONAL',
      hesRequirement: client.invoiceRule?.hesRequirement ?? 'OPTIONAL',
      contractRequirement: client.invoiceRule?.contractRequirement ?? 'OPTIONAL',
      supplierNumber: client.invoiceRule?.supplierNumber ?? '',
      defaultIssuerCompanyId: client.invoiceRule?.defaultIssuerCompanyId ?? '',
      defaultTaxTreatment: client.invoiceRule?.defaultTaxTreatment ?? '',
      excelTemplateVariant: client.invoiceRule?.excelTemplateVariant ?? 'STANDARD',
      billingNotes: client.invoiceRule?.billingNotes ?? '',
    });
  }, [client]);
  const loadChildren = useCallback(async () => {
    try {
      const [r, c, i] = await Promise.all([
        api<{ items: Receiver[] }>(`/clients/${client.id}/receivers?active=all`),
        api<{ items: ProjectCenter[] }>(`/clients/${client.id}/project-centers?active=all`),
        api<{ items: IssuerCompany[] }>('/issuer-companies?pageSize=100'),
      ]);
      setReceivers(r.items);
      setCenters(c.items);
      setIssuers(i.items);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [client.id]);
  useEffect(() => {
    void loadChildren();
  }, [loadChildren]);
  const saveRule = async () => {
    try {
      await api(`/admin/clients/${client.id}/invoice-rule`, {
        method: 'PUT',
        body: JSON.stringify({
          ...rule,
          supplierNumber: rule.supplierNumber || null,
          defaultIssuerCompanyId: rule.defaultIssuerCompanyId || null,
          defaultTaxTreatment: rule.defaultTaxTreatment || null,
          billingNotes: rule.billingNotes || null,
          isActive: true,
        }),
      });
      refresh();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const addReceiver = async (event: FormEvent) => {
    event.preventDefault();
    try {
      await api(
        editingReceiver
          ? `/admin/receivers/${editingReceiver.id}`
          : `/admin/clients/${client.id}/receivers`,
        {
          method: editingReceiver ? 'PATCH' : 'POST',
          body: JSON.stringify({ email, displayName: receiverName || null }),
        },
      );
      setEmail('');
      setReceiverName('');
      setEditingReceiver(null);
      await loadChildren();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const toggleReceiver = async (receiver: Receiver) => {
    if (!window.confirm(`¿Confirma ${receiver.isActive ? 'desactivar' : 'activar'} el receptor?`))
      return;
    try {
      await api(
        `/admin/receivers/${receiver.id}/${receiver.isActive ? 'deactivate' : 'activate'}`,
        { method: 'POST' },
      );
      await loadChildren();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const requirementOptions = (
    <>
      <option value="REQUIRED">Requerido</option>
      <option value="OPTIONAL">Opcional</option>
      <option value="NOT_APPLICABLE">No aplica</option>
    </>
  );
  return (
    <section className="panel" aria-label="Detalle del cliente">
      <h2>{client.shortName}</h2>
      <dl className="details">
        <dt>Razón social</dt>
        <dd>{client.legalName ?? 'Pendiente'}</dd>
        <dt>RUT</dt>
        <dd>{client.taxId ?? 'Pendiente'}</dd>
        <dt>Responsable sugerido</dt>
        <dd>{client.defaultCoordinatorDisplayName ?? 'Sin sugerencia'}</dd>
        <dt>Plantilla</dt>
        <dd>{client.invoiceRule?.excelTemplateVariant ?? 'Sin configurar'}</dd>
      </dl>
      <h3>Configuración de facturación</h3>
      <div className="master-form">
        <label>
          OC
          <select
            value={rule.purchaseOrderRequirement}
            onChange={(e) => setRule({ ...rule, purchaseOrderRequirement: e.target.value })}
          >
            {requirementOptions}
          </select>
        </label>
        <label>
          HES
          <select
            value={rule.hesRequirement}
            onChange={(e) => setRule({ ...rule, hesRequirement: e.target.value })}
          >
            {requirementOptions}
          </select>
        </label>
        <label>
          Contrato
          <select
            value={rule.contractRequirement}
            onChange={(e) => setRule({ ...rule, contractRequirement: e.target.value })}
          >
            {requirementOptions}
          </select>
        </label>
        <label>
          Número proveedor
          <input
            value={rule.supplierNumber}
            onChange={(e) => setRule({ ...rule, supplierNumber: e.target.value })}
          />
        </label>
        <label>
          Emisora sugerida
          <select
            value={rule.defaultIssuerCompanyId}
            onChange={(e) => setRule({ ...rule, defaultIssuerCompanyId: e.target.value })}
          >
            <option value="">Sin sugerencia</option>
            {issuers.map((issuer) => (
              <option key={issuer.id} value={issuer.id}>
                {issuer.legalName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Tratamiento sugerido
          <select
            value={rule.defaultTaxTreatment}
            onChange={(e) => setRule({ ...rule, defaultTaxTreatment: e.target.value })}
          >
            <option value="">Sin sugerencia</option>
            <option value="AFFECTED">Afecto</option>
            <option value="EXEMPT">Exento</option>
          </select>
        </label>
        <label>
          Plantilla
          <select
            value={rule.excelTemplateVariant}
            onChange={(e) => setRule({ ...rule, excelTemplateVariant: e.target.value })}
          >
            <option value="STANDARD">Standard</option>
            <option value="HABITAT">Habitat</option>
          </select>
        </label>
        <label>
          Notas
          <input
            value={rule.billingNotes}
            onChange={(e) => setRule({ ...rule, billingNotes: e.target.value })}
          />
        </label>
        <button className="primary" onClick={() => void saveRule()}>
          {client.invoiceRule ? 'Actualizar regla' : 'Crear regla'}
        </button>
      </div>
      <h3>Receptores</h3>
      <form className="inline-form" onSubmit={(event) => void addReceiver(event)}>
        <label>
          Nombre opcional
          <input value={receiverName} onChange={(e) => setReceiverName(e.target.value)} />
        </label>
        <label>
          Correo
          <input type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <button className="primary">{editingReceiver ? 'Guardar' : 'Agregar'}</button>
        {editingReceiver && (
          <button
            type="button"
            onClick={() => {
              setEditingReceiver(null);
              setEmail('');
              setReceiverName('');
            }}
          >
            Cancelar
          </button>
        )}
      </form>
      <ul>
        {receivers.map((receiver) => (
          <li key={receiver.id}>
            {receiver.displayName ? `${receiver.displayName} · ` : ''}
            {receiver.email} {receiver.isActive ? '' : '(inactivo)'}{' '}
            <button
              onClick={() => {
                setEditingReceiver(receiver);
                setEmail(receiver.email);
                setReceiverName(receiver.displayName ?? '');
              }}
            >
              Editar
            </button>{' '}
            <button onClick={() => void toggleReceiver(receiver)}>
              {receiver.isActive ? 'Desactivar' : 'Activar'}
            </button>
          </li>
        ))}
      </ul>
      <h3>CP/MS</h3>
      <ul>
        {centers.map((center) => (
          <li key={center.id}>
            {center.code}
            {center.productName ? ` · ${center.productName}` : ''}
          </li>
        ))}
      </ul>
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </section>
  );
}

export function ProjectCentersPage(): JSX.Element {
  const [client, setClient] = useState<Client | null>(null);
  const [items, setItems] = useState<ProjectCenter[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [form, setForm] = useState({
    productId: '',
    code: '',
    projectName: '',
    projectCenterType: 'ADMINISTRATION_OPERATION',
  });
  const [editing, setEditing] = useState<ProjectCenter | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    if (!client) return;
    try {
      const [centers, catalog] = await Promise.all([
        api<{ items: ProjectCenter[] }>(`/clients/${client.id}/project-centers?active=all`),
        api<{ items: Product[] }>('/products?pageSize=100'),
      ]);
      setItems(centers.items);
      setProducts(catalog.items);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [client]);
  useEffect(() => {
    void load();
  }, [load]);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!client) return;
    try {
      await api(
        editing
          ? `/admin/project-centers/${editing.id}`
          : `/admin/clients/${client.id}/project-centers`,
        {
          method: editing ? 'PATCH' : 'POST',
          body: JSON.stringify({ ...form, productId: form.productId || null }),
        },
      );
      setForm({
        productId: '',
        code: '',
        projectName: '',
        projectCenterType: 'ADMINISTRATION_OPERATION',
      });
      setEditing(null);
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  const toggle = async (item: ProjectCenter) => {
    try {
      await api(`/admin/project-centers/${item.id}/${item.isActive ? 'deactivate' : 'activate'}`, {
        method: 'POST',
      });
      await load();
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };
  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">Maestros de facturación</p>
          <h1>CP/MS</h1>
          <p>Centro de proyecto principal para facturar; producto es opcional.</p>
        </div>
      </div>
      <section className="panel">
        <ClientAutocomplete label="Seleccionar cliente" onSelect={setClient} />
      </section>
      {client && (
        <>
          <section className="panel">
            <h2>
              {editing ? 'Editar' : 'Crear'} CP/MS para {client.shortName}
            </h2>
            <form className="master-form" onSubmit={(event) => void submit(event)}>
              <label>
                Producto opcional
                <select
                  value={form.productId}
                  onChange={(e) => setForm({ ...form, productId: e.target.value })}
                >
                  <option value="">Sin producto asignado</option>
                  {products.map((product) => (
                    <option key={product.id} value={product.id}>
                      {product.name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Código
                <input
                  required
                  value={form.code}
                  onChange={(e) => setForm({ ...form, code: e.target.value })}
                />
              </label>
              <label>
                Proyecto
                <input
                  required
                  value={form.projectName}
                  onChange={(e) => setForm({ ...form, projectName: e.target.value })}
                />
              </label>
              <label>
                Tipo
                <select
                  value={form.projectCenterType}
                  onChange={(e) => setForm({ ...form, projectCenterType: e.target.value })}
                >
                  <option value="ADMINISTRATION_OPERATION">Administración/operación</option>
                  <option value="DEVELOPMENT_HOURS">Horas de desarrollo</option>
                  <option value="CONSTRUCTION">Construcción</option>
                </select>
              </label>
              <button className="primary">{editing ? 'Guardar cambios' : 'Crear'}</button>
              {editing && (
                <button
                  type="button"
                  onClick={() => {
                    setEditing(null);
                    setForm({
                      productId: '',
                      code: '',
                      projectName: '',
                      projectCenterType: 'ADMINISTRATION_OPERATION',
                    });
                  }}
                >
                  Cancelar
                </button>
              )}
            </form>
          </section>
          <section className="panel">
            <div className="master-list">
              {items.map((item) => (
                <article key={item.id} className={item.isActive ? '' : 'inactive'}>
                  <div>
                    <strong>{item.code}</strong>
                    <span>
                      {item.projectName}
                      {item.productName ? ` · ${item.productName}` : ' · Sin producto asignado'}
                    </span>
                  </div>
                  <div className="row-actions">
                    <button
                      onClick={() => {
                        setEditing(item);
                        setForm({
                          productId: item.productId ?? '',
                          code: item.code,
                          projectName: item.projectName,
                          projectCenterType: item.projectCenterType,
                        });
                      }}
                    >
                      Editar
                    </button>
                    <button onClick={() => void toggle(item)}>
                      {item.isActive ? 'Desactivar' : 'Activar'}
                    </button>
                  </div>
                </article>
              ))}
            </div>
          </section>
        </>
      )}
      {error && (
        <p role="alert" className="field-error">
          {error}
        </p>
      )}
    </>
  );
}
