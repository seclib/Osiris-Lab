/**
 * OSIRIS AI Engine — OpenAI Provider Adapter
 * 
 * Adaptateur pour OpenAI API (GPT-4, GPT-4o, GPT-3.5).
 * Implémente LLMProviderAdapter et EmbeddingProviderAdapter.
 * Remplaçable sans impact sur le métier.
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
 * OpenAI model mapping
 */
const OPENAI_MODELS: Record<string, string> = {
  'gpt-4o': 'gpt-4o',
  'gpt-4o-mini': 'gpt-4o-mini',
  'gpt-4-turbo': 'gpt-4-turbo',
  'gpt-4': 'gpt-4',
  'gpt-3.5-turbo': 'gpt-3.5-turbo',
  'text-embedding-3-small': 'text-embedding-3-small',
  'text-embedding-3-large': 'text-embedding-3-large',
  'text-embedding-ada-002': 'text-embedding-ada-002',
};

/**
 * OpenAI LLM Provider Adapter
 */
export class OpenAILLMAdapter implements LLMProviderAdapter {
  readonly provider = 'openai';
  private apiKey: string = '';
  private baseUrl: string = 'https://api.openai.com/v1';
  private modelConfig: ModelConfig | null = null;

  async initialize(config: ModelConfig): Promise<void> {
    if (!config.apiKey) {
      throw new ProviderError(
        'OpenAI API key is required',
        'openai',
        'AUTHENTICATION_FAILED'
      );
    }
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    this.modelConfig = config;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/models`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const startTime = Date.now();
    const modelId = OPENAI_MODELS[request.model.modelId] || request.model.modelId;

    try {
      const body = {
        model: modelId,
        messages: request.messages.map((m) => ({
          role: m.role === 'system' ? 'system' : m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
        temperature: request.model.temperature ?? 0.7,
        max_tokens: request.model.maxTokens ?? 4096,
        top_p: request.model.topP ?? 1,
      };

      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw await this.handleHttpError(response);
      }

      const data = await response.json();
      const choice = data.choices?.[0];

      if (!choice?.message?.content) {
        throw new ProviderError('Empty response from OpenAI', 'openai', 'INTERNAL_ERROR');
      }

      return {
        content: choice.message.content,
        model: request.model,
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? this.estimateTokens(JSON.stringify(request.messages)),
          completionTokens: data.usage?.completion_tokens ?? this.estimateTokens(choice.message.content),
          totalTokens: data.usage?.total_tokens ?? 0,
        },
        latencyMs: Date.now() - startTime,
        finishReason: choice.finish_reason === 'stop' ? 'stop' : choice.finish_reason === 'length' ? 'length' : 'error',
      };
    } catch (error) {
      const mappedError = this.mapError(error);
      throw mappedError;
    }
  }

  async *completeStream(request: CompletionRequest): AsyncGenerator<CompletionResponse> {
    const modelId = OPENAI_MODELS[request.model.modelId] || request.model.modelId;

    const body = {
      model: modelId,
      messages: request.messages.map((m) => ({
        role: m.role === 'system' ? 'system' : m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
      temperature: request.model.temperature ?? 0.7,
      max_tokens: request.model.maxTokens ?? 4096,
      stream: true,
    };

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw await this.handleHttpError(response);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new ProviderError('No response body for stream', 'openai', 'INTERNAL_ERROR');

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed === 'data: [DONE]') continue;
        if (!trimmed.startsWith('data: ')) continue;

        try {
          const data = JSON.parse(trimmed.slice(6));
          const content = data.choices?.[0]?.delta?.content || '';
          if (content) {
            yield {
              content,
              model: request.model,
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
              latencyMs: 0,
              finishReason: 'stop',
            };
          }
        } catch {
          // Skip malformed lines
        }
      }
    }
  }

  estimateTokens(text: string): number {
    // OpenAI: ~4 chars per token
    return Math.ceil(text.length / 4);
  }

  /**
   * Handle HTTP errors from OpenAI API
   */
  private async handleHttpError(response: Response): Promise<ProviderError> {
    let message = `HTTP ${response.status}`;
    try {
      const errorBody = await response.json();
      message = errorBody.error?.message || message;
    } catch {
      // Use default message
    }

    let code: ProviderErrorCode = 'INTERNAL_ERROR';
    let retryable = false;

    switch (response.status) {
      case 401:
        code = 'AUTHENTICATION_FAILED';
        break;
      case 429:
        code = 'RATE_LIMITED';
        retryable = true;
        break;
      case 500:
      case 502:
      case 503:
        retryable = true;
        break;
    }

    return new ProviderError(message, 'openai', code, retryable);
  }

  /**
   * Map errors to ProviderError
   */
  private mapError(error: unknown): ProviderError {
    if (error instanceof ProviderError) return error;
    const message = error instanceof Error ? error.message : 'Unknown OpenAI error';
    let code: ProviderErrorCode = 'INTERNAL_ERROR';
    let retryable = false;

    if (message.includes('API key') || message.includes('api_key') || message.includes('401')) {
      code = 'AUTHENTICATION_FAILED';
    } else if (message.includes('rate') || message.includes('429') || message.includes('quota')) {
      code = 'RATE_LIMITED';
      retryable = true;
    } else if (message.includes('timeout') || message.includes('TIMEOUT')) {
      code = 'TIMEOUT';
      retryable = true;
    } else if (message.includes('context_length') || message.includes('maximum context')) {
      code = 'CONTEXT_EXCEEDED';
    } else if (message.includes('model')) {
      code = 'MODEL_NOT_FOUND';
    } else if (message.includes('network') || message.includes('fetch')) {
      code = 'NETWORK_ERROR';
      retryable = true;
    }

    return new ProviderError(message, 'openai', code, retryable, error);
  }
}

/**
 * OpenAI Embedding Provider Adapter
 */
export class OpenAIEmbeddingAdapter implements EmbeddingProviderAdapter {
  readonly provider = 'openai';
  private apiKey: string = '';
  private baseUrl: string = 'https://api.openai.com/v1';
  private dimensions: number = 1536;

  async initialize(config: ModelConfig): Promise<void> {
    if (!config.apiKey) {
      throw new ProviderError('OpenAI API key is required for embeddings', 'openai', 'AUTHENTICATION_FAILED');
    }
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.openai.com/v1';
    this.dimensions = config.modelId.includes('large') ? 3072 : 1536;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const startTime = Date.now();
    const modelId = 'text-embedding-3-small';

    try {
      const inputs = Array.isArray(request.input) ? request.input : [request.input];

      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          input: inputs,
        }),
      });

      if (!response.ok) {
        const errorBody = await response.text();
        throw new ProviderError(
          `Embedding API error: ${errorBody}`,
          'openai',
          response.status === 429 ? 'RATE_LIMITED' : 'INTERNAL_ERROR'
        );
      }

      const data = await response.json() as { data: Array<{ embedding: number[] }>; usage?: { prompt_tokens: number; total_tokens: number } };
      const embeddings = data.data.map((item) => item.embedding);

      return {
        embeddings,
        model: request.model,
        usage: {
          promptTokens: data.usage?.prompt_tokens ?? inputs.reduce((sum, str) => sum + Math.ceil(str.length / 4), 0),
          completionTokens: 0,
          totalTokens: data.usage?.total_tokens ?? 0,
        },
        latencyMs: Date.now() - startTime,
      };
    } catch (error) {
      if (error instanceof ProviderError) throw error;
      throw new ProviderError(
        error instanceof Error ? error.message : 'Unknown embedding error',
        'openai',
        'INTERNAL_ERROR'
      );
    }
  }

  getDimensions(): number {
    return this.dimensions;
  }
}