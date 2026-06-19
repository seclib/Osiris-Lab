/**
 * OSIRIS Security Framework — OAuth2/OIDC Provider Integration
 * 
 * Supporte Auth0, Keycloak, et tout provider OIDC.
 * Délègue l'authentification à un provider externe.
 * 
 * Zero Trust: Externalize trust to proven identity providers.
 */

import type { SecurityContext } from './types';
import { JWTVerifier, type JWTVerificationResult } from './JWTVerifier';

/**
 * OAuth2/OIDC Provider configuration
 */
export interface OAuth2ProviderConfig {
  name: string;
  issuer: string;
  authorizationUrl: string;
  tokenUrl: string;
  jwksUri: string;
  clientId: string;
  clientSecret?: string;
  redirectUri?: string;
  scopes: string[];
  mfaRequired: boolean;
}

/**
 * OAuth2 token response
 */
export interface OAuth2TokenResponse {
  accessToken: string;
  tokenType: string;
  expiresIn: number;
  refreshToken?: string;
  scope?: string;
  idToken?: string;
}

/**
 * OAuth2 user info
 */
export interface OAuth2UserInfo {
  sub: string;
  email?: string;
  emailVerified?: boolean;
  name?: string;
  picture?: string;
  roles?: string[];
  permissions?: string[];
  mfaVerified?: boolean;
}

/**
 * OAuth2/OIDC Provider
 */
export class OAuth2Provider {
  private config: OAuth2ProviderConfig;
  private jwtVerifier: JWTVerifier;

  constructor(config: OAuth2ProviderConfig) {
    this.config = config;
    this.jwtVerifier = new JWTVerifier({
      issuer: config.issuer,
      audience: config.clientId,
      jwksUri: config.jwksUri,
      algorithms: ['RS256', 'RS384', 'RS512'],
    });
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCode(code: string): Promise<OAuth2TokenResponse> {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri || '',
    });

    if (this.config.clientSecret) {
      params.append('client_secret', this.config.clientSecret);
    }

    const response = await fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`Token exchange failed: ${response.status}`);
    }

    const data = await response.json();
    return {
      accessToken: data.access_token,
      tokenType: data.token_type || 'Bearer',
      expiresIn: data.expires_in || 3600,
      refreshToken: data.refresh_token,
      scope: data.scope,
      idToken: data.id_token,
    };
  }

  /**
   * Refresh access token
   */
  async refreshToken(refreshToken: string): Promise<OAuth2TokenResponse> {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: this.config.clientId,
    });

    if (this.config.clientSecret) {
      params.append('client_secret', this.config.clientSecret);
    }

    const response = await fetch(this.config.tokenUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: params.toString(),
    });

    if (!response.ok) {
      throw new Error(`Token refresh failed: ${response.status}`);
    }

    const data = await response.json();
    return {
      accessToken: data.access_token,
      tokenType: data.token_type || 'Bearer',
      expiresIn: data.expires_in || 3600,
      refreshToken: data.refresh_token || refreshToken,
      scope: data.scope,
      idToken: data.id_token,
    };
  }

  /**
   * Get user info from provider
   */
  async getUserInfo(accessToken: string): Promise<OAuth2UserInfo> {
    const response = await fetch(`${this.config.issuer}/userinfo`, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to get user info: ${response.status}`);
    }

    return response.json();
  }

  /**
   * Verify ID token (JWT)
   */
  async verifyIdToken(idToken: string): Promise<JWTVerificationResult> {
    return this.jwtVerifier.verify(idToken);
  }

  /**
   * Authenticate with ID token
   */
  async authenticateWithIdToken(idToken: string): Promise<SecurityContext> {
    const result = await this.jwtVerifier.verify(idToken);

    if (!result.valid || !result.payload) {
      return {
        authenticated: false,
        mfaVerified: false,
      };
    }

    // Check MFA requirement
    if (this.config.mfaRequired && !result.payload.mfa) {
      return {
        authenticated: false,
        mfaVerified: false,
      };
    }

    return {
      authenticated: true,
      userId: result.payload.sub,
      role: result.payload.role,
      permissions: result.payload.permissions || [],
      sessionId: result.payload.sessionId,
      mfaVerified: result.payload.mfa === true,
    };
  }

  /**
   * Build authorization URL
   */
  buildAuthorizationUrl(state: string, additionalScopes: string[] = []): string {
    const scopes = [...this.config.scopes, ...additionalScopes].join(' ');
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: this.config.clientId,
      redirect_uri: this.config.redirectUri || '',
      scope: scopes,
      state,
    });

    return `${this.config.authorizationUrl}?${params.toString()}`;
  }

  /**
   * Get provider configuration
   */
  getConfig(): OAuth2ProviderConfig {
    return { ...this.config };
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<OAuth2ProviderConfig>): void {
    this.config = { ...this.config, ...config };
    this.jwtVerifier.updateConfig({
      issuer: this.config.issuer,
      audience: this.config.clientId,
      jwksUri: this.config.jwksUri,
    });
  }
}

/**
 * OAuth2 Provider Registry
 */
export class OAuth2ProviderRegistry {
  private providers: Map<string, OAuth2Provider> = new Map();

  /**
   * Register a provider
   */
  register(config: OAuth2ProviderConfig): void {
    const provider = new OAuth2Provider(config);
    this.providers.set(config.name, provider);
  }

  /**
   * Get a provider by name
   */
  get(name: string): OAuth2Provider | undefined {
    return this.providers.get(name);
  }

  /**
   * List all providers
   */
  list(): OAuth2ProviderConfig[] {
    return Array.from(this.providers.values()).map((p) => p.getConfig());
  }

  /**
   * Remove a provider
   */
  remove(name: string): void {
    this.providers.delete(name);
  }

  /**
   * Clear all providers
   */
  clear(): void {
    this.providers.clear();
  }
}