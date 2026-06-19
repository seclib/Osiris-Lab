/**
 * OSIRIS AI Engine — Unit Tests
 * 
 * Tests for AIEngine, adapters, and services.
 * Run with: npx vitest run src/ai/tests/
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AIEngine, getAIEngine, resetAIEngine } from '../engine/AIEngine';
import { LLMProvider } from '../engine/types';
import type { ModelConfig, CompletionRequest, CompletionResponse } from '../engine/types';
import { ProviderError } from '../adapters/interfaces';

// ─── Mock Adapter ────────────────────────────────────────────────────────────

class MockLLMAdapter implements LLMProviderAdapter {
  readonly provider = 'mock';
  private shouldFail = false;
  private responseContent = 'Mock response';
  private delayMs = 0;

  setShouldFail(value: boolean) { this.shouldFail = value; }
  setResponse(content: string) { this.responseContent = content; }
  setDelay(ms: number) { this.delayMs = ms; }

  async initialize(config: ModelConfig): Promise<void> {}
  async healthCheck(): Promise<boolean> { return !this.shouldFail; }

  async complete(request: CompletionRequest): Promise<CompletionResponse> {
    if (this.shouldFail) {
      throw new ProviderError('Mock failure', 'mock', 'INTERNAL_ERROR');
    }
    await this.delay(this.delayMs);
    return {
      content: this.responseContent,
      model: request.model,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      latencyMs: this.delayMs,
      finishReason: 'stop',
    };
  }

  async *completeStream(request: CompletionRequest): AsyncGenerator<CompletionResponse> {
    yield {
      content: this.responseContent,
      model: request.model,
      usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      latencyMs: 0,
      finishReason: 'stop',
    };
  }

  estimateTokens(text: string): number {
    return Math.ceil(text.length / 4);
  }
}

// ─── Test Setup ──────────────────────────────────────────────────────────────

const createMockConfig = (provider: LLMProvider = LLMProvider.GEMINI, modelId: string = 'mock-model'): ModelConfig => ({
  provider,
  modelId,
  apiKey: 'test-key',
});

const createEngine = (config?: Partial<ModelConfig>) => {
  resetAIEngine();
  const engine = getAIEngine({
    defaultModel: createMockConfig(LLMProvider.GEMINI, 'gemini-2.0-flash'),
    fallbackModels: [createMockConfig(LLMProvider.OPENAI, 'gpt-4o-mini')],
    ...config,
  });
  return engine;
};

// ─── AIEngine Tests ──────────────────────────────────────────────────────────

describe('AIEngine', () => {
  beforeEach(() => {
    resetAIEngine();
  });

  describe('initialization', () => {
    it('should create engine with default config', () => {
      const engine = createEngine();
      expect(engine).toBeDefined();
    });

    it('should throw if no config provided', () => {
      resetAIEngine();
      expect(() => getAIEngine()).toThrow('AIEngine must be initialized with a config');
    });

    it('should return same instance (singleton)', () => {
      const engine1 = getAIEngine({
        defaultModel: createMockConfig(LLMProvider.GEMINI, 'gemini-2.0-flash'),
      });
      const engine2 = getAIEngine({
        defaultModel: createMockConfig(LLMProvider.GEMINI, 'gemini-2.0-flash'),
      });
      expect(engine1).toBe(engine2);
    });
  });

  describe('provider registration', () => {
    it('should register a provider', () => {
      const engine = createEngine();
      const mock = new MockLLMAdapter();
      engine.registerProvider(createMockConfig(LLMProvider.GEMINI, 'gemini-2.0-flash'), mock);
      
      const providers = engine.getProviders();
      expect(providers.length).toBeGreaterThanOrEqual(1);
    });

    it('should unregister a provider', () => {
      const engine = createEngine();
      const mock = new MockLLMAdapter();
      const config = createMockConfig(LLMProvider.GEMINI, 'test-model');
      engine.registerProvider(config, mock);
      
      engine.unregisterProvider(config);
      // Provider should be removed
    });
  });

  describe('completion', () => {
    it('should complete a request', async () => {
      const engine = createEngine();
      const mock = new MockLLMAdapter();
      mock.setResponse('Hello, world!');
      engine.registerProvider(createMockConfig(LLMProvider.GEMINI, 'gemini-2.0-flash'), mock);

      const response = await engine.complete({
        messages: [{ role: 'user', content: 'Hi' }],
        model: createMockConfig(LLMProvider.GEMINI, 'gemini-2.0-flash'),
      });

      expect(response.content).toBe('Hello, world!');
      expect(response.usage.totalTokens).toBe(30);
    });

    it('should throw if provider not found and no fallback', async () => {
      const engine = createEngine({ fallbackModels: [] });
      
      await expect(
        engine.complete({
          messages: [{ role: 'user', content: 'Hi' }],
          model: createMockConfig(LLMProvider.GEMINI, 'nonexistent'),
        })
      ).rejects.toThrow('No provider available');
    });

    it('should use fallback on provider failure', async () => {
      const engine = createEngine();
      
      const failingMock = new MockLLMAdapter();
      failingMock.setShouldFail(true);
      engine.registerProvider(createMockConfig(LLMProvider.GEMINI, 'gemini-2.0-flash'), failingMock);

      const workingMock = new MockLLMAdapter();
      workingMock.setResponse('From fallback');
      engine.registerProvider(createMockConfig(LLMProvider.OPENAI, 'gpt-4o-mini'), workingMock);

      const response = await engine.complete({
        messages: [{ role: 'user', content: 'Hi' }],
        model: createMockConfig(LLMProvider.GEMINI, 'gemini-2.0-flash'),
      });

      expect(response.content).toBe('From fallback');
    });
  });

  describe('streaming', () => {
    it('should stream completions', async () => {
      const engine = createEngine();
      const mock = new MockLLMAdapter();
      mock.setResponse('Streamed response');
      engine.registerProvider(createMockConfig(LLMProvider.GEMINI, 'gemini-2.0-flash'), mock);

      const chunks: CompletionResponse[] = [];
      for await (const chunk of engine.completeStream({
        messages: [{ role: 'user', content: 'Hi' }],
        model: createMockConfig(LLMProvider.GEMINI, 'gemini-2.0-flash'),
      })) {
        chunks.push(chunk);
      }

      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks[0].content).toBe('Streamed response');
    });
  });

  describe('health check', () => {
    it('should return health status', async () => {
      const engine = createEngine();
      const mock = new MockLLMAdapter();
      engine.registerProvider(createMockConfig(LLMProvider.GEMINI, 'gemini-2.0-flash'), mock);

      const health = await engine.health();
      expect(health.healthy).toBe(true);
      expect(health.providers.length).toBeGreaterThan(0);
    });
  });

  describe('metrics', () => {
    it('should track events', async () => {
      const engine = createEngine({ enableMetrics: true });
      const mock = new MockLLMAdapter();
      engine.registerProvider(createMockConfig(LLMProvider.GEMINI, 'gemini-2.0-flash'), mock);

      await engine.complete({
        messages: [{ role: 'user', content: 'Hi' }],
        model: createMockConfig(LLMProvider.GEMINI, 'gemini-2.0-flash'),
      });

      const stats = engine.getStats();
      expect(stats.totalRequests).toBeGreaterThan(0);
      expect(stats.totalTokens).toBeGreaterThan(0);
    });

    it('should calculate error rate', async () => {
      const engine = createEngine({ enableMetrics: true });
      const mock = new MockLLMAdapter();
      mock.setShouldFail(true);
      engine.registerProvider(createMockConfig(LLMProvider.GEMINI, 'gemini-2.0-flash'), mock);

      try {
        await engine.complete({
          messages: [{ role: 'user', content: 'Hi' }],
          model: createMockConfig(LLMProvider.GEMINI, 'gemini-2.0-flash'),
        });
      } catch {
        // Expected
      }

      const stats = engine.getStats();
      expect(stats.errorRate).toBeGreaterThan(0);
    });
  });
});

// ─── MemoryService Tests ─────────────────────────────────────────────────────

describe('MemoryService', () => {
  it('should store and recall memories', async () => {
    const { MemoryService } = await import('../services/MemoryService');
    const memory = new MemoryService();

    await memory.remember('Test memory', { key: 'value' }, 'short_term');
    const results = await memory.recall({ query: 'Test', limit: 10 });

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].content).toBe('Test memory');
  });

  it('should forget memories', async () => {
    const { MemoryService } = await import('../services/MemoryService');
    const memory = new MemoryService();

    const entry = await memory.remember('To forget', {}, 'short_term');
    const deleted = await memory.forget(entry.id);

    expect(deleted).toBe(true);

    const results = await memory.recall({ query: 'forget' });
    expect(results.length).toBe(0);
  });

  it('should clear memories', async () => {
    const { MemoryService } = await import('../services/MemoryService');
    const memory = new MemoryService();

    await memory.remember('Memory 1', {}, 'short_term');
    await memory.remember('Memory 2', {}, 'long_term');

    await memory.clear('short_term');

    const stats = memory.getStats();
    expect(stats.shortTermCount).toBe(0);
    expect(stats.longTermCount).toBeGreaterThan(0);
  });

  it('should consolidate memories', async () => {
    const { MemoryService } = await import('../services/MemoryService');
    const memory = new MemoryService();

    // Add enough entries for consolidation
    for (let i = 0; i < 25; i++) {
      await memory.remember(`Entry ${i}: some content here`, {}, 'short_term');
    }

    const result = await memory.consolidate();
    expect(result.entriesConsolidated).toBeGreaterThan(0);
    expect(result.tokensSaved).toBeGreaterThan(0);
  });

  it('should return stats', async () => {
    const { MemoryService } = await import('../services/MemoryService');
    const memory = new MemoryService();

    await memory.remember('Test', {}, 'short_term');

    const stats = memory.getStats();
    expect(stats.shortTermCount).toBe(1);
    expect(stats.totalTokens).toBeGreaterThan(0);
  });
});

// ─── RAGService Tests ────────────────────────────────────────────────────────

describe('RAGService', () => {
  it('should ingest a document', async () => {
    const { RAGService } = await import('../rag/RAGService');
    const rag = new RAGService();

    const doc = {
      id: 'doc-1',
      content: 'This is a test document about AI. It contains multiple sentences. The AI engine is powerful.',
      metadata: { source: 'test', title: 'Test Doc' },
    };

    const chunksCount = await rag.ingest(doc);
    expect(chunksCount).toBeGreaterThan(0);

    const stats = rag.stats();
    expect(stats.documents).toBe(1);
    expect(stats.chunks).toBeGreaterThan(0);
  });

  it('should ingest multiple documents', async () => {
    const { RAGService } = await import('../rag/RAGService');
    const rag = new RAGService();

    await rag.ingestBatch([
      { id: 'doc-1', content: 'First document', metadata: { source: 'test' } },
      { id: 'doc-2', content: 'Second document', metadata: { source: 'test' } },
    ]);

    const stats = rag.stats();
    expect(stats.documents).toBe(2);
  });

  it('should remove a document', async () => {
    const { RAGService } = await import('../rag/RAGService');
    const rag = new RAGService();

    await rag.ingest({ id: 'doc-1', content: 'Test', metadata: { source: 'test' } });
    rag.remove('doc-1');

    const stats = rag.stats();
    expect(stats.documents).toBe(0);
  });

  it('should chunk with different strategies', async () => {
    const { RAGService } = await import('../rag/RAGService');
    
    const content = 'Sentence one. Sentence two. Sentence three. Sentence four. Sentence five.';
    
    const fixedRag = new RAGService({ chunkStrategy: 'fixed', chunkSize: 20, chunkOverlap: 5 });
    const fixedChunks = await fixedRag.ingest({ id: 'fixed', content, metadata: { source: 'test' } });
    expect(fixedChunks).toBeGreaterThan(0);

    const sentenceRag = new RAGService({ chunkStrategy: 'sentence', chunkSize: 100, chunkOverlap: 10 });
    const sentenceChunks = await sentenceRag.ingest({ id: 'sentence', content, metadata: { source: 'test' } });
    expect(sentenceChunks).toBeGreaterThan(0);
  });
});

// ─── AgentOrchestrator Tests ─────────────────────────────────────────────────

describe('AgentOrchestrator', () => {
  it('should register and list agents', async () => {
    const { AgentOrchestrator } = await import('../agents/AgentOrchestrator');
    const orchestrator = new AgentOrchestrator();

    orchestrator.registerAgent({
      id: 'test-agent',
      name: 'Test Agent',
      description: 'A test agent',
      systemPrompt: 'You are a test agent.',
      model: createMockConfig(LLMProvider.GEMINI, 'gemini-2.0-flash'),
      tools: [],
      maxIterations: 5,
    });

    const agents = orchestrator.listAgents();
    expect(agents.length).toBe(1);
    expect(agents[0].id).toBe('test-agent');
  });

  it('should throw for unregistered agent', async () => {
    const { AgentOrchestrator } = await import('../agents/AgentOrchestrator');
    const orchestrator = new AgentOrchestrator();

    await expect(
      orchestrator.execute('nonexistent', 'Hello')
    ).rejects.toThrow('Agent not found');
  });

  it('should clear sessions', async () => {
    const { AgentOrchestrator } = await import('../agents/AgentOrchestrator');
    const orchestrator = new AgentOrchestrator();

    orchestrator.registerAgent({
      id: 'test-agent',
      name: 'Test Agent',
      description: 'A test agent',
      systemPrompt: 'You are a test agent.',
      model: createMockConfig(LLMProvider.GEMINI, 'gemini-2.0-flash'),
      tools: [],
      maxIterations: 5,
    });

    const result = await orchestrator.execute('test-agent', 'Hello', 'session-1');
    expect(result.sessionId).toBe('session-1');

    orchestrator.clearSession('session-1');
    // Session should be cleared
  });
});

// ─── Provider Adapter Tests ──────────────────────────────────────────────────

describe('Provider Adapters', () => {
  it('should estimate tokens', async () => {
    const { GeminiLLMAdapter } = await import('../adapters/GeminiAdapter');
    const { OpenAILLMAdapter } = await import('../adapters/OpenAIAdapter');
    const { AnthropicLLMAdapter } = await import('../adapters/AnthropicAdapter');
    const { OllamaLLMAdapter } = await import('../adapters/OllamaAdapter');

    const text = 'Hello, world! This is a test.';
    const gemini = new GeminiLLMAdapter();
    const openai = new OpenAILLMAdapter();
    const anthropic = new AnthropicLLMAdapter();
    const ollama = new OllamaLLMAdapter();

    expect(gemini.estimateTokens(text)).toBeGreaterThan(0);
    expect(openai.estimateTokens(text)).toBeGreaterThan(0);
    expect(anthropic.estimateTokens(text)).toBeGreaterThan(0);
    expect(ollama.estimateTokens(text)).toBeGreaterThan(0);
  });

  it('should have correct provider names', async () => {
    const { GeminiLLMAdapter } = await import('../adapters/GeminiAdapter');
    const { OpenAILLMAdapter } = await import('../adapters/OpenAIAdapter');
    const { AnthropicLLMAdapter } = await import('../adapters/AnthropicAdapter');
    const { OllamaLLMAdapter } = await import('../adapters/OllamaAdapter');

    expect(new GeminiLLMAdapter().provider).toBe('gemini');
    expect(new OpenAILLMAdapter().provider).toBe('openai');
    expect(new AnthropicLLMAdapter().provider).toBe('anthropic');
    expect(new OllamaLLMAdapter().provider).toBe('ollama');
  });
});