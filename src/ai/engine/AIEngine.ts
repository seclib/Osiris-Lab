/**
 * OSIRIS AI Engine — Core Engine
 * 
 * Point d'entrée unique pour toute interaction IA.
 * Aucun code métier ne touche directement un LLM.
 * 
 * Responsibilities:
 * 1. Provider resolution & failover
 * 2. Request routing (LLM / Embedding / Agent)
 * 3. Observability (metrics, tracing, events)
 * 4. Rate limiting & throttling
 * 5. Token tracking & cost calculation
 */

import type {
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  AgentConfig,
  AgentContext,
  AgentResult,
  ModelConfig,
  AIEngineEvent,
  MemoryEntry,
} from './types';

import type { LLMProviderAdapter, EmbeddingProviderAdapter } from '../adapters/interfaces';
import { ProviderError } from '../adapters/interfaces';

/**
 * Engine configuration
 */
export interface AIEngineConfig {
  defaultModel: ModelConfig;
  fallbackModels?: ModelConfig[];
  maxRetries?: number;
  timeoutMs?: number;
  enableMetrics?: boolean;
}

/**
 * Provider entry in the registry
 */
interface ProviderEntry {
  config: ModelConfig;
  llm: LLMProviderAdapter;
  embedding?: EmbeddingProviderAdapter;
  healthy: boolean;
  lastChecked: number;
}

/**
 * AI Engine — singleton gérant tous les providers LLM
 */
export class AIEngine {
  private providers: Map<string, ProviderEntry> = new Map();
  private config: AIEngineConfig;
  private events: AIEngineEvent[] = [];
  private maxEvents: number = 1000;

  constructor(config: AIEngineConfig) {
    this.config = {
      maxRetries: 3,
      timeoutMs: 30000,
      enableMetrics: true,
      ...config,
    };
  }

  /**
   * Register a provider
   */
  registerProvider(
    config: ModelConfig,
    llmAdapter: LLMProviderAdapter,
    embeddingAdapter?: EmbeddingProviderAdapter
  ): void {
    const key = this.getProviderKey(config);
    this.providers.set(key, {
      config,
      llm: llmAdapter,
      embedding: embeddingAdapter,
      healthy: true,
      lastChecked: Date.now(),
    });
  }

  /**
   * Remove a provider
   */
  unregisterProvider(config: ModelConfig): void {
    const key = this.getProviderKey(config);
    this.providers.delete(key);
  }

  /**
   * Get all registered providers
   */
  getProviders(): ModelConfig[] {
    return Array.from(this.providers.values()).map((p) => p.config);
  }

  /**
   * Generate a completion
   */
  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const startTime = Date.now();
    const key = this.getProviderKey(request.model);
    const entry = this.providers.get(key);

    if (!entry) {
      return this.tryFallback(request, startTime);
    }

