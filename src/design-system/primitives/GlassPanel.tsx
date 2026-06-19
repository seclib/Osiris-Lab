'use client';

import React from 'react';
import { colors, borderRadius, spacing, zIndex } from '@/design-system/tokens';

/**
 * GlassPanel component — base UI primitive for SOC panels
 * 
 * Features:
 * - Glassmorphism effect (backdrop blur + semi-transparent bg)
 * - Optional border glow
 * - Responsive padding
 * - WCAG AA compliant contrast
 * 
 * @example
 * <GlassPanel>
 *   <span>Content</span>
 * </GlassPanel>
 * 
 * <GlassPanel variant="elevated" glow="gold">
 *   <span>Important panel</span>
 * </GlassPanel>
 */
export interface GlassPanelProps {
  /** Panel content */
  children: React.ReactNode;
  /** Visual variant */
  variant?: 'default' | 'elevated' | 'overlay';
  /** Glow accent color */
  glow?: 'gold' | 'cyan' | 'red' | 'none';
  /** Additional CSS classes */
  className?: string;
  /** Click handler */
  onClick?: (e: React.MouseEvent) => void;
  /** ARIA label */
  ariaLabel?: string;
  /** Test ID */
  testId?: string;
}

/**
 * Get variant styles
 */
function getVariantStyles(variant: GlassPanelProps['variant']): React.CSSProperties {
  switch (variant) {
    case 'elevated':
      return {
        background: colors.bg.elevated,
        borderColor: colors.border.primary,
      };
    case 'overlay':
      return {
        background: colors.overlay.dark,
        borderColor: colors.border.secondary,
      };
    default:
      return {
        background: colors.bg.surface,
        borderColor: colors.border.secondary,
      };
  }
}

/**
 * Get glow styles
 */
function getGlowStyles(glow: GlassPanelProps['glow']): React.CSSProperties {
  switch (glow) {
    case 'gold':
      return {
        boxShadow: `0 0 15px ${colors.gold.muted}, inset 0 0 15px ${colors.gold.muted}`,
        borderColor: colors.gold.muted,
      };
    case 'cyan':
      return {
        boxShadow: `0 0 15px ${colors.cyan.muted}, inset 0 0 15px ${colors.cyan.muted}`,
        borderColor: colors.cyan.muted,
      };
    case 'red':
      return {
        boxShadow: `0 0 15px rgba(255,61,61,0.15), inset 0 0 15px rgba(255,61,61,0.05)`,
        borderColor: 'rgba(255,61,61,0.3)',
      };
    default:
      return {};
  }
}

export const GlassPanel: React.FC<GlassPanelProps> = ({
  children,
  variant = 'default',
  glow = 'none',
  className = '',
  onClick,
  ariaLabel,
  testId,
}) => {
  const variantStyles = getVariantStyles(variant);
  const glowStyles = getGlowStyles(glow);

  const style: React.CSSProperties = {
    ...variantStyles,
    ...glowStyles,
    borderRadius: borderRadius.lg,
    padding: spacing.lg,
    backdropFilter: 'blur(12px)',
    WebkitBackdropFilter: 'blur(12px)',
    border: '1px solid',
    position: 'relative',
    zIndex: zIndex.panel,
    transition: 'all 0.2s ease',
  };

  return (
    <div
      className={className}
      style={style}
      onClick={onClick}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      aria-label={ariaLabel}
      data-testid={testId}
      onKeyDown={onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') onClick(e as unknown as React.MouseEvent); } : undefined}
    >
      {children}
    </div>
  );
};

GlassPanel.displayName = 'GlassPanel';