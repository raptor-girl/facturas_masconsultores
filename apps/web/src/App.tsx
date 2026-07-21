import { useEffect, useState, type FormEvent } from 'react';
import type {
  AuthResponse,
  PublicUser,
  Session,
  TemporaryPasswordResult,
} from '@factuflow/shared-schemas';
import { api, ApiError } from './api.js';
import { AuthProvider, useAuth } from './auth.js';
import { ClientsPage, ProjectCentersPage, SimpleMastersPage } from './MasterPages.js';

function usePath(): [string, (path: string) => void] {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    window.addEventListener('popstate', update);
    return () => window.removeEventListener('popstate', update);
  }, []);
  return [
    path,
    (next) => {
      window.history.pushState({}, '', next);
      setPath(next);
    },
  ];
}

function message(error: unknown): string {
  return error instanceof ApiError ? error.message : 'No fue posible conectar con FactuFlow.';
}

function Login({ navigate }: { navigate: (path: string) => void }): JSX.Element {
  const { login } = useAuth();
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    setBusy(true);
    try {
      const user = await login(identifier, password);
      navigate(user.mustChangePassword ? '/cambiar-contrasena' : '/');
    } catch {
      setError('Credenciales inválidas.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={(event) => void submit(event)}>
        <div className="brand">
          <span>F</span>
          <div>
            <strong>FactuFlow</strong>
            <small>Acceso seguro</small>
          </div>
        </div>
        <h1>Iniciar sesión</h1>
        <p>Use su cuenta personal. FactuFlow no admite cuentas compartidas.</p>
        <label htmlFor="identifier">Username o correo</label>
        <input
          id="identifier"
          autoComplete="username"
          required
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
          autoFocus
        />
        <label htmlFor="password">Contraseña</label>
        <input
          id="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          {busy ? 'Ingresando…' : 'Ingresar'}
        </button>
      </form>
    </main>
  );
}

function ChangePassword({ navigate }: { navigate: (path: string) => void }): JSX.Element {
  const { user, refresh, logout } = useAuth();
  const [currentPassword, setCurrent] = useState('');
  const [newPassword, setNext] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError('');
    if (newPassword !== confirmation) {
      setError('Las contraseñas nuevas no coinciden.');
      return;
    }
    setBusy(true);
    try {
      await api('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      await refresh();
      navigate('/');
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="auth-page">
      <form className="auth-card" onSubmit={(e) => void submit(e)}>
        <h1>Cambiar contraseña</h1>
        <p>
          {user?.mustChangePassword
            ? 'Debe reemplazar su contraseña temporal antes de continuar.'
            : 'Actualice la contraseña de su cuenta.'}
        </p>
        <label htmlFor="current">Contraseña actual</label>
        <input
          id="current"
          type="password"
          autoComplete="current-password"
          required
          value={currentPassword}
          onChange={(e) => setCurrent(e.target.value)}
        />
        <label htmlFor="new">Nueva contraseña</label>
        <input
          id="new"
          type="password"
          autoComplete="new-password"
          minLength={12}
          maxLength={128}
          required
          value={newPassword}
          onChange={(e) => setNext(e.target.value)}
        />
        <small>Mínimo 12 caracteres y combinación de letras, números o símbolos.</small>
        <label htmlFor="confirm">Confirmar nueva contraseña</label>
        <input
          id="confirm"
          type="password"
          autoComplete="new-password"
          required
          value={confirmation}
          onChange={(e) => setConfirmation(e.target.value)}
        />
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <button className="primary" disabled={busy}>
          Guardar contraseña
        </button>
        <button type="button" className="link-button" onClick={() => void logout()}>
          Cerrar sesión
        </button>
      </form>
    </main>
  );
}

function Shell({
  children,
  navigate,
}: {
  children: React.ReactNode;
  navigate: (path: string) => void;
}): JSX.Element {
  const { user, logout } = useAuth();
  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="wordmark" onClick={() => navigate('/')}>
          FactuFlow
        </button>
        <nav aria-label="Navegación principal">
          <button onClick={() => navigate('/')}>Inicio</button>
          <button onClick={() => navigate('/mi-cuenta')}>Mi cuenta</button>
          {user?.roles.includes('ADMIN') && (
            <>
              <button onClick={() => navigate('/admin/usuarios')}>Usuarios</button>
              <button onClick={() => navigate('/admin/empresas-emisoras')}>
                Empresas emisoras
              </button>
              <button onClick={() => navigate('/admin/responsables')}>Responsables</button>
              <button onClick={() => navigate('/admin/clientes')}>Clientes</button>
              <button onClick={() => navigate('/admin/productos')}>Productos</button>
              <button onClick={() => navigate('/admin/cp-ms')}>CP/MS</button>
            </>
          )}
        </nav>
        <div className="user-menu">
          <span>
            {user?.displayName}
            <small>{user?.roles.join(' · ')}</small>
          </span>
          <button onClick={() => void logout().then(() => navigate('/login'))}>
            Cerrar sesión
          </button>
        </div>
      </header>
      <main className="content">{children}</main>
    </div>
  );
}

function Dashboard(): JSX.Element {
  const { user } = useAuth();
  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">Fase 2</p>
          <h1>Hola, {user?.displayName}</h1>
          <p>Autenticación y administración de acceso están operativas.</p>
        </div>
      </div>
      <section className="panel">
        <h2>Estado de la cuenta</h2>
        <dl className="details">
          <dt>Username</dt>
          <dd>{user?.username}</dd>
          <dt>Roles</dt>
          <dd>{user?.roles.join(', ')}</dd>
          <dt>Último acceso</dt>
          <dd>
            {user?.lastLoginAt ? new Date(user.lastLoginAt).toLocaleString() : 'Primer acceso'}
          </dd>
        </dl>
      </section>
    </>
  );
}

