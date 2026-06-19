'use client';

import { useState, useEffect, useRef } from 'react';

/**
 * Clock format type
 */
export type ClockFormat = 'zulu' | 'uptime' | 'local';

/**
 * Hook for real-time clock display
 * 
 * @param format - Clock format ('zulu' | 'uptime' | 'local')
 * @returns Formatted time string
 * 
 * @example
 * const zuluTime = useClock('zulu');
 * const uptime = useClock('uptime');
 */
export function useClock(format: ClockFormat): string {
  const [time, setTime] = useState('');
  const startTimeRef = useRef(0);

  useEffect(() => {
    // Initialize start time for uptime inside effect (pure function rule)
    if (format === 'uptime' && startTimeRef.current === 0) {
      startTimeRef.current = Date.now();
    }

    const tick = () => {
      const now = new Date();

      switch (format) {
        case 'zulu': {
          const hours = String(now.getUTCHours()).padStart(2, '0');
          const minutes = String(now.getUTCMinutes()).padStart(2, '0');
          const seconds = String(now.getUTCSeconds()).padStart(2, '0');
          setTime(`ZULU ${hours}:${minutes}:${seconds}Z`);
          break;
        }
        case 'uptime': {
          const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
          const hrs = String(Math.floor(elapsed / 3600)).padStart(2, '0');
          const mins = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
          const secs = String(elapsed % 60).padStart(2, '0');
          setTime(`UPTIME ${hrs}:${mins}:${secs}`);
          break;
        }
        case 'local': {
          const hours = String(now.getHours()).padStart(2, '0');
          const minutes = String(now.getMinutes()).padStart(2, '0');
          setTime(`${hours}:${minutes}`);
          break;
        }
      }
    };

    tick();
    const interval = setInterval(tick, 1000);

    return () => clearInterval(interval);
  }, [format]);

  return time;
}