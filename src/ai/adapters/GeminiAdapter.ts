/**
 * OSIRIS AI Engine — Gemini Provider Adapter
 * 
 * Adaptateur pour Google Gemini API.
 * Implémente LLMProviderAdapter et EmbeddingProviderAdapter.
 * Remplaçable par tout autre provider sans impact sur le métier.
 */

import { GoogleGenerativeAI, type GenerativeModel } from '@google/generative-ai';
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
 * Gemini model name mapping
 */
const GEMINI_MODELS: Record<string, string> = {
  'gemini-2.0-flash': 'gemini-2.0-flash',
  'gemini-2.0-pro': 'gemini-2.0-pro',
  'gemini-1.5-pro': 'gemini-1.5-pro',
  'gemini-1.5-flash': 'gemini-1.5-flash',
  'text-embedding-004': 'text-embedding-004',
};

/**
 * Gemini LLM Provider Adapter
 */
export class GeminiLLMAdapter implements LLMProviderAdapter {
  readonly provider = 'gemini';
  private client: GoogleGenerativeAI | null = null;
  private modelConfig: ModelConfig | null = null;
  private modelCache: Map<string, GenerativeModel> = new Map();

  async initialize(config: ModelConfig): Promise<void> {
    if (!config.apiKey) {
      throw new ProviderError(
        'Gemini API key is required',
        'gemini',
        'AUTHENTICATION_FAILED'
      );
    }
    this.client = new GoogleGenerativeAI(config.apiKey);
    this.modelConfig = config;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const model = this.getModel('gemini-1.5-flash');
      await model.generateContent('ping');
      return true;
    } catch {
      return false;
    }
  }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    const startTime = Date.now();
    const model = this.getModel(request.model.modelId);
    const systemInstruction = request.messages.find((m) => m.role === 'system')?.content;
    const userMessages = request.messages.filter((m) => m.role !== 'system');

    try {
      const result = await model.generateContent({
        contents: userMessages.map((m) => ({
          role: m.role === 'assistant' ? 'model' : 'user',
          parts: [{ text: m.content }],
        })),
        systemInstruction: systemInstruction
          ? { role: 'user', parts: [{ text: systemInstruction }] }
          : undefined,
        generationConfig: {
          temperature: request.model.temperature ?? 0.7,
          maxOutputTokens: request.model.maxTokens ?? 8192,
          topP: request.model.topP ?? 0.95,
        },
      });

      const response = result.response;
      const text = response.text();
      
      // Estimate token usage (Gemini doesn't always return usage)
      const promptTokens = this.estimateTokens(
        JSON.stringify(request.messages.map((m) => m.content))
      );
      const completionTokens = this.estimateTokens(text);

      const usage: TokenUsage = {
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
      };

      // Try to get actual usage from response
      if (response.usageMetadata) {
        usage.promptTokens = response.usageMetadata.promptTokenCount ?? promptTokens;
        usage.completionTokens = response.usageMetadata.candidatesTokenCount ?? completionTokens;
        usage.totalTokens = usage.promptTokens + usage.completionTokens;
      }

      return {
        content: text,
        model: request.model,
        usage,
        latencyMs: Date.now() - startTime,
        finishReason: 'stop',
      };
    } catch (error) {
      const mappedError = this.mapError(error);
      const response: CompletionResponse = {
        content: '',
        model: request.model,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latencyMs: Date.now() - startTime,
        finishReason: 'error',
      };
      throw mappedError;
    }
  }

  async *completeStream(request: CompletionRequest): AsyncGenerator<CompletionResponse> {
    const model = this.getModel(request.model.modelId);
    const systemInstruction = request.messages.find((m) => m.role === 'system')?.content;
    const userMessages = request.messages.filter((m) => m.role !== 'system');

    const result = await model.generateContentStream({
      contents: userMessages.map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      })),
      systemInstruction: systemInstruction
        ? { role: 'user', parts: [{ text: systemInstruction }] }
        : undefined,
      generationConfig: {
        temperature: request.model.temperature ?? 0.7,
        maxOutputTokens: request.model.maxTokens ?? 8192,
      },
    });

    let accumulatedContent = '';

    for await (const chunk of result.stream) {
      const text = chunk.text();
      accumulatedContent += text;
      yield {
        content: text,
        model: request.model,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        latencyMs: 0,
        finishReason: 'stop',
      };
    }
  }

  estimateTokens(text: string): number {
    // Rough estimation: ~4 chars per token for Gemini
    return Math.ceil(text.length / 4);
  }

  /**
   * Get or create a GenerativeModel instance
   */
  private getModel(modelId: string): GenerativeModel {
    const cacheKey = modelId;
    const cached = this.modelCache.get(cacheKey);
    if (cached) return cached;

    const geminiModelId = GEMINI_MODELS[modelId] || modelId;

    if (!this.client) {
      throw new ProviderError(
        'Gemini client not initialized. Call initialize() first.',
        'gemini',
        'AUTHENTICATION_FAILED'
      );
    }

    const model = this.client.getGenerativeModel({ model: geminiModelId });
    this.modelCache.set(cacheKey, model);
    return model;
  }

  /**
   * Map Gemini errors to ProviderError
   */
  private mapError(error: unknown): ProviderError {
    if (error instanceof ProviderError) return error;

    const message = error instanceof Error ? error.message : 'Unknown Gemini error';
    let code: ProviderErrorCode = 'INTERNAL_ERROR';
    let retryable = false;

    if (message.includes('API_KEY') || message.includes('api key')) {
      code = 'AUTHENTICATION_FAILED';
    } else if (message.includes('RATE_LIMIT') || message.includes('quota')) {
      code = 'RATE_LIMITED';
      retryable = true;
    } else if (message.includes('timeout') || message.includes('TIMEOUT')) {
      code = 'TIMEOUT';
      retryable = true;
    } else if (message.includes('SAFETY') || message.includes('blocked')) {
      code = 'CONTEXT_EXCEEDED';
    } else if (message.includes('not found') || message.includes('404')) {
      code = 'MODEL_NOT_FOUND';
    } else if (message.includes('maximum context') || message.includes('token')) {
      code = 'CONTEXT_EXCEEDED';
    }

    return new ProviderError(message, 'gemini', code, retryable, error);
  }
}