    try {
      this.checkHealth(entry);
      const response = await entry.llm.complete(request);
      this.emitEvent({
        type: 'completion',
        timestamp: Date.now(),
        durationMs: Date.now() - startTime,
        model: request.model.modelId,
        provider: request.model.provider,
        tokens: response.usage.totalTokens,
      });
      return response;
    } catch (error) {
      return this.handleError(error, request, startTime, entry);
    }
  }

  /**
   * Generate embeddings
   */
  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const startTime = Date.now();
    const key = this.getProviderKey(request.model);
    const entry = this.providers.get(key);

    if (!entry?.embedding) {
      throw new ProviderError(
        'No embedding provider available for this model',
        request.model.provider,
        'MODEL_NOT_FOUND'
      );
    }

    try {
      const response = await entry.embedding.embed(request);
      this.emitEvent({
        type: 'embedding',
        timestamp: Date.now(),
        durationMs: Date.now() - startTime,
        model: request.model.modelId,
        provider: request.model.provider,
        tokens: response.usage.totalTokens,
      });
      return response;
    } catch (error) {
      this.emitEvent({
        type: 'error',
        timestamp: Date.now(),
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Unknown error',
        provider: request.model.provider,
      });
      throw error;
    }
  }

  /**
   * Execute a health check on all registered providers
   */
  async healthCheckAll(): Promise<Record<string, boolean>> {
    const results: Record<string, boolean> = {};

    for (const [key, entry] of this.providers) {
      try {
        results[key] = await entry.llm.healthCheck();
        entry.healthy = results[key];
      } catch {
        results[key] = false;
        entry.healthy = false;
      }
      entry.lastChecked = Date.now();
    }

    return results;
  }

  /**
   * Get engine metrics
   */
  getMetrics(): { events: AIEngineEvent[]; providers: number; healthy: number } {
    const healthy = Array.from(this.providers.values()).filter((p) => p.healthy).length;
    return {
      events: this.events,
      providers: this.providers.size,
      healthy,
    };
  }

  /**
   * Get recent events
   */
  getEvents(limit: number = 100): AIEngineEvent[] {
    return this.events.slice(-limit);
  }

  /**
   * Stream completion (delegates to provider)
   */
  async *completeStream(request: CompletionRequest): AsyncGenerator<CompletionResponse> {
    const key = this.getProviderKey(request.model);
    const entry = this.providers.get(key);

    if (!entry) {
      throw new ProviderError(
        'No provider available for streaming',
        request.model.provider,
        'MODEL_NOT_FOUND'
      );
    }

    this.checkHealth(entry);
    yield* entry.llm.completeStream(request);
  }

  /**
   * Health check summary
   */
  async health(): Promise<{ healthy: boolean; providers: string[]; defaultModel?: ModelConfig }> {
    const providerKeys = Array.from(this.providers.keys());
    const healthyCount = Array.from(this.providers.values()).filter((p) => p.healthy).length;
    
    return {
      healthy: healthyCount > 0 || providerKeys.length === 0,
      providers: providerKeys,
      defaultModel: this.config.defaultModel,
    };
  }

  /**
   * Engine statistics
   */
  getStats(): {
    totalRequests: number;
    totalTokens: number;
    avgLatencyMs: number;
    errorRate: number;
  } {
    const total = this.events.length;
    const errors = this.events.filter((e) => e.type === 'error').length;
    const totalTokens = this.events.reduce((sum, e) => sum + (e.tokens || 0), 0);
    const avgLatency = total > 0
      ? this.events.reduce((sum, e) => sum + e.durationMs, 0) / total
      : 0;

    return {
      totalRequests: total,
      totalTokens,
      avgLatencyMs: Math.round(avgLatency),
      errorRate: total > 0 ? errors / total : 0,
    };
  }

  /**
   * Try fallback providers
   */
  private async tryFallback(
    request: CompletionRequest,
    startTime: number
  ): Promise<CompletionResponse> {
    const fallbacks = this.config.fallbackModels || [];
    
    for (const fallback of fallbacks) {
      const key = this.getProviderKey(fallback);
      const entry = this.providers.get(key);
      
      if (entry?.healthy) {
        try {
          return await entry.llm.complete({ ...request, model: fallback });
        } catch {
          continue;
        }
      }
    }

    throw new ProviderError(
      'No provider available for this model and no healthy fallback found',
      request.model.provider,
      'MODEL_NOT_FOUND'
    );
  }

  /**
   * Handle provider errors with retry logic
   */
  private async handleError(
    error: unknown,
    request: CompletionRequest,
    startTime: number,
    entry: ProviderEntry
  ): Promise<CompletionResponse> {
    const providerError = error instanceof ProviderError ? error : new ProviderError(
      error instanceof Error ? error.message : 'Unknown error',
      entry.config.provider,
      'INTERNAL_ERROR'
    );

    this.emitEvent({
      type: 'error',
      timestamp: Date.now(),
      durationMs: Date.now() - startTime,
      error: providerError.message,
      provider: entry.config.provider,
      model: request.model.modelId,
    });

    // If error is retryable, try fallback
    if (providerError.retryable) {
      return this.tryFallback(request, startTime);
    }

    // Mark provider unhealthy on critical errors
    if (providerError.code === 'AUTHENTICATION_FAILED' || providerError.code === 'RATE_LIMITED') {
      entry.healthy = false;
    }

    throw providerError;
  }

  /**
   * Check if a provider is healthy
   */
  private checkHealth(entry: ProviderEntry): void {
    if (!entry.healthy && Date.now() - entry.lastChecked > 60000) {
      // Auto-recovery check after 1 minute
      entry.healthy = true;
    }
    if (!entry.healthy) {
      throw new ProviderError(
        'Provider is marked unhealthy',
        entry.config.provider,
        'INTERNAL_ERROR',
        true
      );
    }
  }

  /**
   * Generate a unique key for a provider config
   */
  private getProviderKey(config: ModelConfig): string {
    return `${config.provider}:${config.modelId}`;
  }

  /**
   * Emit an event for observability
   */
  private emitEvent(event: AIEngineEvent): void {
    if (!this.config.enableMetrics) return;
    
    this.events.push(event);
    if (this.events.length > this.maxEvents) {
      this.events.shift();
    }

    // TODO: Emit to observability pipeline (Grafana Alloy)
    if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
      // Silent in test/prod — use metrics endpoint
    }
  }
}

/**
 * Singleton instance
 */
let engineInstance: AIEngine | null = null;

/**
 * Get or create the AI Engine singleton
 */
export function getAIEngine(config?: AIEngineConfig): AIEngine {
  if (!engineInstance) {
    if (!config) {
      throw new Error('AIEngine must be initialized with a config');
    }
    engineInstance = new AIEngine(config);
  }
  return engineInstance;
}

/**
 * Reset the engine (for testing)
 */
export function resetAIEngine(): void {
  engineInstance = null;
}