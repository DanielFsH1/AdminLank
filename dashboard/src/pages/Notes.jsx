import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useCollection } from '../hooks/useFirestore';
import { createNote, updateNote, deleteNote, toggleNotePin } from '../hooks/firestoreActions';
import { Toast } from '../components/EditModal';
import SearchBar from '../components/SearchBar';
import {
  PlusIcon, CheckCircleIcon, TrashIcon,
  CloseIcon, NotesIcon, ThumbtackIcon, EditIcon,
} from '../components/Icons';
import LoadingState from '../components/LoadingState';

const NOTE_COLORS = [
  { id: 'default', label: 'Gris', bg: 'var(--note-default)' },
  { id: 'blue', label: 'Azul', bg: 'var(--note-blue)' },
  { id: 'green', label: 'Verde', bg: 'var(--note-green)' },
  { id: 'yellow', label: 'Amarillo', bg: 'var(--note-yellow)' },
  { id: 'red', label: 'Rojo', bg: 'var(--note-red)' },
  { id: 'purple', label: 'Morado', bg: 'var(--note-purple)' },
];

function colorBg(colorId) {
  return NOTE_COLORS.find(c => c.id === colorId)?.bg || NOTE_COLORS[0].bg;
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' })
      + ' ' + d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit' });
  } catch { return iso; }
}

function truncate(text, max = 200) {
  if (!text || text.length <= max) return text || '';
  return text.slice(0, max) + '...';
}

// ─── Note Editor Modal ──────────────────────────────────────────────────────

