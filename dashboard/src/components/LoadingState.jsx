import { getLoadingStateClass } from '../utils/pageChrome';

export default function LoadingState({ variant = 'section', label = '', className = '' }) {
  const classes = [getLoadingStateClass(variant), className].filter(Boolean).join(' ');

  return (
    <div className={classes} role="status" aria-live="polite">
      <div className="loading-spinner" aria-hidden="true" />
      {label && <p>{label}</p>}
    </div>
  );
}
