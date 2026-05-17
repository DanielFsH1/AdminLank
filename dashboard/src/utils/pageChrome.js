const LOADING_VARIANTS = new Set(['page', 'section', 'inline']);

export function normalizeLoadingVariant(variant) {
  return LOADING_VARIANTS.has(variant) ? variant : 'section';
}

export function getLoadingStateClass(variant = 'section') {
  return `loading-state loading-state-${normalizeLoadingVariant(variant)}`;
}

export function getPageTransitionClass(direction) {
  if (direction === 'left') {
    return 'page-transition-surface page-transition-forward';
  }
  if (direction === 'right') {
    return 'page-transition-surface page-transition-back';
  }
  return 'page-transition-surface';
}