function NoteEditor({ note, onClose, onSaved }) {
  const isNew = !note;
  const [title, setTitle] = useState(note?.title || '');
  const [content, setContent] = useState(note?.content || '');
  const [color, setColor] = useState(note?.color || 'default');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const titleRef = useRef(null);

  useEffect(() => {
    const timer = setTimeout(() => titleRef.current?.focus(), 200);
    return () => clearTimeout(timer);
  }, []);

  const handleSave = async () => {
    if (!title.trim() && !content.trim()) {
      setError('Escribe al menos un título o contenido');
      return;
    }
    setSaving(true);
    setError('');
    try {
      if (isNew) {
        await createNote({ title, content, color });
      } else {
        await updateNote(note.id, { title: title.trim(), content: content.trim(), color });
      }
      setSuccess(true);
      onSaved?.(isNew ? 'Nota creada' : 'Nota actualizada');
      setTimeout(() => onClose(), 600);
    } catch (err) {
      setError(err.message || 'Error al guardar');
      setSaving(false);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Escape') onClose();
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      handleSave();
    }
  };

  return (
    <div className="edit-modal-overlay" onClick={onClose} onKeyDown={handleKeyDown}>
      <div className="edit-modal note-editor-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '560px' }}>
        {success ? (
          <div className="edit-modal-success">
            <span className="edit-modal-success-icon"><CheckCircleIcon size={48} /></span>
            <div className="edit-modal-success-text">{isNew ? 'Nota creada' : 'Nota actualizada'}</div>
          </div>
        ) : (
          <>
            <div className="edit-modal-header">
              <span className="edit-modal-icon"><NotesIcon size={20} /></span>
              <h3 className="edit-modal-title">{isNew ? 'Nueva nota' : 'Editar nota'}</h3>
              <button className="edit-modal-close" onClick={onClose}><CloseIcon size={18} /></button>
            </div>

            <div className="edit-modal-body" style={{ padding: '16px 20px' }}>
              <input
                ref={titleRef}
                className="note-editor-title"
                placeholder="Título"
                value={title}
                onChange={e => setTitle(e.target.value)}
                maxLength={200}
              />
              <textarea
                className="note-editor-content"
                placeholder="Escribe tu nota..."
                value={content}
                onChange={e => setContent(e.target.value)}
                rows={10}
              />
              <div className="note-color-picker">
                <span className="note-color-label">Color</span>
                {NOTE_COLORS.map(c => (
                  <button
                    key={c.id}
                    className={`note-color-dot ${color === c.id ? 'active' : ''}`}
                    style={{ background: c.bg }}
                    title={c.label}
                    onClick={() => setColor(c.id)}
                  />
                ))}
              </div>
              {error && <div className="edit-modal-error">{error}</div>}
            </div>

            <div className="edit-modal-footer">
              <button className="btn-secondary" onClick={onClose} disabled={saving}>Cancelar</button>
              <button className="btn-primary" onClick={handleSave} disabled={saving}>
                {saving ? 'Guardando...' : 'Guardar'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// ─── Delete Confirmation ────────────────────────────────────────────────────

function DeleteConfirm({ note, onClose, onDeleted }) {
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState('');

  const handleDelete = async () => {
    setDeleting(true);
    try {
      await deleteNote(note.id);
      onDeleted?.('Nota eliminada');
      onClose();
    } catch (err) {
      setError(err.message || 'Error al eliminar');
      setDeleting(false);
    }
  };

  return (
    <div className="edit-modal-overlay" onClick={onClose}>
      <div className="edit-modal" onClick={e => e.stopPropagation()} style={{ maxWidth: '400px' }}>
        <div className="edit-modal-header">
          <span className="edit-modal-icon"><TrashIcon size={20} /></span>
          <h3 className="edit-modal-title">Eliminar nota</h3>
          <button className="edit-modal-close" onClick={onClose}><CloseIcon size={18} /></button>
        </div>
        <div className="edit-modal-body" style={{ padding: '20px', textAlign: 'center' }}>
          <p style={{ marginBottom: '8px' }}>
            ¿Eliminar <strong>{note.title || 'esta nota'}</strong>?
          </p>
          <p style={{ fontSize: '13px', color: 'var(--text-muted)' }}>Esta acción no se puede deshacer.</p>
          {error && <div className="edit-modal-error" style={{ marginTop: '12px' }}>{error}</div>}
        </div>
        <div className="edit-modal-footer">
          <button className="btn-secondary" onClick={onClose} disabled={deleting}>Cancelar</button>
          <button className="btn-danger" onClick={handleDelete} disabled={deleting}>
            {deleting ? 'Eliminando...' : 'Eliminar'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Note Card ──────────────────────────────────────────────────────────────

function NoteCard({ note, onEdit, onDelete, onTogglePin }) {
  return (
    <div
      className={`note-card ${note.pinned ? 'pinned' : ''}`}
      style={{ '--note-accent': colorBg(note.color) }}
      onClick={() => onEdit(note)}
    >
      <div className="note-card-color-bar" style={{ background: colorBg(note.color) }} />
      <div className="note-card-body">
        <div className="note-card-header">
          <h4 className="note-card-title">{note.title || 'Sin título'}</h4>
          <div className="note-card-actions">
            <button
              className={`note-action-btn ${note.pinned ? 'active' : ''}`}
              title={note.pinned ? 'Desfijar' : 'Fijar'}
              onClick={e => { e.stopPropagation(); onTogglePin(note); }}
            >
              <ThumbtackIcon size={14} />
            </button>
            <button
              className="note-action-btn"
              title="Editar"
              onClick={e => { e.stopPropagation(); onEdit(note); }}
            >
              <EditIcon size={14} />
            </button>
            <button
              className="note-action-btn danger"
              title="Eliminar"
              onClick={e => { e.stopPropagation(); onDelete(note); }}
            >
              <TrashIcon size={14} />
            </button>
          </div>
        </div>
        {note.content && (
          <p className="note-card-content">{truncate(note.content, 200)}</p>
        )}
        <div className="note-card-footer">
          {note.pinned && <span className="badge badge-info" style={{ fontSize: '10px', padding: '1px 6px' }}>Fijada</span>}
          <span className="note-card-date">{formatDate(note.updatedAt || note.createdAt)}</span>
        </div>
      </div>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function Notes() {
  const { data: notes, loading } = useCollection('notes');
  const [search, setSearch] = useState('');
  const [filterColor, setFilterColor] = useState('all');
  const [editorNote, setEditorNote] = useState(undefined); // undefined=closed, null=new, object=edit
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [toast, setToast] = useState({ visible: false, message: '', type: 'success' });

  const showToast = useCallback((message, type = 'success') => {
    setToast({ visible: true, message, type });
  }, []);

  const sorted = useMemo(() => {
    let filtered = notes;
    if (search.trim()) {
      const q = search.toLowerCase();
      filtered = filtered.filter(n =>
        (n.title || '').toLowerCase().includes(q) ||
        (n.content || '').toLowerCase().includes(q)
      );
    }
    if (filterColor !== 'all') {
      filtered = filtered.filter(n => (n.color || 'default') === filterColor);
    }
    return [...filtered].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '');
    });
  }, [notes, search, filterColor]);

  const handleTogglePin = async (note) => {
    try {
      await toggleNotePin(note.id, note.pinned);
    } catch {
      showToast('Error al fijar nota', 'error');
    }
  };

  const pinnedCount = useMemo(() => notes.filter(n => n.pinned).length, [notes]);

  if (loading) return <LoadingState variant="page" />;

  return (
    <div className="notes-page">
      {/* Section header */}
      <div className="section-header">
        <div className="section-title">
          <NotesIcon size={20} /> Bloc de Notas
        </div>
        <button className="alert-tab active-tint" onClick={() => setEditorNote(null)}>
          <PlusIcon size={14} /> Nueva nota
        </button>
      </div>

      {/* Search */}
      <SearchBar
        value={search}
        onChange={setSearch}
        placeholder="Buscar notas..."
        resultCount={search.length >= 2 ? sorted.length : undefined}
      >
        {/* Color filter chips */}
        <button
          className={`alert-tab ${filterColor === 'all' ? 'active' : ''}`}
          onClick={() => setFilterColor('all')}
          style={{ fontSize: '12px', padding: '4px 10px' }}
        >
          Todas
        </button>
        {NOTE_COLORS.map(c => (
          <button
            key={c.id}
            className={`alert-tab ${filterColor === c.id ? 'active' : ''}`}
            onClick={() => setFilterColor(filterColor === c.id ? 'all' : c.id)}
            style={{ fontSize: '12px', padding: '4px 10px' }}
          >
            <span style={{ width: 8, height: 8, borderRadius: '50%', background: c.bg, display: 'inline-block' }} />
            {c.label}
          </button>
        ))}
      </SearchBar>

      {/* Stats badges */}
      <div className="notes-stats-bar">
        <span className="badge badge-muted">{notes.length} nota{notes.length !== 1 ? 's' : ''}</span>
        {pinnedCount > 0 && <span className="badge badge-info">{pinnedCount} fijada{pinnedCount !== 1 ? 's' : ''}</span>}
      </div>

      {/* Notes grid */}
      {sorted.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon"><NotesIcon size={40} /></div>
          <p>{search || filterColor !== 'all' ? 'No se encontraron notas con esos filtros' : 'No hay notas todavía'}</p>
          {!search && filterColor === 'all' && (
            <button className="alert-tab active-tint" onClick={() => setEditorNote(null)} style={{ marginTop: '8px' }}>
              <PlusIcon size={14} /> Crear primera nota
            </button>
          )}
        </div>
      ) : (
        <div className="notes-grid">
          {sorted.map(note => (
            <NoteCard
              key={note.id}
              note={note}
              onEdit={() => setEditorNote(note)}
              onDelete={() => setDeleteTarget(note)}
              onTogglePin={() => handleTogglePin(note)}
            />
          ))}
        </div>
      )}

      {/* Editor modal */}
      {editorNote !== undefined && (
        <NoteEditor
          note={editorNote}
          onClose={() => setEditorNote(undefined)}
          onSaved={showToast}
        />
      )}

      {/* Delete confirm */}
      {deleteTarget && (
        <DeleteConfirm
          note={deleteTarget}
          onClose={() => setDeleteTarget(null)}
          onDeleted={showToast}
        />
      )}

      <Toast
        visible={toast.visible}
        message={toast.message}
        type={toast.type}
        onClose={() => setToast(t => ({ ...t, visible: false }))}
      />
    </div>
  );
}
