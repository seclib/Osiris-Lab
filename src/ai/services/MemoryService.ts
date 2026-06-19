/**
 * OSIRIS AI Engine — Memory Service
 * 
 * Gestion de la mémoire pour les agents IA:
 * - Short-term memory: conversation récente (in-memory, TTL)
 * - Long-term memory: stockage persistant avec embeddings vectoriels
 * - Semantic search: retrieval par similarité cosinus
 * - Memory consolidation: résumé et compression automatique
 * 
 * Architecture:
 * MemoryService
 * ├── ShortTermMemory (in-memory, TTL, LRU eviction)
 * ├── LongTermMemory (vector store, embeddings, persistence)
 * └── MemoryConsolidator (summarization, compression, pruning)
 */

import type { MemoryEntry } from '../engine/types';
import { LLMProvider } from '../engine/types';
import type { EmbeddingProviderAdapter } from '../adapters/interfaces';

/**
 * Memory type
 */
export type MemoryType = 'short_term' | 'long_term' | 'episodic' | 'semantic';

/**
 * Memory search options
 */
export interface MemorySearchOptions {
  query?: string;
  type?: MemoryType;
  sessionId?: string;
  agentId?: string;
  limit?: number;
  minScore?: number;
  startTime?: number;
  endTime?: number;
}

/**
 * Memory consolidation result
 */
export interface ConsolidationResult {
  summary: string;
  entriesConsolidated: number;
  tokensSaved: number;
  timestamp: number;
}

/**
 * Memory statistics
 */
export interface MemoryStats {
  shortTermCount: number;
  longTermCount: number;
  totalTokens: number;
  oldestEntry: number;
  newestEntry: number;
  avgRelevanceScore: number;
}

/**
 * Short-term memory entry (in-memory)
 */
interface ShortTermEntry {
  entry: MemoryEntry;
  expiresAt: number;
  accessCount: number;
  lastAccessed: number;
}

/**
 * Long-term memory entry (with embedding)
 */
interface LongTermEntry {
  entry: MemoryEntry;
  embedding: number[];
  score: number;
  consolidated: boolean;
}

/**
 * Default embedding model config
 */
function getEmbeddingModelConfig(provider: string, dimensions: number) {
  return {
    provider: provider as unknown as LLMProvider,
    modelId: 'default',
    dimensions,
  };
}

/**
 * Memory Service
 */
export class MemoryService {
  private shortTerm: Map<string, ShortTermEntry> = new Map();
  private longTerm: Map<string, LongTermEntry> = new Map();
  private embeddingProvider: EmbeddingProviderAdapter | null = null;

  // Configuration
  private shortTermTTL: number = 30 * 60 * 1000; // 30 minutes
  private shortTermMaxEntries: number = 100;
  private longTermMaxEntries: number = 10000;
  private consolidationThreshold: number = 20;
  private minRelevanceScore: number = 0.6;

  // Stats
  private stats: MemoryStats = {
    shortTermCount: 0,
    longTermCount: 0,
    totalTokens: 0,
    oldestEntry: Date.now(),
    newestEntry: Date.now(),
    avgRelevanceScore: 0,
  };

  constructor(embeddingProvider?: EmbeddingProviderAdapter) {
    this.embeddingProvider = embeddingProvider || null;
  }

  /**
   * Set the embedding provider
   */
  setEmbeddingProvider(provider: EmbeddingProviderAdapter): void {
    this.embeddingProvider = provider;
  }

  /**
   * Store a memory entry
   */
  async remember(
    content: string,
    metadata: Record<string, unknown> = {},
    type: MemoryType = 'short_term',
    ttl?: number
  ): Promise<MemoryEntry> {
    const entry: MemoryEntry = {
      id: this.generateId(),
      content,
      metadata: {
        ...metadata,
        type,
        storedAt: Date.now(),
      },
      timestamp: Date.now(),
      ttl: ttl || (type === 'short_term' ? this.shortTermTTL : undefined),
    };

    if (type === 'short_term') {
      await this.storeShortTerm(entry);
    } else {
      await this.storeLongTerm(entry);
    }

    this.updateStats();
    return entry;
  }

