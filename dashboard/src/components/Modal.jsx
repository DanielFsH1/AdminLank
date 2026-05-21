import { useEffect } from 'react';

export function ModalShell({
  open = true,
  title,
  icon = null,
  children,
  onCancel,
  size = 'md',
  className = '',
  bodyClassName = '',
  onKeyDown,
}) {
  useEffect(() => {
    if (!open) return undefined;

    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCancel?.();
        return;
      }
      onKeyDown?.(event);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onCancel, onKeyDown]);

  if (!open) return null;

  const shellClassName = [
    'modal-shell',
    `modal-shell-${size}`,
    className,
  ].filter(Boolean).join(' ');

  return (
    <div className="modal-shell-overlay" role="presentation">
      <section className={shellClassName} role="dialog" aria-modal="true" aria-label={typeof title === 'string' ? title : undefined}>
        {(title || icon) && (
          <div className="modal-shell-header">
            {icon && <span className="modal-shell-icon">{icon}</span>}
            {title && <h3 className="modal-shell-title">{title}</h3>}
          </div>
        )}
        <div className={['modal-shell-body', bodyClassName].filter(Boolean).join(' ')}>
          {children}
        </div>
      </section>
    </div>
  );
}

export function ModalActions({
  onCancel,
  cancelLabel = 'Cancelar',
  primaryLabel,
  onPrimary,
  primaryDisabled = false,
  danger = false,
  secondaryLabel,
  onSecondary,
  secondaryDisabled = false,
  loading = false,
  loadingLabel = 'Guardando...',
  className = '',
}) {
  return (
    <div className={['modal-actions', className].filter(Boolean).join(' ')}>
      {onCancel && (
        <button type="button" className="modal-action-btn cancel" onClick={onCancel} disabled={loading}>
          {cancelLabel}
        </button>
      )}
      {secondaryLabel && (
        <button type="button" className="modal-action-btn secondary" onClick={onSecondary} disabled={secondaryDisabled || loading}>
          {secondaryLabel}
        </button>
      )}
      {primaryLabel && (
        <button
          type="button"
          className={`modal-action-btn ${danger ? 'danger' : 'primary'}`}
          onClick={onPrimary}
          disabled={primaryDisabled || loading}
        >
          {loading ? <><span className="spinner" /> {loadingLabel}</> : primaryLabel}
        </button>
      )}
    </div>
  );
}
