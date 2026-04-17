import { SearchIcon, CloseIcon } from './Icons';

/**
 * Barra de búsqueda unificada para toda la app.
 *
 * Props:
 *  - value        (string)   texto actual
 *  - onChange      (fn)       setter del estado
 *  - placeholder   (string)   placeholder contextual
 *  - resultCount   (number?)  cantidad de resultados (muestra badge)
 *  - resultLabel   (string?)  texto del badge (default "resultado(s)")
 *  - children      (node?)    contenido extra debajo del input (chips, badges, etc.)
 */
export default function SearchBar({ value, onChange, placeholder, resultCount, resultLabel, children }) {
  return (
    <div className="searchbar">
      <div className="searchbar-box">
        <span className="searchbar-icon"><SearchIcon size={15} /></span>
        <input
          className="searchbar-input"
          type="text"
          placeholder={placeholder || 'Buscar...'}
          value={value}
          onChange={e => onChange(e.target.value)}
        />
        {value && (
          <button className="searchbar-clear" onClick={() => onChange('')} title="Limpiar búsqueda">
            <CloseIcon size={13} />
          </button>
        )}
      </div>
      {(resultCount != null || children) && value && value.length >= 2 && (
        <div className="searchbar-meta">
          {resultCount != null && (
            <span className={`badge ${resultCount > 0 ? 'badge-success' : 'badge-muted'}`} style={{ fontSize: '12px' }}>
              {resultCount > 0
                ? `${resultCount} ${resultLabel || `resultado${resultCount !== 1 ? 's' : ''}`}`
                : 'Sin resultados'}
            </span>
          )}
          {children}
        </div>
      )}
    </div>
  );
}
