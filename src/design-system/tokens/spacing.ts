/**
 * OSIRIS Design System — Spacing & Sizing Tokens
 * 
 * Base unit: 4px
 */

export const spacing = {
  /** 4px */
  xs: '0.25rem',
  /** 8px */
  sm: '0.5rem',
  /** 12px */
  md: '0.75rem',
  /** 16px */
  lg: '1rem',
  /** 20px */
  xl: '1.25rem',
  /** 24px */
  '2xl': '1.5rem',
  /** 32px */
  '3xl': '2rem',
  /** 40px */
  '4xl': '2.5rem',
  /** 48px */
  '5xl': '3rem',
} as const;

export const fontSize = {
  /** 7px — Status bar */
  micro: '0.4375rem',
  /** 8px — Labels */
  xs: '0.5rem',
  /** 9px — Timestamps */
  sm: '0.5625rem',
  /** 11px — Body small */
  md: '0.6875rem',
  /** 13px — Body */
  lg: '0.8125rem',
  /** 15px — Subheadings */
  xl: '0.9375rem',
  /** 18px — Headings */
  '2xl': '1.125rem',
  /** 24px — Large headings */
  '3xl': '1.5rem',
  /** 36px — Display */
  '4xl': '2.25rem',
} as const;

export const borderRadius = {
  none: '0',
  sm: '0.25rem',
  md: '0.5rem',
  lg: '0.75rem',
  xl: '1rem',
  full: '9999px',
} as const;

export const zIndex = {
  base: 0,
  map: 1,
  panel: 200,
  overlay: 300,
  modal: 500,
  splash: 999,
  tooltip: 1000,
} as const;

export const breakpoint = {
  mobile: '768px',
  tablet: '1024px',
  desktop: '1280px',
  wide: '1536px',
} as const;

export type SpacingToken = typeof spacing;
export type FontSizeToken = typeof fontSize;
export type BorderRadiusToken = typeof borderRadius;
export type ZIndexToken = typeof zIndex;
export type BreakpointToken = typeof breakpoint;