'use client';

export type RegistryModule = {
  id: string;
  name: string;
  kind: string;
  description?: string;
  enabled: boolean;
  state: 'ENABLED' | 'DISABLED';
  source: 'runtime' | 'env' | 'json' | 'default';
  locked: boolean;
  health?: {
    status?: string;
    reason?: string | null;
  };
  runtimeOverride?: {
    enabled: boolean;
    updatedAt: string;
    updatedBy?: string;
    reason?: string;
  } | null;
};

export type RegistryResponse = {
  modules: RegistryModule[];
  timestamp: string;
};

function authHeaders(adminToken?: string): Record<string, string> {
  if (!adminToken) return {};
  return {
    authorization: `Bearer ${adminToken}`,
    'x-osiris-actor': 'dashboard',
  };
}

async function parseJson<T>(response: Response): Promise<T> {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = typeof body?.error === 'string'
      ? body.error
      : `Request failed with HTTP ${response.status}`;
    throw new Error(message);
  }
  return body as T;
}

export async function fetchModuleRegistry(signal?: AbortSignal): Promise<RegistryResponse> {
  const response = await fetch('/api/modules', {
    cache: 'no-store',
    signal,
  });
  return parseJson<RegistryResponse>(response);
}

export async function setBackendModuleState(
  id: string,
  enabled: boolean,
  adminToken?: string,
): Promise<RegistryModule> {
  const response = await fetch(`/api/modules/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    cache: 'no-store',
    headers: {
      'content-type': 'application/json',
      ...authHeaders(adminToken),
    },
    body: JSON.stringify({
      enabled,
      reason: 'dashboard module toggle',
      updatedBy: 'dashboard',
    }),
  });
  const body = await parseJson<{ module: RegistryModule }>(response);
  return body.module;
}

export async function clearBackendModuleState(id: string, adminToken?: string): Promise<RegistryModule> {
  const response = await fetch(`/api/modules/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    cache: 'no-store',
    headers: authHeaders(adminToken),
  });
  const body = await parseJson<{ module: RegistryModule }>(response);
  return body.module;
}
