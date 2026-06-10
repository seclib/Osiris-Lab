'use client';

import dynamic from 'next/dynamic';
import type { EventBbox, IntelligenceFeatureCollection } from '@/lib/event-stream';

const OsirisMap = dynamic(() => import('@/components/OsirisMap'), { ssr: false });

type MapCanvasProps = {
  data: Record<string, unknown>;
  activeLayers: Record<string, boolean>;
  projection: 'mercator' | 'globe';
  mapStyle: string;
  onEntityClick?: (entity: unknown) => void;
  onMouseCoords?: (coords: { lat: number; lng: number }) => void;
  onRightClick?: (coords: { lat: number; lng: number }) => void;
  onViewStateChange?: (viewState: { zoom: number; latitude: number; longitude: number }) => void;
  onBoundsChange?: (bbox: EventBbox) => void;
  flyToLocation?: { lat: number; lng: number; ts: number } | null;
  sweepData?: unknown;
  scanTargets?: unknown[];
  demoMode?: boolean;
  intelligenceEvents: IntelligenceFeatureCollection;
};

export default function MapCanvas(props: MapCanvasProps) {
  return <OsirisMap {...props} />;
}

