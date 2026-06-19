/**
 * OSIRIS Security Framework — HashiCorp Vault Integration
 * 
 * Gestion des secrets via Vault.
 * Supporte KV v2, dynamic secrets, et AppRole authentication.
 * 
 * Zero Trust: Secrets are never hardcoded, always fetched from Vault.
 */

/**
 * Circuit breaker state
 */
type CircuitState = 'closed' | 'open' | 'half-open';

/**
 * Vault authentication method
 */
export type VaultAuthMethod = 'token' | 'approle' | 'kubernetes' | 'ldap';

/**
 * Vault configuration
 */
export interface VaultConfig {
  address: string;
  authMethod: VaultAuthMethod;
  token?: string;
  roleId?: string;
  secretId?: string;
  kubernetesServiceAccountToken?: string;
  kubernetesRole?: string;
  mountPath: string;
  timeout: number;
  retryAttempts: number;
  retryDelay: number;
  circuitBreakerThreshold: number;
  circuitBreakerTimeout: number;
}

/**
 * Vault secret
 */
export interface VaultSecret {
  path: string;
  data: Record<string, unknown>;
  metadata: {
    version: number;
    created_time: string;
    deletion_time?: string;
    destroyed: boolean;
  };
}

/**
 * Vault dynamic secret
 */
export interface VaultDynamicSecret {
  leaseId: string;
  leaseDuration: number;
  renewable: boolean;
  data: Record<string, unknown>;
}

/**
 * Default config
 */
const DEFAULT_CONFIG: VaultConfig = {
  address: process.env.VAULT_ADDR || 'http://localhost:8200',
  authMethod: 'token',
  mountPath: 'secret',
  timeout: 5000,
  retryAttempts: 3,
  retryDelay: 1000,
  circuitBreakerThreshold: 5,
  circuitBreakerTimeout: 30000,
};

/**
 * Circuit Breaker for Vault
 */
class CircuitBreaker {
  private state: CircuitState = 'closed';
  private failureCount: number = 0;
  private lastFailureTime: number = 0;
  private threshold: number;
  private timeout: number;

  constructor(threshold: number, timeout: number) {
    this.threshold = threshold;
    this.timeout = timeout;
  }

  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > this.timeout) {
        this.state = 'half-open';
      } else {
        throw new Error('Circuit breaker is open - Vault is temporarily unavailable');
      }
    }

    try {
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure();
      throw error;
    }
  }

  private onSuccess(): void {
    this.failureCount = 0;
    this.state = 'closed';
  }

  private onFailure(): void {
    this.failureCount++;
    this.lastFailureTime = Date.now();

    if (this.failureCount >= this.threshold) {
      this.state = 'open';
    }
  }

  getState(): CircuitState {
    return this.state;
  }

  getFailureCount(): number {
    return this.failureCount;
  }

  reset(): void {
    this.state = 'closed';
    this.failureCount = 0;
    this.lastFailureTime = 0;
  }
}

/**
 * Vault Client
 * 
 * Client pour HashiCorp Vault.
 * Gère l'authentification et la récupération des secrets.
 */
export class VaultClient {
  private config: VaultConfig;
  private token: string | null = null;
  private tokenExpiry: number = 0;
  private tokenRefreshTimer: NodeJS.Timeout | null = null;
  private circuitBreaker: CircuitBreaker;

  constructor(config?: Partial<VaultConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.circuitBreaker = new CircuitBreaker(
      this.config.circuitBreakerThreshold,
      this.config.circuitBreakerTimeout
    );
  }

  /**
   * Authenticate with Vault
   */
  async authenticate(): Promise<void> {
    switch (this.config.authMethod) {
      case 'token':
        await this.authenticateWithToken();
        break;
      case 'approle':
        await this.authenticateWithAppRole();
        break;
      case 'kubernetes':
        await this.authenticateWithKubernetes();
        break;
      case 'ldap':
        await this.authenticateWithLDAP();
        break;
    }

    // Schedule token refresh at 80% of token lifetime
    this.scheduleTokenRefresh();
  }

  /**
   * Schedule automatic token refresh
   */
  private scheduleTokenRefresh(): void {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
    }

    if (!this.token || !this.tokenExpiry) return;

    const now = Date.now();
    const tokenLifetime = this.tokenExpiry - now;
    const refreshAt = tokenLifetime * 0.8; // Refresh at 80% of lifetime

