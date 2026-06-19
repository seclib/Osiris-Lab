import type { LucideIcon } from 'lucide-react';
import { BrainCircuit, Flame, Plane, SearchCode, Ship } from 'lucide-react';

export type UiModuleId = 'adsb' | 'ais' | 'intelligence' | 'heatmaps' | 'shodan';
export type ModulePersistence = 'backend' | 'local';
export type ModuleDisplayStatus = 'loading' | 'online' | 'degraded' | 'offline' | 'disabled';

export type ModuleDescriptor = {
  id: UiModuleId;
  registryId?: string;
  label: string;
  shortLabel: string;
  description: string;
  persistence: ModulePersistence;
  optional?: boolean;
  layerKeys: string[];
  enableLayerKeys: string[];
  icon: LucideIcon;
  accent: string;
};

export const MODULE_STORAGE_KEY = 'osiris.ui.module-state.v1';
export const MODULE_ADMIN_TOKEN_STORAGE_KEY = 'osiris.module-admin-token.session.v1';

export const MODULE_DESCRIPTORS: ModuleDescriptor[] = [
  {
    id: 'adsb',
    registryId: 'adsb',
    label: 'ADS-B Aviation',
    shortLabel: 'ADS-B',
    description: 'Aircraft tracks and aviation overlays',
    persistence: 'backend',
    layerKeys: ['flights', 'private', 'jets', 'military'],
    enableLayerKeys: ['flights'],
    icon: Plane,
    accent: '#00E5FF',
  },
  {
    id: 'ais',
    registryId: 'ais',
    label: 'AIS Maritime',
    shortLabel: 'AIS',
    description: 'Vessel, port, and chokepoint tracking',
    persistence: 'backend',
    layerKeys: ['maritime'],
    enableLayerKeys: ['maritime'],
    icon: Ship,
    accent: '#00BCD4',
  },
  {
    id: 'intelligence',
    registryId: 'intelligence',
    label: 'Intelligence Layer',
    shortLabel: 'INTEL',
    description: 'Correlation, findings, and analyst panels',
    persistence: 'backend',
    layerKeys: ['news_intel', 'global_incidents', 'sdk_naval'],
    enableLayerKeys: ['news_intel', 'global_incidents', 'sdk_naval'],
    icon: BrainCircuit,
    accent: '#D4AF37',
  },
  {
    id: 'heatmaps',
    label: 'Heatmaps',
    shortLabel: 'HEAT',
    description: 'Density overlays from hazards and network signals',
    persistence: 'local',
    layerKeys: ['fires', 'weather', 'global_incidents', 'internet_outages', 'malware'],
    enableLayerKeys: ['fires', 'weather', 'global_incidents'],
    icon: Flame,
    accent: '#FF9500',
  },
  {
    id: 'shodan',
    registryId: 'shodan',
    label: 'Shodan Exposure',
    shortLabel: 'SHODAN',
    description: 'Passive infrastructure exposure enrichment',
    persistence: 'backend',
    optional: true,
    layerKeys: ['infrastructure', 'internet_outages'],
    enableLayerKeys: ['infrastructure'],
    icon: SearchCode,
    accent: '#76FF03',
  },
];

export const MODULE_DESCRIPTOR_BY_ID = MODULE_DESCRIPTORS.reduce<Record<UiModuleId, ModuleDescriptor>>((acc, descriptor) => {
  acc[descriptor.id] = descriptor;
  return acc;
}, {} as Record<UiModuleId, ModuleDescriptor>);

export type ModuleLayerState = Record<string, boolean>;

export function applyModuleLayerState(
  previous: ModuleLayerState,
  descriptor: ModuleDescriptor,
  enabled: boolean,
): ModuleLayerState {
  const next = { ...previous };
  const targetKeys = enabled ? descriptor.enableLayerKeys : descriptor.layerKeys;
  for (const key of targetKeys) next[key] = enabled;
  return next;
}

export function localModuleEnabled(descriptor: ModuleDescriptor, activeLayers: ModuleLayerState) {
  return descriptor.layerKeys.some((key) => activeLayers[key] === true);
}

export function statusFromRegistry(health?: string, enabled?: boolean): ModuleDisplayStatus {
  if (enabled === false) return 'disabled';
  if (health === 'OK') return 'online';
  if (health === 'DEGRADED' || health === 'UNKNOWN') return 'degraded';
  if (health === 'OFFLINE') return 'offline';
  return enabled ? 'degraded' : 'disabled';
}

export function readStoredLocalModules(): Partial<Record<UiModuleId, boolean>> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(MODULE_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(
      Object.entries(parsed).filter((entry): entry is [UiModuleId, boolean] => (
        MODULE_DESCRIPTORS.some((descriptor) => descriptor.id === entry[0])
        && typeof entry[1] === 'boolean'
      )),
    ) as Partial<Record<UiModuleId, boolean>>;
  } catch {
    return {};
  }
}

export function writeStoredLocalModule(id: UiModuleId, enabled: boolean) {
  if (typeof window === 'undefined') return;
  const current = readStoredLocalModules();
  window.localStorage.setItem(MODULE_STORAGE_KEY, JSON.stringify({
    ...current,
    [id]: enabled,
  }));
}