function Account(): JSX.Element {
  const { user } = useAuth();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [error, setError] = useState('');
  const load = async () => {
    try {
      setSessions((await api<{ sessions: Session[] }>('/auth/sessions')).sessions);
    } catch (cause) {
      setError(message(cause));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const revoke = async (id: string) => {
    await api(`/auth/sessions/${id}`, { method: 'DELETE' });
    await load();
  };
  return (
    <>
      <div className="page-title">
        <div>
          <h1>Mi cuenta</h1>
          <p>Información personal y sesiones activas.</p>
        </div>
        <a className="button" href="/cambiar-contrasena">
          Cambiar contraseña
        </a>
      </div>
      <section className="panel">
        <dl className="details">
          <dt>Nombre</dt>
          <dd>{user?.displayName}</dd>
          <dt>Correo</dt>
          <dd>{user?.email}</dd>
          <dt>Roles</dt>
          <dd>{user?.roles.join(', ')}</dd>
        </dl>
      </section>
      <section className="panel">
        <div className="panel-title">
          <h2>Sesiones</h2>
          <button
            onClick={() => void api('/auth/sessions/revoke-others', { method: 'POST' }).then(load)}
          >
            Revocar las demás
          </button>
        </div>
        {error && <p className="field-error">{error}</p>}
        <div className="session-list">
          {sessions.map((session) => (
            <article key={session.id}>
              <div>
                <strong>
                  {session.current ? 'Sesión actual' : (session.userAgent ?? 'Navegador')}
                </strong>
                <small>Última actividad: {new Date(session.lastSeenAt).toLocaleString()}</small>
                <small>IP minimizada: {session.ip ?? 'No disponible'}</small>
              </div>
              <button onClick={() => void revoke(session.id)}>Revocar</button>
            </article>
          ))}
        </div>
      </section>
    </>
  );
}

function TemporaryDialog({
  password,
  close,
}: {
  password: string;
  close: () => void;
}): JSX.Element {
  return (
    <div className="modal-backdrop" role="presentation">
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="temporary-title">
        <h2 id="temporary-title">Contraseña temporal</h2>
        <p>
          Se mostrará una sola vez. Entréguela por un canal seguro; el usuario deberá cambiarla.
        </p>
        <output>{password}</output>
        <div className="actions">
          <button onClick={() => void navigator.clipboard.writeText(password)}>Copiar</button>
          <button className="primary" onClick={close} autoFocus>
            Entendido
          </button>
        </div>
      </div>
    </div>
  );
}

function UserEditor({
  user,
  close,
  saved,
}: {
  user: PublicUser;
  close: () => void;
  saved: () => void;
}): JSX.Element {
  const [displayName, setName] = useState(user.displayName);
  const [username, setUsername] = useState(user.username);
  const [email, setEmail] = useState(user.email);
  const [error, setError] = useState('');
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api(`/admin/users/${user.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ displayName, username, email }),
      });
      saved();
    } catch (cause) {
      setError(message(cause));
    }
  };
  return (
    <div className="modal-backdrop">
      <form
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="edit-title"
        onSubmit={(e) => void submit(e)}
      >
        <h2 id="edit-title">Editar usuario</h2>
        <label htmlFor="edit-name">Nombre</label>
        <input
          id="edit-name"
          value={displayName}
          onChange={(e) => setName(e.target.value)}
          required
        />
        <label htmlFor="edit-user">Username</label>
        <input
          id="edit-user"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          required
        />
        <label htmlFor="edit-email">Correo</label>
        <input
          id="edit-email"
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
        />
        {error && <p className="field-error">{error}</p>}
        <div className="actions">
          <button type="button" onClick={close}>
            Cancelar
          </button>
          <button className="primary">Guardar</button>
        </div>
      </form>
    </div>
  );
}

function AdminUsers(): JSX.Element {
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [search, setSearch] = useState('');
  const [active, setActive] = useState('');
  const [error, setError] = useState('');
  const [temporary, setTemporary] = useState('');
  const [editing, setEditing] = useState<PublicUser | null>(null);
  const [form, setForm] = useState({
    displayName: '',
    username: '',
    email: '',
    admin: false,
    coordinator: true,
  });
  const load = async () => {
    const query = new URLSearchParams();
    if (search) query.set('search', search);
    if (active) query.set('active', active);
    try {
      setUsers((await api<{ users: PublicUser[] }>(`/admin/users?${query}`)).users);
      setError('');
    } catch (cause) {
      setError(message(cause));
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const result = await api<TemporaryPasswordResult>('/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          displayName: form.displayName,
          username: form.username,
          email: form.email,
          roles: [form.admin && 'ADMIN', form.coordinator && 'COORDINATOR'].filter(Boolean),
        }),
      });
      setTemporary(result.temporaryPassword);
      setForm({ displayName: '', username: '', email: '', admin: false, coordinator: true });
      await load();
    } catch (cause) {
      setError(message(cause));
    }
  };
  const action = async (path: string, method = 'POST') => {
    try {
      const result = await api<TemporaryPasswordResult | AuthResponse | { ok: true }>(path, {
        method,
      });
      if ('temporaryPassword' in result) setTemporary(result.temporaryPassword);
      await load();
    } catch (cause) {
      setError(message(cause));
    }
  };
  const roles = async (user: PublicUser, role: 'ADMIN' | 'COORDINATOR') => {
    const next = user.roles.includes(role)
      ? user.roles.filter((item) => item !== role)
      : [...user.roles, role];
    if (!next.length) {
      setError('Cada usuario debe conservar al menos un rol.');
      return;
    }
    await api(`/admin/users/${user.id}/roles`, {
      method: 'PUT',
      body: JSON.stringify({ roles: next }),
    })
      .then(load)
      .catch((cause) => setError(message(cause)));
  };
  return (
    <>
      <div className="page-title">
        <div>
          <p className="eyebrow">Administración</p>
          <h1>Usuarios</h1>
          <p>Cuentas personales, roles y sesiones.</p>
        </div>
      </div>
      <section className="panel">
        <h2>Crear usuario</h2>
        <form className="create-grid" onSubmit={(e) => void create(e)}>
          <label>
            Nombre visible
            <input
              value={form.displayName}
              onChange={(e) => setForm({ ...form, displayName: e.target.value })}
              required
            />
          </label>
          <label>
            Username
            <input
              value={form.username}
              onChange={(e) => setForm({ ...form, username: e.target.value })}
              required
            />
          </label>
          <label>
            Correo
            <input
              type="email"
              value={form.email}
              onChange={(e) => setForm({ ...form, email: e.target.value })}
              required
            />
          </label>
          <fieldset>
            <legend>Roles</legend>
            <label>
              <input
                type="checkbox"
                checked={form.admin}
                onChange={(e) => setForm({ ...form, admin: e.target.checked })}
              />{' '}
              ADMIN
            </label>
            <label>
              <input
                type="checkbox"
                checked={form.coordinator}
                onChange={(e) => setForm({ ...form, coordinator: e.target.checked })}
              />{' '}
              COORDINATOR
            </label>
          </fieldset>
          <button className="primary">Crear y generar contraseña</button>
        </form>
      </section>
      <section className="panel">
        <form
          className="filters"
          onSubmit={(e) => {
            e.preventDefault();
            void load();
          }}
        >
          <label>
            Buscar
            <input value={search} onChange={(e) => setSearch(e.target.value)} />
          </label>
          <label>
            Estado
            <select value={active} onChange={(e) => setActive(e.target.value)}>
              <option value="">Todos</option>
              <option value="true">Activos</option>
              <option value="false">Inactivos</option>
            </select>
          </label>
          <button>Aplicar</button>
        </form>
        {error && (
          <p className="field-error" role="alert">
            {error}
          </p>
        )}
        <div className="user-list">
          {users.map((user) => (
            <article key={user.id} className={!user.isActive ? 'inactive' : ''}>
              <div className="user-summary">
                <strong>{user.displayName}</strong>
                <span>
                  @{user.username} · {user.email}
                </span>
                <small>
                  {user.isActive ? 'Activo' : 'Inactivo'} ·{' '}
                  {user.mustChangePassword ? 'Cambio pendiente' : 'Contraseña vigente'}
                </small>
              </div>
              <div className="role-buttons">
                <button
                  aria-pressed={user.roles.includes('ADMIN')}
                  onClick={() => void roles(user, 'ADMIN')}
                >
                  ADMIN
                </button>
                <button
                  aria-pressed={user.roles.includes('COORDINATOR')}
                  onClick={() => void roles(user, 'COORDINATOR')}
                >
                  COORDINATOR
                </button>
              </div>
              <div className="row-actions">
                <button onClick={() => setEditing(user)}>Editar</button>
                <button
                  onClick={() =>
                    void action(
                      `/admin/users/${user.id}/${user.isActive ? 'deactivate' : 'activate'}`,
                    )
                  }
                >
                  {user.isActive ? 'Desactivar' : 'Activar'}
                </button>
                <button onClick={() => void action(`/admin/users/${user.id}/reset-password`)}>
                  Restablecer
                </button>
                <button onClick={() => void action(`/admin/users/${user.id}/sessions/revoke-all`)}>
                  Revocar sesiones
                </button>
              </div>
            </article>
          ))}
        </div>
      </section>
      {temporary && <TemporaryDialog password={temporary} close={() => setTemporary('')} />}
      {editing && (
        <UserEditor
          user={editing}
          close={() => setEditing(null)}
          saved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </>
  );
}

function RoutedApp(): JSX.Element {
  const { user, loading } = useAuth();
  const [path, navigate] = usePath();
  if (loading)
    return (
      <main className="loading" aria-live="polite">
        Cargando FactuFlow…
      </main>
    );
  if (!user) return <Login navigate={navigate} />;
  if (user.mustChangePassword) return <ChangePassword navigate={navigate} />;
  if (path === '/login') {
    navigate('/');
    return <></>;
  }
  const content =
    path === '/mi-cuenta' ? (
      <Account />
    ) : path === '/cambiar-contrasena' ? (
      <ChangePassword navigate={navigate} />
    ) : path === '/admin/usuarios' && user.roles.includes('ADMIN') ? (
      <AdminUsers />
    ) : path === '/admin/empresas-emisoras' && user.roles.includes('ADMIN') ? (
      <SimpleMastersPage kind="issuer-companies" />
    ) : path === '/admin/responsables' && user.roles.includes('ADMIN') ? (
      <SimpleMastersPage kind="coordinators" />
    ) : path === '/admin/clientes' && user.roles.includes('ADMIN') ? (
      <ClientsPage />
    ) : path === '/admin/productos' && user.roles.includes('ADMIN') ? (
      <SimpleMastersPage kind="products" />
    ) : path === '/admin/cp-ms' && user.roles.includes('ADMIN') ? (
      <ProjectCentersPage />
    ) : (
      <Dashboard />
    );
  return <Shell navigate={navigate}>{content}</Shell>;
}

export default function App(): JSX.Element {
  return (
    <AuthProvider>
      <RoutedApp />
    </AuthProvider>
  );
}