  /**
   * Recall memories matching criteria
   */
  async recall(options: MemorySearchOptions): Promise<MemoryEntry[]> {
    const results: MemoryEntry[] = [];

    // Search short-term memory
    if (!options.type || options.type === 'short_term') {
      const shortResults = this.searchShortTerm(options);
      results.push(...shortResults);
    }

    // Search long-term memory
    if ((!options.type || options.type === 'long_term') && options.query) {
      const longResults = await this.searchLongTerm(options);
      results.push(...longResults);
    }

    // Sort by timestamp descending
    results.sort((a, b) => b.timestamp - a.timestamp);

    return results.slice(0, options.limit || 50);
  }

  /**
   * Forget specific memories
   */
  async forget(id: string): Promise<boolean> {
    const shortDeleted = this.shortTerm.delete(id);
    const longDeleted = this.longTerm.delete(id);
    this.updateStats();
    return shortDeleted || longDeleted;
  }

  /**
   * Clear all memories
   */
  async clear(type?: MemoryType): Promise<void> {
    if (!type || type === 'short_term') {
      this.shortTerm.clear();
    }
    if (!type || type === 'long_term') {
      this.longTerm.clear();
    }
    this.updateStats();
  }

  /**
   * Consolidate short-term memories into long-term
   */
  async consolidate(): Promise<ConsolidationResult> {
    const shortEntries = Array.from(this.shortTerm.values())
      .filter((e) => !e.entry.metadata.consolidated)
      .map((e) => e.entry);

    if (shortEntries.length < this.consolidationThreshold) {
      return {
        summary: 'Not enough entries for consolidation',
        entriesConsolidated: 0,
        tokensSaved: 0,
        timestamp: Date.now(),
      };
    }

    const summary = this.generateSummary(shortEntries);
    const totalTokens = shortEntries.reduce(
      (sum, e) => sum + Math.ceil(e.content.length / 4),
      0
    );

    const consolidatedEntry: MemoryEntry = {
      id: this.generateId('cons_'),
      content: summary,
      metadata: {
        type: 'long_term',
        consolidated: true,
        sourceCount: shortEntries.length,
        originalTokens: totalTokens,
        storedAt: Date.now(),
      },
      timestamp: Date.now(),
    };

    await this.storeLongTerm(consolidatedEntry);

    for (const entry of shortEntries) {
      entry.metadata.consolidated = true;
    }

    this.updateStats();

    return {
      summary,
      entriesConsolidated: shortEntries.length,
      tokensSaved: totalTokens - Math.ceil(summary.length / 4),
      timestamp: Date.now(),
    };
  }

  /**
   * Get memory statistics
   */
  getStats(): MemoryStats {
    this.updateStats();
    return { ...this.stats };
  }

  /**
   * Store in short-term memory
   */
  private async storeShortTerm(entry: MemoryEntry): Promise<void> {
    if (this.shortTerm.size >= this.shortTermMaxEntries) {
      const oldest = Array.from(this.shortTerm.entries())
        .sort(([, a], [, b]) => a.entry.timestamp - b.entry.timestamp)[0];
      if (oldest) {
        this.shortTerm.delete(oldest[0]);
      }
    }

    this.shortTerm.set(entry.id, {
      entry,
      expiresAt: Date.now() + (entry.ttl || this.shortTermTTL),
      accessCount: 0,
      lastAccessed: Date.now(),
    });
  }

  /**
   * Store in long-term memory
   */
  private async storeLongTerm(entry: MemoryEntry): Promise<void> {
    let embedding: number[] = [];

    if (this.embeddingProvider) {
      try {
        const modelConfig = getEmbeddingModelConfig(
          this.embeddingProvider.provider,
          this.embeddingProvider.getDimensions()
        );
        const embedResult = await this.embeddingProvider.embed({
          input: entry.content,
          model: modelConfig,
        });
        embedding = embedResult.embeddings[0];
      } catch {
        // Continue without embedding
      }
    }

    if (this.longTerm.size >= this.longTermMaxEntries) {
      const oldest = Array.from(this.longTerm.entries())
        .sort(([, a], [, b]) => a.entry.timestamp - b.entry.timestamp)[0];
      if (oldest) {
        this.longTerm.delete(oldest[0]);
      }
    }

    this.longTerm.set(entry.id, {
      entry,
      embedding,
      score: 1.0,
      consolidated: false,
    });
  }