    this.tokenRefreshTimer = setTimeout(() => {
      this.authenticate().catch((error) => {
        console.error('Failed to refresh Vault token:', error);
      });
    }, refreshAt);
  }

  /**
   * Authenticate with token
   */
  private async authenticateWithToken(): Promise<void> {
    if (!this.config.token) {
      throw new Error('Token is required for token authentication');
    }

    this.token = this.config.token;
    await this.validateToken();
  }

  /**
   * Authenticate with AppRole
   */
  private async authenticateWithAppRole(): Promise<void> {
    if (!this.config.roleId || !this.config.secretId) {
      throw new Error('RoleId and SecretId are required for AppRole authentication');
    }

    const response = await this.request('/v1/auth/approle/login', {
      method: 'POST',
      body: JSON.stringify({
        role_id: this.config.roleId,
        secret_id: this.config.secretId,
      }),
    });

    const data = await response.json();
    this.token = data.auth.client_token;
    this.tokenExpiry = Date.now() + data.auth.lease_duration * 1000;
  }

  /**
   * Authenticate with Kubernetes service account
   */
  private async authenticateWithKubernetes(): Promise<void> {
    if (!this.config.kubernetesServiceAccountToken || !this.config.kubernetesRole) {
      throw new Error('Service account token and role are required for Kubernetes authentication');
    }

    const response = await this.request('/v1/auth/kubernetes/login', {
      method: 'POST',
      body: JSON.stringify({
        role: this.config.kubernetesRole,
        jwt: this.config.kubernetesServiceAccountToken,
      }),
    });

    const data = await response.json();
    this.token = data.auth.client_token;
    this.tokenExpiry = Date.now() + data.auth.lease_duration * 1000;
  }

  /**
   * Authenticate with LDAP
   */
  private async authenticateWithLDAP(): Promise<void> {
    // LDAP auth requires username/password
    // This is a placeholder - implement based on your LDAP setup
    throw new Error('LDAP authentication not implemented');
  }

  /**
   * Validate token
   */
  private async validateToken(): Promise<void> {
    try {
      const response = await this.request('/v1/auth/token/lookup-self');
      const data = await response.json();
      this.tokenExpiry = Date.now() + data.data.expire_time * 1000;
    } catch (error) {
      throw new Error(`Token validation failed: ${error}`);
    }
  }

  /**
   * Get secret from Vault (with circuit breaker)
   */
  async getSecret(path: string): Promise<VaultSecret> {
    return this.circuitBreaker.execute(async () => {
      this.ensureAuthenticated();

      const response = await this.request(`/v1/${this.config.mountPath}/data/${path}`);
      const data = await response.json();

      return {
        path,
        data: data.data.data,
        metadata: data.data.metadata,
      };
    });
  }

  /**
   * Get multiple secrets
   */
  async getSecrets(paths: string[]): Promise<Map<string, VaultSecret>> {
    const secrets = new Map<string, VaultSecret>();

    await Promise.all(
      paths.map(async (path) => {
        const secret = await this.getSecret(path);
        secrets.set(path, secret);
      })
    );

    return secrets;
  }

  /**
   * Write secret to Vault (with circuit breaker)
   */
  async writeSecret(path: string, data: Record<string, unknown>): Promise<void> {
    return this.circuitBreaker.execute(async () => {
      this.ensureAuthenticated();

      await this.request(`/v1/${this.config.mountPath}/data/${path}`, {
        method: 'POST',
        body: JSON.stringify({ data }),
      });
    });
  }

  /**
   * Delete secret from Vault (with circuit breaker)
   */
  async deleteSecret(path: string): Promise<void> {
    return this.circuitBreaker.execute(async () => {
      this.ensureAuthenticated();

      await this.request(`/v1/${this.config.mountPath}/data/${path}`, {
        method: 'DELETE',
      });
    });
  }

  /**
   * Get dynamic secret (database credentials, etc.)
   */
  async getDynamicSecret(path: string): Promise<VaultDynamicSecret> {
    return this.circuitBreaker.execute(async () => {
      this.ensureAuthenticated();

      const response = await this.request(`/v1/${path}`);
      const data = await response.json();

      return {
        leaseId: data.lease_id,
        leaseDuration: data.lease_duration,
        renewable: data.renewable,
        data: data.data,
      };
    });
  }

  /**
   * Renew lease
   */
  async renewLease(leaseId: string): Promise<{ leaseDuration: number }> {
    return this.circuitBreaker.execute(async () => {
      this.ensureAuthenticated();

      const response = await this.request('/v1/sys/leases/renew', {
        method: 'POST',
        body: JSON.stringify({ lease_id: leaseId }),
      });

      const data = await response.json();
      return {
        leaseDuration: data.lease_duration,
      };
    });
  }

  /**
   * Revoke lease
   */
  async revokeLease(leaseId: string): Promise<void> {
    return this.circuitBreaker.execute(async () => {
      this.ensureAuthenticated();

      await this.request('/v1/sys/leases/revoke', {
        method: 'POST',
        body: JSON.stringify({ lease_id: leaseId }),
      });
    });
  }

  /**
   * List secrets at path
   */
  async listSecrets(path: string): Promise<string[]> {
    return this.circuitBreaker.execute(async () => {
      this.ensureAuthenticated();

      const response = await this.request(`/v1/${this.config.mountPath}/metadata/${path}?list=true`);
      const data = await response.json();

      return data.data.keys || [];
    });
  }

  /**
   * Ensure authenticated (refresh token if needed)
   */
  private ensureAuthenticated(): void {
    if (!this.token || Date.now() > this.tokenExpiry) {
      throw new Error('Not authenticated. Call authenticate() first.');
    }
  }

  /**
   * Make request to Vault
   */
  private async request(path: string, options: RequestInit = {}): Promise<Response> {
    const url = `${this.config.address}${path}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(this.token ? { 'X-Vault-Token': this.token } : {}),
      ...(options.headers as Record<string, string>),
    };

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.config.timeout);

    try {
      const response = await fetch(url, {
        ...options,
        headers,
        signal: controller.signal,
      });

      if (!response.ok) {
        const error = await response.text();
        throw new Error(`Vault request failed: ${response.status} - ${error}`);
      }

      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Get configuration
   */
  getConfig(): VaultConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<VaultConfig>): void {
    this.config = { ...this.config, ...config };
    this.token = null;
    this.tokenExpiry = 0;
    
    // Update circuit breaker
    this.circuitBreaker = new CircuitBreaker(
      this.config.circuitBreakerThreshold,
      this.config.circuitBreakerTimeout
    );
  }

  /**
   * Revoke token
   */
  async revokeToken(): Promise<void> {
    if (this.tokenRefreshTimer) {
      clearTimeout(this.tokenRefreshTimer);
      this.tokenRefreshTimer = null;
    }

    if (this.token) {
      try {
        await this.request('/v1/auth/token/revoke-self', {
          method: 'POST',
        });
      } catch (error) {
        console.error('Failed to revoke token:', error);
      } finally {
        this.token = null;
        this.tokenExpiry = 0;
      }
    }
  }

  /**
   * Get circuit breaker state (for monitoring)
   */
  getCircuitBreakerState(): CircuitState {
    return this.circuitBreaker.getState();
  }

  /**
   * Get circuit breaker failure count
   */
  getCircuitBreakerFailureCount(): number {
    return this.circuitBreaker.getFailureCount();
  }

  /**
   * Reset circuit breaker
   */
  resetCircuitBreaker(): void {
    this.circuitBreaker.reset();
  }
}

/**
 * Vault Secret Manager
 * 
 * High-level API for managing secrets.
 * Caches secrets to reduce Vault calls.
 */
export class VaultSecretManager {
  private vault: VaultClient;
  private cache: Map<string, { secret: VaultSecret; cachedAt: number }> = new Map();
  private cacheTTL: number;

  constructor(vault: VaultClient, cacheTTL: number = 60000) {
    this.vault = vault;
    this.cacheTTL = cacheTTL;
  }

  /**
   * Get secret (with caching)
   */
  async getSecret(path: string, useCache: boolean = true): Promise<Record<string, unknown>> {
    // Check cache
    if (useCache) {
      const cached = this.cache.get(path);
      if (cached && Date.now() - cached.cachedAt < this.cacheTTL) {
        return cached.secret.data;
      }
    }

    // Fetch from Vault
    const secret = await this.vault.getSecret(path);
    
    // Update cache
    this.cache.set(path, {
      secret,
      cachedAt: Date.now(),
    });

    return secret.data;
  }

  /**
   * Get database credentials (dynamic secret)
   */
  async getDatabaseCredentials(role: string): Promise<{
    username: string;
    password: string;
    leaseId: string;
  }> {
    const secret = await this.vault.getDynamicSecret(`database/creds/${role}`);
    
    return {
      username: secret.data.username as string,
      password: secret.data.password as string,
      leaseId: secret.leaseId,
    };
  }

  /**
   * Clear cache
   */
  clearCache(): void {
    this.cache.clear();
  }

  /**
   * Remove from cache
   */
  invalidateCache(path: string): void {
    this.cache.delete(path);
  }
}