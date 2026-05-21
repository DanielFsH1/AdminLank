import { useState, useEffect, useRef } from 'react';
import { CheckCircleIcon, WarningIcon, CheckIcon, XCircleIcon } from './Icons';
import { ModalActions, ModalShell } from './Modal';

const EMPTY_INITIAL_VALUES = {};

/**
 * Modal reutilizable para edición de datos.
 * Incluye paso de confirmación "¿Estás seguro?" antes de guardar.
 * 
 * Props:
 * - open: boolean
 * - onClose: () => void
 * - onSave: (values) => Promise<void>
 * - title: string
 * - icon: string (emoji)
 * - fields: Array<{ key, label, type?, placeholder?, options?, required?, hint? }>
 * - initialValues: { [key]: value }
 * - saveLabel?: string
 * - danger?: boolean (estilo de botón peligroso)
 * - confirmMessage?: string (mensaje personalizado de confirmación)
 * - children?: ReactNode (contenido extra antes de los campos)
 */
export default function EditModal({
  open, onClose, onSave, title, icon, fields = [], initialValues = EMPTY_INITIAL_VALUES,
  saveLabel = 'Guardar', danger = false, confirmMessage, children,
  resetKey, validate,
}) {
  const [values, setValues] = useState({});
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const [confirmStep, setConfirmStep] = useState(false);
  const firstInput = useRef(null);
  const initialValuesRef = useRef(initialValues);

  useEffect(() => {
    initialValuesRef.current = initialValues;
  }, [initialValues]);

  useEffect(() => {
    if (open) {
      setValues({ ...initialValuesRef.current });
      setError('');
      setSuccess(false);
      setSaving(false);
      setConfirmStep(false);
      const focusTimer = setTimeout(() => firstInput.current?.focus(), 200);
      return () => clearTimeout(focusTimer);
    }
  }, [open, resetKey]);

  if (!open) return null;

  const handleChange = (key, val) => {
    setValues(prev => ({ ...prev, [key]: val }));
    setError('');
  };

  const handleRequestSave = () => {
    // Validar campos requeridos
    for (const f of fields) {
      if (f.required && !values[f.key]?.toString().trim()) {
        setError(`"${f.label}" es obligatorio`);
        return;
      }
    }
    // Validación personalizada (si se proporcionó)
    if (validate) {
      const validationError = validate(values);
      if (validationError) {
        setError(validationError);
        return;
      }
    }
    // Mostrar paso de confirmación
    setConfirmStep(true);
  };

  const handleConfirmSave = async () => {
    setSaving(true);
    setError('');
    try {
      await onSave(values);
      setSuccess(true);
      setTimeout(() => {
        onClose();
        setSuccess(false);
      }, 800);
    } catch (err) {
      console.error('Error al guardar:', err);
      setError(err.message || 'Error al guardar los cambios');
      setSaving(false);
      setConfirmStep(false);
    }
  };

  return (
    <ModalShell
      open={open}
      onCancel={onClose}
      title={success ? null : (confirmStep ? 'Confirmar cambios' : title)}
      icon={success ? null : (confirmStep ? <WarningIcon size={20} /> : icon)}
      className="edit-modal"
      bodyClassName={success ? '' : undefined}
    >
        {success ? (
          <div className="edit-modal-success">
            <span className="edit-modal-success-icon"><CheckCircleIcon size={48} /></span>
            <div className="edit-modal-success-text">Cambios guardados</div>
          </div>
        ) : confirmStep ? (
          /* ── Paso de confirmación ── */
          <div style={{ padding: '32px 24px', textAlign: 'center' }}>
            <div style={{ marginBottom: '12px' }}><WarningIcon size={40} /></div>
            <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '12px' }}>¿Estás seguro?</h3>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '24px' }}>
              {confirmMessage || 'Esta acción modificará los datos en el sistema.'}
            </p>
            {/* Resumen de cambios */}
            <div style={{
              background: 'var(--bg-input)', border: '1px solid var(--border-color)',
              borderRadius: 'var(--radius-md)', padding: '12px 16px', marginBottom: '20px',
              textAlign: 'left', fontSize: '13px',
            }}>
              {fields.filter(f => values[f.key]).map(f => (
                <div key={f.key} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0' }}>
                  <span style={{ color: 'var(--text-muted)' }}>{f.label}:</span>
                  <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>{values[f.key]}</span>
                </div>
              ))}
            </div>
            <ModalActions
              onCancel={onClose}
              secondaryLabel="Volver a editar"
              onSecondary={() => setConfirmStep(false)}
              primaryLabel={<><CheckIcon size={16} /> Sí, confirmar</>}
              onPrimary={handleConfirmSave}
              loading={saving}
              danger={danger}
            />
            {error && <div className="edit-modal-error" style={{ marginTop: '12px' }}><WarningIcon size={14} /> {error}</div>}
          </div>
        ) : (
          /* ── Formulario de edición ── */
          <>
            {children && <div className="edit-modal-extra">{children}</div>}

            <div className="edit-modal-body">
              {fields.map((f, i) => (
                <div className="edit-modal-field" key={f.key}>
                  <label className="edit-modal-label">{f.label}{f.required && <span className="edit-modal-required">*</span>}</label>
                  {f.type === 'select' ? (
                    <select
                      className="edit-modal-input"
                      value={values[f.key] || ''}
                      onChange={e => handleChange(f.key, e.target.value)}
                      ref={i === 0 ? firstInput : undefined}
                    >
                      <option value="">{f.placeholder || 'Seleccionar...'}</option>
                      {(f.options || []).map(opt => (
                        <option key={typeof opt === 'string' ? opt : opt.value} value={typeof opt === 'string' ? opt : opt.value}>
                          {typeof opt === 'string' ? opt : opt.label}
                        </option>
                      ))}
                    </select>
                  ) : f.type === 'select-day' ? (
                    <select
                      className="edit-modal-input"
                      value={values[f.key] || ''}
                      onChange={e => handleChange(f.key, e.target.value ? parseInt(e.target.value) : '')}
                      ref={i === 0 ? firstInput : undefined}
                    >
                      <option value="">{f.placeholder || 'Seleccionar día...'}</option>
                      {Array.from({ length: 31 }, (_, i) => i + 1).map(d => (
                        <option key={d} value={d}>Día {d}</option>
                      ))}
                    </select>
                  ) : f.type === 'textarea' ? (
                    <textarea
                      className="edit-modal-input edit-modal-textarea"
                      value={values[f.key] || ''}
                      onChange={e => handleChange(f.key, e.target.value)}
                      placeholder={f.placeholder || ''}
                      ref={i === 0 ? firstInput : undefined}
                      rows={3}
                    />
                  ) : (
                    <input
                      className="edit-modal-input"
                      type={f.type || 'text'}
                      value={values[f.key] || ''}
                      onChange={e => handleChange(f.key, e.target.value)}
                      placeholder={f.placeholder || ''}
                      ref={i === 0 ? firstInput : undefined}
                    />
                  )}
                  {f.hint && <span className="edit-modal-hint">{f.hint}</span>}
                </div>
              ))}
            </div>

            {error && <div className="edit-modal-error"><WarningIcon size={14} /> {error}</div>}

            <ModalActions
              onCancel={onClose}
              primaryLabel={saveLabel}
              onPrimary={handleRequestSave}
              danger={danger}
            />
          </>
        )}
    </ModalShell>
  );
}

