'use client';

import { memo, useEffect, useMemo, useState, type Dispatch, type SetStateAction } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, RotateCcw, ShieldCheck, SlidersHorizontal, WifiOff } from 'lucide-react';
import { useModuleRegistry } from '@/lib/use-module-registry';
import {
  MODULE_DESCRIPTORS,
  applyModuleLayerState,
  localModuleEnabled,
  readStoredLocalModules,
  statusFromRegistry,
  writeStoredLocalModule,
  type ModuleDescriptor,
  type ModuleDisplayStatus,
  type ModuleLayerState,
  type UiModuleId,
} from '@/lib/module-ui';

type ModuleControlPanelProps = {
  activeLayers: ModuleLayerState;
  setActiveLayers: Dispatch<SetStateAction<ModuleLayerState>>;
  isMobile?: boolean;
  onOpenIntel?: () => void;
};

const STATUS_LABEL: Record<ModuleDisplayStatus, string> = {
  loading: 'LOADING',
  online: 'ONLINE',
  degraded: 'DEGRADED',
  offline: 'OFFLINE',
  disabled: 'OFF',
};

const STATUS_CLASS: Record<ModuleDisplayStatus, string> = {
  loading: 'text-[var(--text-muted)]',
  online: 'text-[var(--alert-green)]',
  degraded: 'text-[var(--alert-orange)]',
  offline: 'text-[var(--alert-red)]',
  disabled: 'text-[var(--text-muted)]',
};

const STATUS_ICON = {
  loading: Loader2,
  online: CheckCircle2,
  degraded: AlertTriangle,
  offline: WifiOff,
  disabled: ShieldCheck,
} satisfies Record<ModuleDisplayStatus, typeof Loader2>;

function moduleEnabledFromState(
  descriptor: ModuleDescriptor,
  activeLayers: ModuleLayerState,
  registryModule?: { enabled: boolean },
) {
  if (descriptor.persistence === 'local') return localModuleEnabled(descriptor, activeLayers);
  return registryModule?.enabled === true;
}

function moduleStatus(
  descriptor: ModuleDescriptor,
  registryLoading: boolean,
  registryModule?: { enabled: boolean; health?: { status?: string } },
): ModuleDisplayStatus {
  if (descriptor.persistence === 'local') return localModuleEnabled(descriptor, {}) ? 'online' : 'disabled';
  if (registryLoading && !registryModule) return 'loading';
  return statusFromRegistry(registryModule?.health?.status, registryModule?.enabled);
}

function ModuleSwitch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: () => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={onChange}
      className={`relative h-6 w-11 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        checked
          ? 'border-[var(--gold-primary)] bg-[var(--gold-primary)]/25'
          : 'border-white/10 bg-white/5'
      }`}
    >
      <span
        className={`absolute top-[3px] h-4 w-4 rounded-full transition-transform ${
          checked
            ? 'translate-x-[22px] bg-[var(--gold-primary)] shadow-[0_0_10px_rgba(212,175,55,0.45)]'
            : 'translate-x-[4px] bg-white/40'
        }`}
      />
    </button>
  );
}

