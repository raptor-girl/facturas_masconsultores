import { useEffect, useId, useRef, useState } from 'react';
import type { Client } from '@factuflow/shared-schemas';
import { api } from './api.js';

interface Props {
  readonly onSelect: (client: Client) => void;
  readonly label?: string;
}

export function ClientAutocomplete({ onSelect, label = 'Buscar cliente' }: Props): JSX.Element {
  const listId = useId();
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<Client[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const sequence = useRef(0);

  useEffect(() => {
    if (query.trim().length < 2) {
      setItems([]);
      setOpen(false);
      return;
    }
    const controller = new AbortController();
    const current = ++sequence.current;
    const timer = window.setTimeout(() => {
      void api<{ items: Client[] }>(`/clients/search?q=${encodeURIComponent(query)}&pageSize=8`, {
        signal: controller.signal,
      })
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
  }, [query]);

  const choose = (client: Client) => {
    setQuery(client.shortName);
    setOpen(false);
    setActive(-1);
    onSelect(client);
  };

  return (
    <div className="autocomplete">
      <label htmlFor={`${listId}-input`}>{label}</label>
      <input
        id={`${listId}-input`}
        value={query}
        role="combobox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
        autoComplete="off"
        onChange={(event) => setQuery(event.target.value)}
        onFocus={() => items.length && setOpen(true)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            setOpen(false);
            return;
          }
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
          {items.map((client, index) => (
            <li
              id={`${listId}-${index}`}
              role="option"
              aria-selected={index === active}
              key={client.id}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(client);
              }}
            >
              <strong>{client.shortName}</strong>
              <span>
                {client.legalName ?? 'Datos pendientes'} · {client.taxId ?? 'Sin RUT'}
              </span>
            </li>
          ))}
          {!items.length && <li className="empty-result">Sin resultados</li>}
        </ul>
      )}
    </div>
  );
}
