import { useEffect, useId, useRef, useState } from 'react';
import type { ProjectCenter } from '@factuflow/shared-schemas';
import { api } from './api.js';

interface Props {
  readonly clientId: string;
  readonly onSelect: (projectCenter: ProjectCenter) => void;
}

export function ProjectCenterAutocomplete({ clientId, onSelect }: Props): JSX.Element {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<ProjectCenter[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const sequence = useRef(0);

  useEffect(() => {
    setQuery('');
    setItems([]);
    setOpen(false);
  }, [clientId]);

  useEffect(() => {
    if (!clientId || query.trim().length < 1) {
      setItems([]);
      setOpen(false);
      return;
    }
    const controller = new AbortController();
    const current = ++sequence.current;
    const timer = window.setTimeout(() => {
      const search = new URLSearchParams({ q: query, active: 'true', pageSize: '10' });
      void api<{ items: ProjectCenter[] }>(
        `/clients/${clientId}/project-centers?${search.toString()}`,
        { signal: controller.signal },
      )
        .then((result) => {
          if (current !== sequence.current) return;
          setItems(result.items);
          setOpen(true);
          setActive(result.items.length ? 0 : -1);
        })
        .catch((error: unknown) => {
          if (!(error instanceof DOMException && error.name === 'AbortError')) setItems([]);
        });
    }, 250);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [clientId, query]);

  const choose = (projectCenter: ProjectCenter) => {
    setQuery(`${projectCenter.code} — ${projectCenter.projectName}`);
    setOpen(false);
    setActive(-1);
    onSelect(projectCenter);
  };

  return (
    <div className="autocomplete">
      <label htmlFor={`${listId}-input`}>Buscar CP/MS</label>
      <input
        id={`${listId}-input`}
        value={query}
        disabled={!clientId}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        placeholder={clientId ? 'Código o nombre del proyecto' : 'Seleccione un cliente primero'}
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => items.length && setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setOpen(false);
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            setOpen(true);
            setActive((value) => Math.min(items.length - 1, value + 1));
          }
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            setActive((value) => Math.max(0, value - 1));
          }
          if (event.key === 'Enter' && open && active >= 0 && items[active]) {
            event.preventDefault();
            choose(items[active]);
          }
        }}
      />
      {open && (
        <ul id={listId} role="listbox" className="autocomplete-results">
          {items.map((projectCenter, index) => (
            <li
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              key={projectCenter.id}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(projectCenter);
              }}
            >
              <strong>{projectCenter.code}</strong>
              <span>
                {projectCenter.projectName}
                {projectCenter.productName ? ` · ${projectCenter.productName}` : ''}
              </span>
            </li>
          ))}
          {!items.length && <li className="empty-result">Sin CP/MS activos</li>}
        </ul>
      )}
    </div>
  );
}
