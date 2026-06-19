/**
 * OSIRIS AI Engine — Barrel Export
 * 
 * Point d'entrée unique pour tout le système IA.
 * Toute interaction IA passe par cette interface.
 */

// Core Engine
export { AIEngine, getAIEngine, resetAIEngine } from './AIEngine';
export type { AIEngineConfig } from './AIEngine';

// Types
export {
  LLMProvider,
} from './types';
export type {
  ModelConfig,
  ChatMessage,
  MessageRole,
  CompletionRequest,
  CompletionResponse,
  TokenUsage,
  EmbeddingRequest,
  EmbeddingResponse,
  EmbeddingModel,
  MemoryEntry,
  AgentConfig,
  AgentContext,
  AgentResult,
  ToolDefinition,
  AIEngineEvent,
  RAGDocument,
} from './types';

// Adapters
export { ProviderError } from '../adapters/interfaces';
export type {
  LLMProviderAdapter,
  EmbeddingProviderAdapter,
  ProviderFactory,
  ProviderErrorCode,
  CostCalculator,
} from '../adapters/interfaces';

export { GeminiLLMAdapter, GeminiEmbeddingAdapter } from '../adapters/GeminiAdapter';
export { OpenAILLMAdapter, OpenAIEmbeddingAdapter } from '../adapters/OpenAIAdapter';
export { AnthropicLLMAdapter } from '../adapters/AnthropicAdapter';
export { OllamaLLMAdapter, OllamaEmbeddingAdapter } from '../adapters/OllamaAdapter';
export { MemoryService } from '../services/MemoryService';
export type { MemoryType, MemorySearchOptions, ConsolidationResult, MemoryStats } from '../services/MemoryService';
