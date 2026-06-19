'use client';

import React from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { spacing, zIndex, colors, fontSize } from '@/design-system/tokens';

/**
 * SplashScreen component — animated boot sequence
 * 
 * Features:
 * - Animated geometric logo with 3 rotating rings
 * - Letter-by-letter OSIRIS title reveal
 * - Typewriter subtitle
 * - Multi-stage progress bar with status messages
 * - CRT scanline overlay
 * - Corner frame accents
 * - WCAG: respects prefers-reduced-motion
 * 
 * @param show - Whether to show the splash screen
 * @param duration - Auto-dismiss duration in ms (default: 2500)
 * @param onComplete - Callback when splash animation completes
 */
export interface SplashScreenProps {
  show: boolean;
  duration?: number;
  onComplete?: () => void;
}

/**
 * Status stages for the progress bar
 */
const STATUS_STAGES = [
  { text: 'ESTABLISHING SECURE CONNECTION...', delay: 0.5 },
  { text: 'INITIALIZING FEEDS...', delay: 1.1 },
  { text: 'CALIBRATING SENSORS...', delay: 1.7 },
  { text: 'SYSTEM READY', delay: 2.2 },
] as const;

/**
 * Corner frame positions
 */
const CORNER_FRAMES = [
  { top: '10px', left: '10px', borderWidth: '2px 0 0 2px' },
  { top: '10px', right: '10px', borderWidth: '2px 2px 0 0' },
  { bottom: '10px', left: '10px', borderWidth: '0 0 2px 2px' },
  { bottom: '10px', right: '10px', borderWidth: '0 2px 2px 0' },
] as const;

export const SplashScreen: React.FC<SplashScreenProps> = ({
  show,
  duration = 2500,
  onComplete,
}) => {
  React.useEffect(() => {
    if (!show) return;

    const timer = setTimeout(() => {
      onComplete?.();
    }, duration);

    return () => clearTimeout(timer);
  }, [show, duration, onComplete]);

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.8, ease: 'easeInOut' }}
          className="fixed inset-0 flex flex-col items-center justify-center overflow-hidden"
          style={{
            zIndex: zIndex.splash,
            background: 'radial-gradient(ellipse at center, #0a0a14 0%, var(--bg-void) 70%)',
          }}
          aria-hidden={!show}
          role="status"
          aria-label="OSIRIS System Initializing"
        >
          {/* Scanline CRT overlay */}
          <div
            className="absolute inset-0 pointer-events-none"
            style={{
              zIndex: 1,
              backgroundImage:
                'repeating-linear-gradient(0deg, transparent, transparent 2px, rgba(212,175,55,0.015) 2px, rgba(212,175,55,0.015) 4px)',
              animation: 'splashScanDrift 8s linear infinite',
            }}
            aria-hidden="true"
          />

          {/* V4.2 badge */}
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.6 }}
            transition={{ delay: 0.8, duration: 0.5 }}
            className="absolute top-6 left-6 font-mono"
            style={{ zIndex: 2, fontSize: fontSize.xs, letterSpacing: '0.3em', color: colors.gold.primary }}
            aria-hidden="true"
          >
            V4.2
          </motion.div>

          {/* Geometric logo */}
          <GeometricLogo />

          {/* OSIRIS title */}
          <OsirisTitle />

          {/* Subtitle */}
          <Subtitle />

          {/* Progress bar */}
          <ProgressBar />

          {/* Decorative grid */}
          <DecorativeGrid />

          {/* Corner frames */}
          <CornerFrames />
        </motion.div>
      )}
    </AnimatePresence>
  );
};

SplashScreen.displayName = 'SplashScreen';

/**
 * Geometric animated logo
 */
