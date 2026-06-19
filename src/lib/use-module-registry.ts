'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  clearBackendModuleState,
  fetchModuleRegistry,
  setBackendModuleState,
  type RegistryModule,
} from '@/lib/module-api-client';
import {
  MODULE_ADMIN_TOKEN_STORAGE_KEY,
  MODULE_DESCRIPTORS,
  type UiModuleId,
} from '@/lib/module-ui';

type SavingState = Partial<Record<UiModuleId, boolean>>;

export function useModuleRegistry() {
  const [modules, setModules] = useState<Record<string, RegistryModule>>({});
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<SavingState>({});
  const [adminToken, setAdminTokenState] = useState(() => (
    typeof window === 'undefined'
      ? ''
      : window.sessionStorage.getItem(MODULE_ADMIN_TOKEN_STORAGE_KEY) || ''
  ));
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setAdminToken = useCallback((token: string) => {
    setAdminTokenState(token);
    if (typeof window === 'undefined') return;
    if (token) {
      window.sessionStorage.setItem(MODULE_ADMIN_TOKEN_STORAGE_KEY, token);
    } else {
      window.sessionStorage.removeItem(MODULE_ADMIN_TOKEN_STORAGE_KEY);
    }
  }, []);

  const refresh = useCallback(async (silent = false) => {
    const controller = new AbortController();
    if (!silent) setLoading(true);
    if (silent) setRefreshing(true);
    setError(null);

    try {
      const response = await fetchModuleRegistry(controller.signal);
      if (!mountedRef.current) return;
      setModules(Object.fromEntries(response.modules.map((module) => [module.id, module])));
    } catch (fetchError) {
      if (!mountedRef.current) return;
      setError(fetchError instanceof Error ? fetchError.message : 'Module registry unavailable.');
    } finally {
      if (!mountedRef.current) return;
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    const initialRefresh = window.setTimeout(() => {
      refresh(false);
    }, 0);
    const interval = window.setInterval(() => refresh(true), 30000);
    return () => {
      window.clearTimeout(initialRefresh);
      window.clearInterval(interval);
    };
  }, [refresh]);

  const setModuleEnabled = useCallback(async (id: UiModuleId, enabled: boolean) => {
    const descriptor = MODULE_DESCRIPTORS.find((item) => item.id === id);
    if (!descriptor?.registryId) return null;

    setSaving((current) => ({ ...current, [id]: true }));
    setError(null);

    try {
      const updatedModule = await setBackendModuleState(descriptor.registryId, enabled, adminToken);
      setModules((current) => ({ ...current, [updatedModule.id]: updatedModule }));
      return updatedModule;
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Module update failed.');
      throw updateError;
    } finally {
      setSaving((current) => ({ ...current, [id]: false }));
    }
  }, [adminToken]);

  const clearModuleOverride = useCallback(async (id: UiModuleId) => {
    const descriptor = MODULE_DESCRIPTORS.find((item) => item.id === id);
    if (!descriptor?.registryId) return null;

    setSaving((current) => ({ ...current, [id]: true }));
    setError(null);

    try {
      const resetModuleState = await clearBackendModuleState(descriptor.registryId, adminToken);
      setModules((current) => ({ ...current, [resetModuleState.id]: resetModuleState }));
      return resetModuleState;
    } catch (updateError) {
      setError(updateError instanceof Error ? updateError.message : 'Module reset failed.');
      throw updateError;
    } finally {
      setSaving((current) => ({ ...current, [id]: false }));
    }
  }, [adminToken]);

  const registryModules = useMemo(() => modules, [modules]);

  return {
    adminToken,
    clearModuleOverride,
    error,
    loading,
    modules: registryModules,
    refresh,
    refreshing,
    saving,
    setAdminToken,
    setModuleEnabled,
  };
}
