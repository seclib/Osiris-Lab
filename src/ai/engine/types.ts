/**
 * OSIRIS AI Engine — Core Types
 * 
 * Types unifiés pour tout le système IA.
 * Aucun couplage avec un provider spécifique.
 */

/**
 * Supported LLM providers
 */
export enum LLMProvider {
  GEMINI = 'gemini',
  OPENAI = 'openai',
  ANTHROPIC = 'anthropic',
  OLLAMA = 'ollama',
}

/**
 * Model configuration
 */
export interface ModelConfig {
  provider: LLMProvider;
  modelId: string;
  temperature?: number;
  maxTokens?: number;
  topP?: number;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Message role in a conversation
 */
export type MessageRole = 'system' | 'user' | 'assistant' | 'tool';

/**
 * Chat message
 */
export interface ChatMessage {
  role: MessageRole;
  content: string;
  name?: string;
  toolCallId?: string;
}

/**
 * LLM completion request
 */
export interface CompletionRequest {
  messages: ChatMessage[];
  model: ModelConfig;
  stream?: boolean;
  responseFormat?: 'text' | 'json';
}

/**
 * LLM completion response
 */
export interface CompletionResponse {
  content: string;
  model: ModelConfig;
  usage: TokenUsage;
  latencyMs: number;
  finishReason: 'stop' | 'length' | 'error' | 'content_filter';
}

/**
 * Token usage tracking
 */
export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUSD?: number;
}

/**
 * Embedding request
 */
export interface EmbeddingRequest {
  input: string | string[];
  model: EmbeddingModel;
}

/**
 * Embedding model configuration
 */
export interface EmbeddingModel {
  provider: LLMProvider;
  modelId: string;
  dimensions: number;
}

/**
 * Embedding response
 */
export interface EmbeddingResponse {
  embeddings: number[][];
  model: EmbeddingModel;
  usage: TokenUsage;
  latencyMs: number;
}

/**
 * Memory entry
 */
export interface MemoryEntry {
  id: string;
  content: string;
  metadata: Record<string, unknown>;
  timestamp: number;
  ttl?: number; // Time-to-live in ms
  embedding?: number[];
}

/**
 * Agent configuration
 */
export interface AgentConfig {
  id: string;
  name: string;
  description: string;
  systemPrompt: string;
  model: ModelConfig;
  tools: ToolDefinition[];
  memory?: {
    type: 'short_term' | 'long_term' | 'none';
    maxEntries?: number;
  };
}

/**
 * Tool definition for agents
 */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  handler: (params: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Agent execution context
 */
export interface AgentContext {
  agentId: string;
  sessionId: string;
  userId?: string;
  messages: ChatMessage[];
  memory: MemoryEntry[];
  metadata: Record<string, unknown>;
}

/**
 * Agent execution result
 */
export interface AgentResult {
  agentId: string;
  sessionId: string;
  response: string;
  tokensUsed: number;
  latencyMs: number;
  toolsCalled: number;
}

/**
 * AI Engine event for observability
 */
export interface AIEngineEvent {
  type: 'completion' | 'embedding' | 'agent' | 'memory' | 'error';
  timestamp: number;
  durationMs: number;
  model?: string;
  provider?: string;
  tokens?: number;
  error?: string;
  metadata?: Record<string, unknown>;
}

/**
 * RAG document
 */
export interface RAGDocument {
  id: string;
  content: string;
  metadata: {
    source: string;
    type: string;
    timestamp: number;
    title?: string;
    tags?: string[];
  };
  embedding?: number[];
}