'use client';

import { useState, useEffect } from 'react';
import { breakpoint } from '@/design-system/tokens';

/**
 * Hook for responsive mobile detection
 * 
 * Returns true if the viewport is mobile width
 * Returns true if viewport is landscape phone (short height + moderate width)
 * 
 * @returns {boolean} Whether the viewport is mobile
 */
export function useIsMobile(): boolean {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const check = () => {
      const w = window.innerWidth;
      const h = window.innerHeight;
      const mobileWidth = parseInt(breakpoint.mobile, 10);
      setIsMobile(w < mobileWidth || (h < 500 && w < 1024));
    };

    check();
    window.addEventListener('resize', check);
    window.addEventListener('orientationchange', check);

    return () => {
      window.removeEventListener('resize', check);
      window.removeEventListener('orientationchange', check);
    };
  }, []);

  return isMobile;
}