/**
 * OSIRIS AI Engine — Anthropic Provider Adapter
 * 
 * Adaptateur pour Anthropic Claude API (Claude 3/4).
 * Implémente LLMProviderAdapter.
 * Remplaçable sans impact sur le métier.
 */

import type { LLMProviderAdapter, ProviderErrorCode } from './interfaces';
import { ProviderError } from './interfaces';
import type {
  CompletionRequest,
  CompletionResponse,
  ModelConfig,
} from '../engine/types';

/**
 * Anthropic model mapping
 */
const ANTHROPIC_MODELS: Record<string, string> = {
  'claude-3-opus': 'claude-3-opus-20240229',
  'claude-3-sonnet': 'claude-3-sonnet-20240229',
  'claude-3-haiku': 'claude-3-haiku-20240307',
  'claude-3.5-sonnet': 'claude-3-5-sonnet-20240620',
  'claude-3.5-haiku': 'claude-3-5-haiku-20241022',
  'claude-4': 'claude-4-20250514',
};

/**
 * Anthropic LLM Provider Adapter
 */
export class AnthropicLLMAdapter implements LLMProviderAdapter {
  readonly provider = 'anthropic';
  private apiKey: string = '';
  private baseUrl: string = 'https://api.anthropic.com/v1';
  private modelConfig: ModelConfig | null = null;
  private apiVersion: string = '2023-06-01';

  async initialize(config: ModelConfig): Promise<void> {
    if (!config.apiKey) {
      throw new ProviderError(
        'Anthropic API key is required',
        'anthropic',
        'AUTHENTICATION_FAILED'
      );
    }
    this.apiKey = config.apiKey;
    this.baseUrl = config.baseUrl || 'https://api.anthropic.com/v1';
    this.modelConfig = config;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': this.apiVersion,
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const startTime = Date.now();
    const modelId = ANTHROPIC_MODELS[request.model.modelId] || request.model.modelId;

    try {
      const systemMessage = request.messages.find((m) => m.role === 'system');
      const userMessages = request.messages.filter((m) => m.role !== 'system');

      const body: Record<string, unknown> = {
        model: modelId,
        max_tokens: request.model.maxTokens ?? 4096,
        messages: userMessages.map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: m.content,
        })),
      };

      if (systemMessage?.content) {
        body.system = systemMessage.content;
      }

      if (request.model.temperature !== undefined) {
        body.temperature = request.model.temperature;
      }

      if (request.model.topP !== undefined) {
        body.top_p = request.model.topP;
      }

      const response = await fetch(`${this.baseUrl}/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': this.apiVersion,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        throw await this.handleHttpError(response);
      }

      const data = await response.json() as {
        content: Array<{ text: string }>;
        usage: { input_tokens: number; output_tokens: number };
        stop_reason: string;
      };

      const content = data.content?.map((c) => c.text).join('') || '';

      return {
        content,
        model: request.model,
        usage: {
          promptTokens: data.usage?.input_tokens ?? this.estimateTokens(JSON.stringify(request.messages)),
          completionTokens: data.usage?.output_tokens ?? this.estimateTokens(content),
          totalTokens: (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
        },
        latencyMs: Date.now() - startTime,
        finishReason: data.stop_reason === 'end_turn' ? 'stop' : data.stop_reason === 'max_tokens' ? 'length' : 'stop',
      };
    } catch (error) {
      const mappedError = this.mapError(error);
      throw mappedError;
    }
  }

  async *completeStream(request: CompletionRequest): AsyncGenerator<CompletionResponse> {
    const modelId = ANTHROPIC_MODELS[request.model.modelId] || request.model.modelId;
    const systemMessage = request.messages.find((m) => m.role === 'system');
    const userMessages = request.messages.filter((m) => m.role !== 'system');

    const body: Record<string, unknown> = {
      model: modelId,
      max_tokens: request.model.maxTokens ?? 4096,
      messages: userMessages.map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      })),
      stream: true,
    };

    if (systemMessage?.content) {
      body.system = systemMessage.content;
    }

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.apiKey,
        'anthropic-version': this.apiVersion,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw await this.handleHttpError(response);
    }

    const reader = response.body?.getReader();
    if (!reader) throw new ProviderError('No response body for stream', 'anthropic', 'INTERNAL_ERROR');

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
        if (!trimmed || !trimmed.startsWith('data: ')) continue;

        try {
          const data = JSON.parse(trimmed.slice(6));
          if (data.type === 'content_block_delta' && data.delta?.text) {
            yield {
              content: data.delta.text,
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
    // Anthropic: ~6 chars per token (longer tokenization)
    return Math.ceil(text.length / 6);
  }

  /**
   * Handle HTTP errors
   */
  private async handleHttpError(response: Response): Promise<ProviderError> {
    let message = `HTTP ${response.status}`;
    try {
      const errorBody = await response.json() as { error?: { message?: string } };
      message = errorBody.error?.message || message;
    } catch {
      // Use default
    }

    let code: ProviderErrorCode = 'INTERNAL_ERROR';
    let retryable = false;

    switch (response.status) {
      case 401:
      case 403:
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
      case 400:
        code = 'INVALID_REQUEST';
        break;
    }

    return new ProviderError(message, 'anthropic', code, retryable);
  }

  /**
   * Map errors to ProviderError
   */
  private mapError(error: unknown): ProviderError {
    if (error instanceof ProviderError) return error;
    const message = error instanceof Error ? error.message : 'Unknown Anthropic error';
    let code: ProviderErrorCode = 'INTERNAL_ERROR';
    let retryable = false;

    if (message.includes('api key') || message.includes('x-api-key') || message.includes('401') || message.includes('403')) {
      code = 'AUTHENTICATION_FAILED';
    } else if (message.includes('rate') || message.includes('429') || message.includes('quota')) {
      code = 'RATE_LIMITED';
      retryable = true;
    } else if (message.includes('timeout') || message.includes('TIMEOUT')) {
      code = 'TIMEOUT';
      retryable = true;
    } else if (message.includes('too many tokens') || message.includes('max_tokens')) {
      code = 'CONTEXT_EXCEEDED';
    } else if (message.includes('not found') || message.includes('model')) {
      code = 'MODEL_NOT_FOUND';
    } else if (message.includes('network') || message.includes('fetch')) {
      code = 'NETWORK_ERROR';
      retryable = true;
    } else if (message.includes('invalid') || message.includes('400')) {
      code = 'INVALID_REQUEST';
    }

    return new ProviderError(message, 'anthropic', code, retryable, error);
  }
}