function ModuleRow({
  descriptor,
  enabled,
  status,
  saving,
  locked,
  source,
  reason,
  onToggle,
  onReset,
}: {
  descriptor: ModuleDescriptor;
  enabled: boolean;
  status: ModuleDisplayStatus;
  saving?: boolean;
  locked?: boolean;
  source?: string;
  reason?: string | null;
  onToggle: () => void;
  onReset: () => void;
}) {
  const Icon = descriptor.icon;
  const StatusIcon = saving ? Loader2 : STATUS_ICON[status];

  return (
    <div className="rounded-md border border-white/10 bg-black/25 px-3 py-2">
      <div className="flex items-center gap-3">
        <div
          className="flex h-8 w-8 shrink-0 items-center justify-center rounded border"
          style={{
            borderColor: `${descriptor.accent}55`,
            backgroundColor: `${descriptor.accent}14`,
            color: descriptor.accent,
          }}
        >
          <Icon className="h-4 w-4" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-[11px] font-bold uppercase tracking-[0.12em] text-[var(--text-primary)]">
              {descriptor.label}
            </span>
            {descriptor.optional && (
              <span className="rounded border border-white/10 px-1 py-0.5 text-[7px] font-mono text-white/45">
                OPT
              </span>
            )}
          </div>
          <div className="mt-0.5 truncate text-[9px] font-mono text-[var(--text-muted)]">
            {descriptor.description}
          </div>
        </div>
        <ModuleSwitch
          checked={enabled}
          disabled={saving || locked}
          label={`${enabled ? 'Disable' : 'Enable'} ${descriptor.label}`}
          onChange={onToggle}
        />
      </div>

      <div className="mt-2 flex items-center justify-between gap-3 text-[8px] font-mono tracking-[0.12em]">
        <div className={`flex items-center gap-1.5 ${STATUS_CLASS[status]}`}>
          <StatusIcon className={`h-3 w-3 ${saving || status === 'loading' ? 'animate-spin' : ''}`} />
          <span>{saving ? 'UPDATING' : STATUS_LABEL[status]}</span>
        </div>
        <div className="flex min-w-0 items-center gap-2 text-white/35">
          {source && <span className="truncate">{source.toUpperCase()}</span>}
          {reason && <span className="hidden max-w-[120px] truncate lg:inline">{reason}</span>}
          {descriptor.persistence === 'backend' && source === 'runtime' && (
            <button
              type="button"
              onClick={onReset}
              disabled={saving}
              className="inline-flex h-6 w-6 items-center justify-center rounded border border-white/10 text-white/45 transition-colors hover:border-[var(--gold-primary)]/40 hover:text-[var(--gold-primary)] disabled:opacity-40"
              title="Reset runtime override"
            >
              <RotateCcw className="h-3 w-3" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function ModuleControlPanel({
  activeLayers,
  setActiveLayers,
  isMobile,
  onOpenIntel,
}: ModuleControlPanelProps) {
  const registry = useModuleRegistry();
  const [localReady, setLocalReady] = useState(false);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const stored = readStoredLocalModules();
      const entries = Object.entries(stored) as [UiModuleId, boolean][];
      if (entries.length > 0) {
        setActiveLayers((previous: ModuleLayerState) => {
          let next = previous;
          for (const [id, enabled] of entries) {
            const descriptor = MODULE_DESCRIPTORS.find((item) => item.id === id);
            if (!descriptor || descriptor.persistence !== 'local') continue;
            next = applyModuleLayerState(next, descriptor, enabled);
          }
          return next;
        });
      }
      setLocalReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [setActiveLayers]);

  const modules = useMemo(() => MODULE_DESCRIPTORS.map((descriptor) => {
    const registryModule = descriptor.registryId ? registry.modules[descriptor.registryId] : undefined;
    const enabled = moduleEnabledFromState(descriptor, activeLayers, registryModule);
    const status = descriptor.persistence === 'local'
      ? (enabled ? 'online' : 'disabled')
      : moduleStatus(descriptor, registry.loading, registryModule);
    return {
      descriptor,
      enabled,
      registryModule,
      status,
    };
  }), [activeLayers, registry.loading, registry.modules]);

  async function toggleModule(descriptor: ModuleDescriptor, enabled: boolean) {
    if (descriptor.persistence === 'local') {
      writeStoredLocalModule(descriptor.id, enabled);
      setActiveLayers((previous: ModuleLayerState) => applyModuleLayerState(previous, descriptor, enabled));
      return;
    }

    await registry.setModuleEnabled(descriptor.id, enabled);
    setActiveLayers((previous: ModuleLayerState) => applyModuleLayerState(previous, descriptor, enabled));
    if (descriptor.id === 'intelligence' && enabled) onOpenIntel?.();
  }

  async function resetModule(descriptor: ModuleDescriptor) {
    if (descriptor.persistence !== 'backend') return;
    const moduleState = await registry.clearModuleOverride(descriptor.id);
    if (moduleState) {
      setActiveLayers((previous: ModuleLayerState) => applyModuleLayerState(previous, descriptor, moduleState.enabled));
    }
  }

  return (
    <section
      className={`glass-panel osiris-glow-cyan pointer-events-auto ${isMobile ? 'p-3' : 'w-[360px] p-4'}`}
      aria-label="OSIRIS module controls"
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded border border-[var(--cyan-primary)]/25 bg-[var(--cyan-primary)]/10 text-[var(--cyan-primary)]">
            <SlidersHorizontal className="h-4 w-4" />
          </div>
          <div>
            <div className="text-[11px] font-bold uppercase tracking-[0.18em] text-[var(--text-primary)]">
              Module Control
            </div>
            <div className="text-[8px] font-mono uppercase tracking-[0.16em] text-[var(--text-muted)]">
              {registry.refreshing ? 'Syncing registry' : 'Runtime feature gates'}
            </div>
          </div>
        </div>
        <button
          type="button"
          onClick={() => registry.refresh(false)}
          className="inline-flex h-8 w-8 items-center justify-center rounded border border-white/10 text-white/50 transition-colors hover:border-[var(--cyan-primary)]/40 hover:text-[var(--cyan-primary)]"
          title="Refresh module registry"
        >
          <RotateCcw className={`h-3.5 w-3.5 ${registry.refreshing ? 'animate-spin' : ''}`} />
        </button>
      </div>

      <div className="mb-3 grid grid-cols-[1fr_auto] gap-2">
        <input
          type="password"
          value={registry.adminToken}
          onChange={(event) => registry.setAdminToken(event.target.value)}
          placeholder="Admin token"
          className="min-w-0 rounded border border-white/10 bg-black/30 px-2 py-2 text-[10px] font-mono text-white/80 outline-none transition-colors placeholder:text-white/25 focus:border-[var(--cyan-primary)]/40"
          autoComplete="off"
        />
        <button
          type="button"
          onClick={() => registry.setAdminToken('')}
          className="rounded border border-white/10 px-2 text-[9px] font-mono uppercase tracking-[0.12em] text-white/45 transition-colors hover:border-[var(--gold-primary)]/40 hover:text-[var(--gold-primary)]"
        >
          Clear
        </button>
      </div>

      {registry.error && (
        <div className="mb-3 rounded border border-[var(--alert-red)]/25 bg-[var(--alert-red)]/10 px-3 py-2 text-[9px] font-mono leading-relaxed text-[var(--alert-red)]">
          {registry.error}
        </div>
      )}

      <div className="space-y-2">
        {modules.map(({ descriptor, enabled, registryModule, status }) => (
          <ModuleRow
            key={descriptor.id}
            descriptor={descriptor}
            enabled={enabled}
            status={!localReady && descriptor.persistence === 'local' ? 'loading' : status}
            saving={registry.saving[descriptor.id]}
            locked={registryModule?.locked}
            source={descriptor.persistence === 'local' ? 'local' : registryModule?.source}
            reason={registryModule?.health?.reason}
            onToggle={() => {
              toggleModule(descriptor, !enabled).catch(() => {
                setActiveLayers((previous: ModuleLayerState) => ({ ...previous }));
              });
            }}
            onReset={() => {
              resetModule(descriptor).catch(() => undefined);
            }}
          />
        ))}
      </div>
    </section>
  );
}

export default memo(ModuleControlPanel);
