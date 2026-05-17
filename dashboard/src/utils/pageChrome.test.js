import { describe, expect, it } from 'vitest';
import {
  getLoadingStateClass,
  getPageTransitionClass,
  normalizeLoadingVariant,
} from './pageChrome';

describe('page chrome helpers', () => {
  it('maps tab navigation direction to stable transition classes', () => {
    expect(getPageTransitionClass(null)).toBe('page-transition-surface');
    expect(getPageTransitionClass('left')).toBe('page-transition-surface page-transition-forward');
    expect(getPageTransitionClass('right')).toBe('page-transition-surface page-transition-back');
    expect(getPageTransitionClass('unknown')).toBe('page-transition-surface');
  });

  it('normalizes loading state variants', () => {
    expect(normalizeLoadingVariant('page')).toBe('page');
    expect(normalizeLoadingVariant('inline')).toBe('inline');
    expect(normalizeLoadingVariant('bad')).toBe('section');
    expect(getLoadingStateClass('page')).toBe('loading-state loading-state-page');
  });
});