  /**
   * Search short-term memory
   */
  private searchShortTerm(options: MemorySearchOptions): MemoryEntry[] {
    const now = Date.now();
    const results: MemoryEntry[] = [];

    for (const [, stored] of this.shortTerm) {
      if (stored.expiresAt < now) {
        this.shortTerm.delete(stored.entry.id);
        continue;
      }

      const entry = stored.entry;

      if (options.sessionId && entry.metadata.sessionId !== options.sessionId) continue;
      if (options.agentId && entry.metadata.agentId !== options.agentId) continue;
      if (options.startTime && entry.timestamp < options.startTime) continue;
      if (options.endTime && entry.timestamp > options.endTime) continue;

      if (options.query) {
        const query = options.query.toLowerCase();
        const content = entry.content.toLowerCase();
        if (!content.includes(query)) continue;
      }

      stored.accessCount++;
      stored.lastAccessed = now;
      results.push(entry);
    }

    return results;
  }

  /**
   * Search long-term memory using embeddings
   */
  private async searchLongTerm(options: MemorySearchOptions): Promise<MemoryEntry[]> {
    if (!options.query) return [];

    const queryEmbedding = await this.generateQueryEmbedding(options.query);
    if (!queryEmbedding) return [];

    const scored: Array<{ entry: MemoryEntry; score: number }> = [];

    for (const [, stored] of this.longTerm) {
      if (stored.embedding.length === 0) continue;

      const score = this.cosineSimilarity(queryEmbedding, stored.embedding);
      if (score < (options.minScore || this.minRelevanceScore)) continue;

      const entry = stored.entry;
      if (options.sessionId && entry.metadata.sessionId !== options.sessionId) continue;
      if (options.agentId && entry.metadata.agentId !== options.agentId) continue;
      if (options.startTime && entry.timestamp < options.startTime) continue;
      if (options.endTime && entry.timestamp > options.endTime) continue;

      scored.push({ entry, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, options.limit || 50).map((s) => s.entry);
  }

  /**
   * Generate query embedding
   */
  private async generateQueryEmbedding(query: string): Promise<number[] | null> {
    if (!this.embeddingProvider) return null;

    try {
      const modelConfig = getEmbeddingModelConfig(
        this.embeddingProvider.provider,
        this.embeddingProvider.getDimensions()
      );
      const result = await this.embeddingProvider.embed({
        input: query,
        model: modelConfig,
      });
      return result.embeddings[0];
    } catch {
      return null;
    }
  }

  /**
   * Cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    const magnitude = Math.sqrt(normA) * Math.sqrt(normB);
    return magnitude === 0 ? 0 : dotProduct / magnitude;
  }

  /**
   * Generate a summary from multiple entries
   */
  private generateSummary(entries: MemoryEntry[]): string {
    if (entries.length === 0) return '';

    const summaries = entries.map((e) => {
      const firstSentence = e.content.split(/[.!?]/)[0];
      return firstSentence.length > 100
        ? firstSentence.substring(0, 100) + '...'
        : firstSentence;
    });

    return `[Consolidated Memory — ${entries.length} entries]\n${summaries.join('\n')}`;
  }

  /**
   * Update statistics
   */
  private updateStats(): void {
    const now = Date.now();

    for (const [id, stored] of this.shortTerm) {
      if (stored.expiresAt < now) {
        this.shortTerm.delete(id);
      }
    }

    const allEntries = [
      ...Array.from(this.shortTerm.values()).map((e) => e.entry),
      ...Array.from(this.longTerm.values()).map((e) => e.entry),
    ];

    this.stats = {
      shortTermCount: this.shortTerm.size,
      longTermCount: this.longTerm.size,
      totalTokens: allEntries.reduce((sum, e) => sum + Math.ceil(e.content.length / 4), 0),
      oldestEntry: allEntries.length > 0
        ? Math.min(...allEntries.map((e) => e.timestamp))
        : now,
      newestEntry: allEntries.length > 0
        ? Math.max(...allEntries.map((e) => e.timestamp))
        : now,
      avgRelevanceScore: this.longTerm.size > 0
        ? Array.from(this.longTerm.values()).reduce((sum, e) => sum + e.score, 0) / this.longTerm.size
        : 0,
    };
  }

  /**
   * Generate a unique ID
   */
  private generateId(prefix: string = 'mem_'): string {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).substring(2, 10);
    return `${prefix}${timestamp}_${random}`;
  }
}