const GeometricLogo: React.FC = React.memo(() => (
  <div
    className="relative w-40 h-40 mb-8 flex items-center justify-center"
    style={{ zIndex: 2 }}
    aria-hidden="true"
  >
    {/* Outer ring — slow clockwise */}
    <motion.div
      initial={{ opacity: 0, scale: 0.6, rotate: 0 }}
      animate={{ opacity: 1, scale: 1, rotate: 360 }}
      transition={{
        opacity: { duration: 0.6 },
        scale: { duration: 0.8, ease: 'easeOut' },
        rotate: { duration: 20, repeat: Infinity, ease: 'linear' },
      }}
      className="absolute inset-0 rounded-full"
      style={{ border: '1px solid rgba(212,175,55,0.2)' }}
    >
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 rounded-full"
        style={{ background: colors.gold.primary, boxShadow: '0 0 12px var(--gold-primary), 0 0 24px rgba(212,175,55,0.3)' }}
      />
      <div
        className="absolute bottom-0 left-1/2 -translate-x-1/2 translate-y-1/2 w-1 h-1 rounded-full"
        style={{ background: 'rgba(212,175,55,0.5)', boxShadow: '0 0 6px rgba(212,175,55,0.3)' }}
      />
    </motion.div>

    {/* Middle ring — faster counter-clockwise */}
    <motion.div
      initial={{ opacity: 0, scale: 0.4, rotate: 0 }}
      animate={{ opacity: 1, scale: 1, rotate: -360 }}
      transition={{
        opacity: { duration: 0.6, delay: 0.15 },
        scale: { duration: 0.8, delay: 0.15, ease: 'easeOut' },
        rotate: { duration: 12, repeat: Infinity, ease: 'linear' },
      }}
      className="absolute rounded-full"
      style={{ inset: '18px', border: '1px solid rgba(0,229,255,0.15)' }}
    >
      <div
        className="absolute top-1/2 right-0 translate-x-1/2 -translate-y-1/2 w-1.5 h-1.5 rounded-full"
        style={{ background: colors.cyan.primary, boxShadow: '0 0 10px var(--cyan-primary), 0 0 20px rgba(0,229,255,0.2)' }}
      />
    </motion.div>

    {/* Inner ring — fastest clockwise */}
    <motion.div
      initial={{ opacity: 0, scale: 0.2, rotate: 0 }}
      animate={{ opacity: 1, scale: 1, rotate: 360 }}
      transition={{
        opacity: { duration: 0.6, delay: 0.3 },
        scale: { duration: 0.8, delay: 0.3, ease: 'easeOut' },
        rotate: { duration: 7, repeat: Infinity, ease: 'linear' },
      }}
      className="absolute rounded-full"
      style={{ inset: '40px', border: '1px solid rgba(212,175,55,0.25)' }}
    >
      <div
        className="absolute top-0 left-1/4 -translate-y-1/2 w-1.5 h-1.5 rounded-full"
        style={{ background: colors.gold.primary, boxShadow: '0 0 8px var(--gold-primary)' }}
      />
    </motion.div>

    {/* Core circle + crosshair */}
    <motion.div
      initial={{ opacity: 0, scale: 0 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ delay: 0.4, duration: 0.6, ease: [0.34, 1.56, 0.64, 1] }}
      className="relative w-12 h-12 rounded-full flex items-center justify-center"
      style={{ border: '2px solid var(--gold-primary)', boxShadow: '0 0 20px rgba(212,175,55,0.15), inset 0 0 20px rgba(212,175,55,0.05)' }}
    >
      <motion.div
        animate={{ opacity: [0.3, 0.8, 0.3] }}
        transition={{ duration: 2, repeat: Infinity, ease: 'easeInOut' }}
        className="w-5 h-5 rounded-full"
        style={{ background: 'radial-gradient(circle, rgba(212,175,55,0.4) 0%, rgba(212,175,55,0.05) 70%)' }}
      />
      <div
        className="absolute w-px h-full"
        style={{ background: 'linear-gradient(to bottom, transparent, rgba(212,175,55,0.3), transparent)' }}
      />
      <div
        className="absolute w-full h-px"
        style={{ background: 'linear-gradient(to right, transparent, rgba(212,175,55,0.3), transparent)' }}
      />
    </motion.div>

    {/* Radar sweep */}
    <motion.div
      initial={{ opacity: 0 }}
      animate={{ opacity: [0, 0.15, 0], rotate: [0, 360] }}
      transition={{
        opacity: { duration: 3, repeat: Infinity },
        rotate: { duration: 3, repeat: Infinity, ease: 'linear' },
        delay: 0.6,
      }}
      className="absolute inset-[10px] rounded-full"
      style={{ background: 'conic-gradient(from 0deg, transparent 0deg, rgba(212,175,55,0.15) 40deg, transparent 80deg)' }}
    />
  </div>
));

GeometricLogo.displayName = 'GeometricLogo';

/**
 * OSIRIS title — letter-by-letter stagger
 */
