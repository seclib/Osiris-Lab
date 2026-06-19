/**
 * OSIRIS Design System — Color Tokens
 * 
 * Dark mode SOC platform
 * WCAG AA compliant
 */

export const colors = {
  // Background
  bg: {
    void: '#06060C',
    surface: '#0A0A14',
    elevated: '#12121E',
    overlay: '#1A1A2E',
  },
  // Text
  text: {
    primary: '#E8E8F0',
    secondary: '#A0A0B8',
    muted: '#6B6B80',
    heading: '#F0F0FF',
    inverse: '#06060C',
  },
  // Accents
  gold: {
    primary: '#D4AF37',
    light: '#E8C84A',
    dark: '#B8962E',
    muted: 'rgba(212,175,55,0.2)',
  },
  cyan: {
    primary: '#00E5FF',
    light: '#33EAFF',
    dark: '#00B3CC',
    muted: 'rgba(0,229,255,0.15)',
  },
  // Semantic
  alert: {
    green: '#39FF14',
    red: '#FF3D3D',
    amber: '#FFB300',
    info: '#448AFF',
  },
  // Borders
  border: {
    primary: 'rgba(255,255,255,0.08)',
    secondary: 'rgba(255,255,255,0.04)',
    focus: 'rgba(212,175,55,0.5)',
  },
  // Overlay
  overlay: {
    dark: 'rgba(0,0,0,0.7)',
    light: 'rgba(255,255,255,0.04)',
  },
} as const;

export type ColorToken = typeof colors;