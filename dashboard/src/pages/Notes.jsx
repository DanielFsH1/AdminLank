import { useState, useMemo, useCallback, useRef, useEffect } from 'react';
import { useCollection } from '../hooks/useFirestore';
import { createNote, updateNote, deleteNote, toggleNotePin } from '../hooks/firestoreActions';
import { Toast } from '../components/EditModal';
import {
  PlusIcon, SearchIcon, CheckCircleIcon, TrashIcon,
  CloseIcon, NotesIcon, ThumbtackIcon,
} from '../components/Icons';

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

function truncate(text, max = 120) {
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
      style={{ borderLeftColor: colorBg(note.color) }}
      onClick={() => onEdit(note)}
    >
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
        <span className="note-card-date">{formatDate(note.updatedAt || note.createdAt)}</span>
      </div>
    </div>
  );
}

// ─── Main Page ──────────────────────────────────────────────────────────────

export default function Notes() {
  const { data: notes, loading } = useCollection('notes');
  const [search, setSearch] = useState('');
  const [editorNote, setEditorNote] = useState(undefined); // undefined=closed, null=new, object=edit
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [toast, setToast] = useState(null);

  const showToast = useCallback((msg) => {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }, []);

  const sorted = useMemo(() => {
    let filtered = notes;
    if (search.trim()) {
      const q = search.toLowerCase();
      filtered = notes.filter(n =>
        (n.title || '').toLowerCase().includes(q) ||
        (n.content || '').toLowerCase().includes(q)
      );
    }
    return [...filtered].sort((a, b) => {
      if (a.pinned && !b.pinned) return -1;
      if (!a.pinned && b.pinned) return 1;
      return (b.updatedAt || b.createdAt || '').localeCompare(a.updatedAt || a.createdAt || '');
    });
  }, [notes, search]);

  const handleTogglePin = async (note) => {
    try {
      await toggleNotePin(note.id, note.pinned);
    } catch (err) {
      showToast('Error al fijar nota');
    }
  };

  const pinnedCount = useMemo(() => notes.filter(n => n.pinned).length, [notes]);

  return (
    <div className="notes-page">
      {/* Header bar */}
      <div className="notes-toolbar">
        <div className="notes-search-wrap">
          <SearchIcon size={16} />
          <input
            className="notes-search"
            placeholder="Buscar notas..."
            value={search}
            onChange={e => setSearch(e.target.value)}
          />
          {search && (
            <button className="notes-search-clear" onClick={() => setSearch('')}>
              <CloseIcon size={14} />
            </button>
          )}
        </div>
        <button className="btn-primary notes-add-btn" onClick={() => setEditorNote(null)}>
          <PlusIcon size={16} /> Nueva nota
        </button>
      </div>

      {/* Stats */}
      <div className="notes-stats">
        <span>{notes.length} nota{notes.length !== 1 ? 's' : ''}</span>
        {pinnedCount > 0 && <span> &middot; {pinnedCount} fijada{pinnedCount !== 1 ? 's' : ''}</span>}
        {search && <span> &middot; {sorted.length} resultado{sorted.length !== 1 ? 's' : ''}</span>}
      </div>

      {/* Notes grid */}
      {loading ? (
        <div className="loading-container"><div className="loading-spinner" /></div>
      ) : sorted.length === 0 ? (
        <div className="notes-empty">
          <NotesIcon size={48} />
          <p>{search ? 'No se encontraron notas' : 'No hay notas todavía'}</p>
          {!search && (
            <button className="btn-primary" onClick={() => setEditorNote(null)}>
              <PlusIcon size={16} /> Crear primera nota
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

      <Toast message={toast} onClose={() => setToast(null)} />
    </div>
  );
}