const OsirisTitle: React.FC = React.memo(() => (
  <div
    className="flex items-center gap-[2px] mb-3"
    style={{ zIndex: 2 }}
    aria-hidden="true"
  >
    {'OSIRIS'.split('').map((letter, i) => (
      <motion.span
        key={i}
        initial={{ opacity: 0, y: 20, filter: 'blur(8px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        transition={{ delay: 0.5 + i * 0.08, duration: 0.5, ease: 'easeOut' }}
        className="font-bold tracking-[0.5em] font-mono"
        style={{
          fontSize: '2.25rem',
          color: colors.text.heading,
          textShadow: '0 0 30px rgba(212,175,55,0.2)',
        }}
      >
        {letter}
      </motion.span>
    ))}
  </div>
));

OsirisTitle.displayName = 'OsirisTitle';

/**
 * Subtitle — typewriter reveal
 */
const Subtitle: React.FC = React.memo(() => (
  <div className="overflow-hidden mb-8" style={{ zIndex: 2 }}>
    <motion.div
      initial={{ width: 0 }}
      animate={{ width: '100%' }}
      transition={{ delay: 1.2, duration: 0.8, ease: 'easeInOut' }}
      className="overflow-hidden whitespace-nowrap"
    >
      <p
        className="font-mono tracking-[0.5em]"
        style={{ fontSize: fontSize.sm, color: colors.gold.primary, opacity: 0.8 }}
      >
        GLOBAL INTELLIGENCE PLATFORM
      </p>
    </motion.div>
  </div>
));

Subtitle.displayName = 'Subtitle';

/**
 * Multi-stage progress bar with cycling status messages
 */
const ProgressBar: React.FC = React.memo(() => (
  <div className="w-64 md:w-80" style={{ zIndex: 2 }}>
    {/* Progress track */}
    <div
      className="relative w-full h-[2px] rounded-full overflow-hidden"
      style={{ background: 'rgba(212,175,55,0.1)' }}
    >
      <motion.div
        initial={{ width: '0%' }}
        animate={{ width: ['0%', '25%', '50%', '78%', '100%'] }}
        transition={{
          duration: 2.2,
          delay: 0.5,
          times: [0, 0.25, 0.5, 0.75, 1],
          ease: 'easeInOut',
        }}
        className="absolute inset-y-0 left-0 rounded-full"
        style={{
          background: 'linear-gradient(90deg, var(--gold-primary), var(--cyan-primary), var(--gold-primary))',
          boxShadow: '0 0 12px rgba(212,175,55,0.4)',
        }}
      />
    </div>

    {/* Status messages */}
    <div className="mt-3 h-4 flex items-center justify-center">
      {STATUS_STAGES.map((stage, i) => (
        <motion.span
          key={i}
          initial={{ opacity: 0 }}
          animate={{ opacity: [0, 1, 1, 0] }}
          transition={{ delay: stage.delay, duration: 0.6, times: [0, 0.1, 0.7, 1] }}
          className="absolute font-mono tracking-[0.25em]"
          style={{
            fontSize: fontSize.micro,
            color: i === 3 ? colors.cyan.primary : colors.text.muted,
          }}
        >
          {stage.text}
        </motion.span>
      ))}
    </div>
  </div>
));

ProgressBar.displayName = 'ProgressBar';

/**
 * Decorative grid lines
 */
const DecorativeGrid: React.FC = React.memo(() => (
  <div
    className="absolute inset-0 pointer-events-none"
    style={{ zIndex: 0, opacity: 0.03 }}
    aria-hidden="true"
  >
    <div
      className="absolute inset-0"
      style={{
        backgroundImage:
          'linear-gradient(rgba(212,175,55,0.5) 1px, transparent 1px), linear-gradient(90deg, rgba(212,175,55,0.5) 1px, transparent 1px)',
        backgroundSize: '60px 60px',
      }}
    />
  </div>
));

DecorativeGrid.displayName = 'DecorativeGrid';

/**
 * Corner frame accents
 */
const CornerFrames: React.FC = React.memo(() => (
  <>
    {CORNER_FRAMES.map((pos, i) => (
      <motion.div
        key={i}
        initial={{ opacity: 0 }}
        animate={{ opacity: 0.3 }}
        transition={{ delay: 0.8 + i * 0.1, duration: 0.5 }}
        className="absolute w-8 h-8"
        style={{
          zIndex: 2,
          ...pos,
          borderWidth: pos.borderWidth,
          borderStyle: 'solid',
          borderColor: colors.gold.primary,
        }}
        aria-hidden="true"
      />
    ))}
  </>
));

CornerFrames.displayName = 'CornerFrames';