/**
 * Gemini Embedding Provider Adapter
 */
export class GeminiEmbeddingAdapter implements EmbeddingProviderAdapter {
  readonly provider = 'gemini';
  private client: GoogleGenerativeAI | null = null;
  private dimensions: number = 768;

  async initialize(config: ModelConfig): Promise<void> {
    if (!config.apiKey) {
      throw new ProviderError(
        'Gemini API key is required for embeddings',
        'gemini',
        'AUTHENTICATION_FAILED'
      );
    }
    this.client = new GoogleGenerativeAI(config.apiKey);
    this.dimensions = config.modelId.includes('004') ? 768 : 768;
  }

  async embed(request: EmbeddingRequest): Promise<EmbeddingResponse> {
    const startTime = Date.now();
    const model = this.getEmbeddingModel();

    try {
      const inputs = Array.isArray(request.input) ? request.input : [request.input];
      const embeddings: number[][] = [];

      for (const input of inputs) {
        const result = await model.embedContent(input);
        embeddings.push(result.embedding.values);
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
      throw this.mapError(error);
    }
  }

  getDimensions(): number {
    return this.dimensions;
  }

  private getEmbeddingModel() {
    if (!this.client) {
      throw new ProviderError(
        'Gemini client not initialized',
        'gemini',
        'AUTHENTICATION_FAILED'
      );
    }
    return this.client.getGenerativeModel({ model: 'text-embedding-004' });
  }

  private mapError(error: unknown): ProviderError {
    const message = error instanceof Error ? error.message : 'Unknown embedding error';
    return new ProviderError(message, 'gemini', 'INTERNAL_ERROR');
  }
}