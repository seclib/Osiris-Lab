/**
 * OSIRIS AI Engine — Ollama Provider Adapter (Local Inference)
 * 
 * Adaptateur pour Ollama (LLaMA, Mistral, Qwen, DeepSeek, etc.).
 * Fonctionne 100% en local — aucune donnée envoyée à un tiers.
 * Idéal pour les environnements air-gapped / classifié.
 * 
 * Implémente LLMProviderAdapter et EmbeddingProviderAdapter.
 */

import type { LLMProviderAdapter, EmbeddingProviderAdapter, ProviderErrorCode } from './interfaces';
import { ProviderError } from './interfaces';
import type {
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  ModelConfig,
  TokenUsage,
} from '../engine/types';

/**
 * Ollama LLM Provider Adapter (Local)
 */
export class OllamaLLMAdapter implements LLMProviderAdapter {
  readonly provider = 'ollama';
  private baseUrl: string = 'http://localhost:11434';
  private modelConfig: ModelConfig | null = null;
  private availableModels: string[] = [];

  async initialize(config: ModelConfig): Promise<void> {
    this.baseUrl = config.baseUrl || 'http://localhost:11434';
    this.modelConfig = config;
    // Fetch available models
    await this.refreshModels();
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const startTime = Date.now();
    const modelId = request.model.modelId;

    try {
      const systemMessage = request.messages.find((m) => m.role === 'system');
      const userMessages = request.messages.filter((m) => m.role !== 'system');

      const prompt = systemMessage
        ? `${systemMessage.content}\n\n${userMessages.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n')}\n\nAssistant:`
        : userMessages.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n') + '\n\nAssistant:';

      const response = await fetch(`${this.baseUrl}/api/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: modelId,
          prompt,
          stream: false,
          options: {
            temperature: request.model.temperature ?? 0.7,
            num_predict: request.model.maxTokens ?? 4096,
            top_p: request.model.topP ?? 0.9,
          },
        }),
      });

      if (!response.ok) {
        throw await this.handleHttpError(response);
      }

      const data = await response.json() as {
        response: string;
        eval_count?: number;
        prompt_eval_count?: number;
      };

      return {
        content: data.response || '',
        model: request.model,
        usage: {
          promptTokens: data.prompt_eval_count ?? this.estimateTokens(prompt),
          completionTokens: data.eval_count ?? this.estimateTokens(data.response || ''),
          totalTokens: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0),
        },
        latencyMs: Date.now() - startTime,
        finishReason: 'stop',
      };
    } catch (error) {
      throw this.mapError(error);
    }
  }

  async *completeStream(request: CompletionRequest): AsyncGenerator<CompletionResponse> {
    const modelId = request.model.modelId;
    const systemMessage = request.messages.find((m) => m.role === 'system');
    const userMessages = request.messages.filter((m) => m.role !== 'system');

    const prompt = systemMessage
      ? `${systemMessage.content}\n\n${userMessages.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n')}\n\nAssistant:`
      : userMessages.map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${m.content}`).join('\n') + '\n\nAssistant:';

    const response = await fetch(`${this.baseUrl}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: modelId,
        prompt,
        stream: true,
        options: {
          temperature: request.model.temperature ?? 0.7,
          num_predict: request.model.maxTokens ?? 4096,
        },
      }),
    });

    if (!response.ok) {
      throw await this.handleHttpError(response);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new ProviderError('No response body for stream', 'ollama', 'INTERNAL_ERROR');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        try {
          const data = JSON.parse(line);
          if (data.response) {
            yield {
              content: data.response,
              model: request.model,
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
              latencyMs: 0,
              finishReason: 'stop',
            };
          }
          if (data.done) break;
        } catch {
          // Skip malformed
        }
      }
    }
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }

  /**
   * Pull a model from Ollama registry
   */
  async pullModel(modelName: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName, stream: false }),
    });

    if (!response.ok) {
      throw new ProviderError(
        `Failed to pull model ${modelName}`,
        'ollama',
        'MODEL_NOT_FOUND'
      );
    }

    await this.refreshModels();
  }

  /**
   * List available models
   */
  async listModels(): Promise<string[]> {
    await this.refreshModels();
    return this.availableModels;
  }

  /**
   * Refresh available models list
   */
  private async refreshModels(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      if (response.ok) {
        const data = await response.json() as { models: Array<{ name: string }> };
        this.availableModels = data.models?.map((m) => m.name) || [];
      }
    } catch {
      this.availableModels = [];
    }
  }

  private async handleHttpError(response: Response): Promise<ProviderError> {
    const message = `HTTP ${response.status}`;
    let code: ProviderErrorCode = 'INTERNAL_ERROR';
    let retryable = false;

    if (response.status === 404) {
      code = 'MODEL_NOT_FOUND';
    } else if (response.status >= 500) {
      retryable = true;
    }

    return new ProviderError(message, 'ollama', code, retryable);
  }

  private mapError(error: unknown): ProviderError {
    if (error instanceof ProviderError) return error;
    const message = error instanceof Error ? error.message : 'Unknown Ollama error';

    let code: ProviderErrorCode = 'INTERNAL_ERROR';
    let retryable = false;

    if (message.includes('not found') || message.includes('model')) {
      code = 'MODEL_NOT_FOUND';
    } else if (message.includes('connect') || message.includes('ECONNREFUSED')) {
      code = 'NETWORK_ERROR';
      retryable = true;
    } else if (message.includes('timeout')) {
      code = 'TIMEOUT';
      retryable = true;
    }

    return new ProviderError(message, 'ollama', code, retryable, error);
  }
}

/**
 * Ollama Embedding Provider Adapter (Local)
 */
export class OllamaEmbeddingAdapter implements EmbeddingProviderAdapter {
  readonly provider = 'ollama';
  private baseUrl: string = 'http://localhost:11434';
  private dimensions: number = 4096;

  async initialize(config: ModelConfig): Promise<void> {
    this.baseUrl = config.baseUrl || 'http://localhost:11434';
    // nomic-embed-text: 768, mxbai-embed-large: 1024, all-minilm: 384
    this.dimensions = config.modelId.includes('minilm') ? 384 :
                      config.modelId.includes('nomic') ? 768 :
                      config.modelId.includes('mxbai') ? 1024 : 4096;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const startTime = Date.now();
    const modelId = request.model.modelId;

    try {
      const inputs = Array.isArray(request.input) ? request.input : [request.input];
      const embeddings: number[][] = [];

      for (const input of inputs) {
        const response = await fetch(`${this.baseUrl}/api/embeddings`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ model: modelId, prompt: input }),
        });

        if (!response.ok) {
          throw new ProviderError(
            `Embedding API error: HTTP ${response.status}`,
            'ollama',
            'INTERNAL_ERROR'
          );
        }

        const data = await response.json() as { embedding: number[] };
        embeddings.push(data.embedding);
      }

      return {
        embeddings,
        model: request.model,
        usage: {
          promptTokens: inputs.reduce((sum, str) => sum + Math.ceil(str.length / 4), 0),
          completionTokens: 0,
          totalTokens: inputs.reduce((sum, str) => sum + Math.ceil(str.length / 4), 0),
        },
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        error instanceof Error ? error.message : 'Unknown embedding error',
        'ollama',
        'INTERNAL_ERROR'
      );
    }
  }

  getDimensions(): number {
    return this.dimensions;
  }
}