/**
 * OSIRIS AI Engine — Provider Adapter Interfaces
 * 
 * Interface abstraite pour tous les providers LLM.
 * Permet de changer de provider sans impacter le reste du système.
 */

import type {
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  ModelConfig,
  TokenUsage,
} from '../engine/types';

/**
 * LLM Provider adapter interface
 * 
 * Chaque provider (Gemini, OpenAI, Anthropic, Ollama) implémente cette interface.
 * Le reste du système ne connaît que cette abstraction.
 */
export interface LLMProviderAdapter {
  /** Provider identifier */
  readonly provider: string;

  /** Initialize the provider with its config */
  initialize(config: ModelConfig): Promise<void>;

  /** Check if provider is healthy */
  healthCheck(): Promise<boolean>;

  /** Generate a completion */
  complete(request: CompletionRequest): Promise<CompletionResponse>;

  /** Generate a streaming completion */
  completeStream(request: CompletionRequest): AsyncGenerator<CompletionResponse>;

  /** Generate embeddings */
  embed?(request: EmbeddingRequest): Promise<EmbeddingResponse>;

  /** Estimate token count for a string */
  estimateTokens(text: string): number;
}

/**
 * Embedding provider adapter interface
 */
export interface EmbeddingProviderAdapter {
  /** Provider identifier */
  readonly provider: string;

  /** Generate embeddings */
  embed(request: EmbeddingRequest): Promise<EmbeddingResponse>;

  /** Get embedding dimension size */
  getDimensions(): number;
}

/**
 * Provider factory interface
 * Chaque provider exporte un constructeur conforme
 */
export interface ProviderFactory {
  createLLMProvider(config: ModelConfig): LLMProviderAdapter;
  createEmbeddingProvider?(config: ModelConfig): EmbeddingProviderAdapter;
}

/**
 * Provider registry — stocke la configuration de tous les providers disponibles
 */
export interface ProviderRegistryEntry {
  factory: ProviderFactory;
  config: ModelConfig;
  llmAdapter?: LLMProviderAdapter;
  embeddingAdapter?: EmbeddingProviderAdapter;
}

/**
 * Error types for provider operations
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly provider: string,
    public readonly code: ProviderErrorCode,
    public readonly retryable: boolean = false,
    public readonly originalError?: unknown
  ) {
    super(`[${provider}] ${message}`);
    this.name = 'ProviderError';
  }
}

export type ProviderErrorCode =
  | 'RATE_LIMITED'
  | 'QUOTA_EXCEEDED'
  | 'AUTHENTICATION_FAILED'
  | 'MODEL_NOT_FOUND'
  | 'CONTEXT_EXCEEDED'
  | 'TIMEOUT'
  | 'NETWORK_ERROR'
  | 'INVALID_REQUEST'
  | 'INTERNAL_ERROR';

/**
 * Cost calculation for token usage
 */
export interface CostCalculator {
  name: string;
  calculate(usage: TokenUsage): number;
}