/**
 * Diálogo de confirmación simple (sin campos de edición).
 * Siempre muestra "¿Estás seguro?" con acción y cancelar.
 * 
 * Props:
 * - open: boolean
 * - onClose: () => void
 * - onConfirm: () => Promise<void>
 * - title: string
 * - message: string
 * - confirmLabel?: string
 * - danger?: boolean
 * - icon?: string
 */
export function ConfirmDialog({ open, onClose, onConfirm, title, message, confirmLabel = 'Confirmar', danger = false, icon = null }) {
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (open) { setLoading(false); setSuccess(false); setError(''); }
  }, [open]);

  if (!open) return null;

  const handleConfirm = async () => {
    setLoading(true);
    setError('');
    try {
      await onConfirm();
      setSuccess(true);
      setTimeout(() => { onClose(); setSuccess(false); }, 700);
    } catch (err) {
      console.error(err);
      setError(err.message || 'Error al procesar la solicitud');
      setLoading(false);
    }
  };

  return (
    <ModalShell open={open} onCancel={onClose} size="sm" className="edit-modal">
        {success ? (
          <div className="edit-modal-success">
            <span className="edit-modal-success-icon"><CheckCircleIcon size={48} /></span>
            <div className="edit-modal-success-text">Listo</div>
          </div>
        ) : (
          <div style={{ padding: '32px 24px', textAlign: 'center' }}>
            <div style={{ marginBottom: '8px' }}>{typeof icon === 'string' ? <WarningIcon size={40} /> : icon}</div>
            <h3 style={{ fontSize: '18px', fontWeight: 700, marginBottom: '10px' }}>{title}</h3>
            <p style={{ fontSize: '14px', color: 'var(--text-secondary)', lineHeight: 1.6, marginBottom: '24px' }}>{message}</p>
            {error && <div className="edit-modal-error" style={{ marginBottom: '12px' }}><WarningIcon size={14} /> {error}</div>}
            <ModalActions
              onCancel={onClose}
              primaryLabel={confirmLabel}
              onPrimary={handleConfirm}
              loading={loading}
              loadingLabel="Procesando..."
              danger={danger}
            />
          </div>
        )}
    </ModalShell>
  );
}

/**
 * Componente Toast para notificaciones flotantes.
 */
export function Toast({ message, type = 'success', visible, onClose }) {
  useEffect(() => {
    if (visible) {
      const timer = setTimeout(onClose, 3000);
      return () => clearTimeout(timer);
    }
  }, [visible, onClose]);

  if (!visible) return null;

  const toastIcons = {
    success: <CheckCircleIcon size={18} />,
    error: <XCircleIcon size={18} />,
    info: <WarningIcon size={18} color="#3b82f6" />,
  };

  return (
    <div className={`toast toast-${type} ${visible ? 'toast-visible' : ''}`}>
      <span className="toast-icon">{toastIcons[type]}</span>
      <span className="toast-message">{message}</span>
    </div>
  );
}
