/**
 * OSIRIS AI Engine — RAG Pipeline
 * 
 * Retrieval-Augmented Generation pipeline:
 * - Ingestion: documents → chunks
 * - Chunking: text → overlapping segments
 * - Embedding: chunks → vectors
 * - Retrieval: query → similar chunks
 * - Re-ranking: score → relevance filter
 * - Generation: context + query → answer
 */

import type { RAGDocument, EmbeddingModel, CompletionRequest } from '../engine/types';
import { LLMProvider } from '../engine/types';
import type { EmbeddingProviderAdapter } from '../adapters/interfaces';
import { AIEngine, getAIEngine } from '../engine/AIEngine';

/**
 * Chunking strategy
 */
export type ChunkStrategy = 'fixed' | 'sentence' | 'paragraph' | 'semantic';

/**
 * RAG configuration
 */
export interface RAGConfig {
  chunkSize: number;
  chunkOverlap: number;
  chunkStrategy: ChunkStrategy;
  topK: number;
  minScore: number;
  embeddingModel: EmbeddingModel;
}

/**
 * Chunk metadata
 */
interface DocumentChunk {
  id: string;
  documentId: string;
  content: string;
  index: number;
  embedding?: number[];
  metadata: RAGDocument['metadata'];
}

/**
 * Retrieval result
 */
interface RetrievalResult {
  chunk: DocumentChunk;
  score: number;
}

/**
 * Generation result
 */
export interface RAGResult {
  answer: string;
  sources: Array<{
    documentId: string;
    content: string;
    score: number;
    title?: string;
  }>;
  tokensUsed: number;
  latencyMs: number;
}

/**
 * Default config
 */
const DEFAULT_RAG_CONFIG: RAGConfig = {
  chunkSize: 512,
  chunkOverlap: 64,
  chunkStrategy: 'sentence',
  topK: 5,
  minScore: 0.65,
  embeddingModel: {
    provider: LLMProvider.GEMINI,
    modelId: 'text-embedding-004',
    dimensions: 768,
  },
};

/**
 * RAG Pipeline Service
 */
export class RAGService {
  private config: RAGConfig;
  private chunks: Map<string, DocumentChunk> = new Map();
  private documents: Map<string, RAGDocument> = new Map();
  private engine: AIEngine;
  private embeddingProvider?: EmbeddingProviderAdapter;

  constructor(
    config?: Partial<RAGConfig>,
    engine?: AIEngine,
    embeddingProvider?: EmbeddingProviderAdapter
  ) {
    this.config = { ...DEFAULT_RAG_CONFIG, ...config };
    this.engine = engine || getAIEngine();
    this.embeddingProvider = embeddingProvider;
  }

  /**
   * Set embedding provider
   */
  setEmbeddingProvider(provider: EmbeddingProviderAdapter): void {
    this.embeddingProvider = provider;
  }

  /**
   * Set chunking configuration
   */
  setConfig(config: Partial<RAGConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Ingest a document — chunk, embed, and store
   */
  async ingest(document: RAGDocument): Promise<number> {
    this.documents.set(document.id, document);

    const chunks = this.chunkDocument(document);
    const embeddedChunks = await this.embedChunks(chunks);

    for (const chunk of embeddedChunks) {
      this.chunks.set(chunk.id, chunk);
    }

    return chunks.length;
  }

  /**
   * Ingest multiple documents
   */
  async ingestBatch(documents: RAGDocument[]): Promise<number> {
    let total = 0;
    for (const doc of documents) {
      total += await this.ingest(doc);
    }
    return total;
  }

  /**
   * Remove a document and its chunks
   */
  remove(documentId: string): void {
    this.documents.delete(documentId);
    for (const [id, chunk] of this.chunks) {
      if (chunk.documentId === documentId) {
        this.chunks.delete(id);
      }
    }
  }

  /**
   * Query the RAG pipeline
   */
  async query(query: string, topK?: number): Promise<RAGResult> {
    const startTime = Date.now();
    const k = topK || this.config.topK;

    // 1. Embed query
    const queryEmbedding = await this.embedQuery(query);

    // 2. Retrieve similar chunks
    const retrieved = this.retrieve(queryEmbedding, k);

    // 3. Re-rank
    const reranked = this.rerank(retrieved, query);

    // 4. Build context
    const context = reranked
      .map((r) => `[Source: ${r.chunk.metadata.source}] ${r.chunk.content}`)
      .join('\n\n');

    // 5. Generate answer
    const response = await this.engine.complete({
      messages: [
        {
          role: 'system',
          content: `You are a RAG assistant. Answer based ONLY on the provided context. If the context doesn't contain enough information, say so. Context:\n\n${context}`,
        },
        { role: 'user', content: query },
      ],
      model: {
        provider: this.config.embeddingModel.provider,
        modelId: 'gemini-2.0-flash',
        temperature: 0.3,
      },
    });

    return {
      answer: response.content,
      sources: reranked.map((r) => ({
        documentId: r.chunk.documentId,
        content: r.chunk.content,
        score: r.score,
        title: r.chunk.metadata.title,
      })),
      tokensUsed: response.usage.totalTokens,
      latencyMs: Date.now() - startTime,
    };
  }

  /**
   * Get document count
   */
  stats(): { documents: number; chunks: number } {
    return {
      documents: this.documents.size,
      chunks: this.chunks.size,
    };
  }

  /**
   * Chunk a document based on strategy
   */
  private chunkDocument(document: RAGDocument): DocumentChunk[] {
    switch (this.config.chunkStrategy) {
      case 'fixed':
        return this.chunkFixed(document);
      case 'sentence':
        return this.chunkSentence(document);
      case 'paragraph':
        return this.chunkParagraph(document);
      default:
        return this.chunkFixed(document);
    }
  }

  /**
   * Fixed-size chunking with overlap
   */
  private chunkFixed(document: RAGDocument): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    const text = document.content;
    const size = this.config.chunkSize;
    const overlap = this.config.chunkOverlap;
    let start = 0;
    let index = 0;

    while (start < text.length) {
      const end = Math.min(start + size, text.length);
      chunks.push({
        id: `${document.id}_chunk_${index}`,
        documentId: document.id,
        content: text.slice(start, end),
        index,
        metadata: document.metadata,
      });
      start += size - overlap;
      index++;
    }

    return chunks;
  }

  /**
   * Sentence-based chunking
   */
  private chunkSentence(document: RAGDocument): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    const sentences = document.content.match(/[^.!?]+[.!?]+/g) || [document.content];
    let current = '';
    let index = 0;

    for (const sentence of sentences) {
      if ((current + sentence).length > this.config.chunkSize && current.length > 0) {
        chunks.push({
          id: `${document.id}_chunk_${index}`,
          documentId: document.id,
          content: current.trim(),
          index,
          metadata: document.metadata,
        });
        current = sentence;
        index++;
      } else {
        current += sentence;
      }
    }

    if (current.trim().length > 0) {
      chunks.push({
        id: `${document.id}_chunk_${index}`,
        documentId: document.id,
        content: current.trim(),
        index,
        metadata: document.metadata,
      });
    }

    return chunks;
  }

  /**
   * Paragraph-based chunking
   */
  private chunkParagraph(document: RAGDocument): DocumentChunk[] {
    const chunks: DocumentChunk[] = [];
    const paragraphs = document.content.split(/\n\s*\n/);
    let current = '';
    let index = 0;

    for (const paragraph of paragraphs) {
      if ((current + paragraph).length > this.config.chunkSize && current.length > 0) {
        chunks.push({
          id: `${document.id}_chunk_${index}`,
          documentId: document.id,
          content: current.trim(),
          index,
          metadata: document.metadata,
        });
        current = paragraph;
        index++;
      } else {
        current += (current ? '\n\n' : '') + paragraph;
      }
    }

    if (current.trim().length > 0) {
      chunks.push({
        id: `${document.id}_chunk_${index}`,
        documentId: document.id,
        content: current.trim(),
        index,
        metadata: document.metadata,
      });
    }

    return chunks;
  }

  /**
   * Embed all chunks
   */
  private async embedChunks(chunks: DocumentChunk[]): Promise<DocumentChunk[]> {
    if (!this.embeddingProvider) return chunks;

    const embedded: DocumentChunk[] = [];
    const batchSize = 10;

    for (let i = 0; i < chunks.length; i += batchSize) {
      const batch = chunks.slice(i, i + batchSize);
      const contents = batch.map((c) => c.content);

      try {
        const result = await this.embeddingProvider.embed({
          input: contents,
          model: this.config.embeddingModel,
        });

        for (let j = 0; j < batch.length; j++) {
          batch[j].embedding = result.embeddings[j];
        }
      } catch {
        // Continue without embeddings
      }

      embedded.push(...batch);
    }

    return embedded;
  }

  /**
   * Embed a query string
   */
  private async embedQuery(query: string): Promise<number[] | null> {
    if (!this.embeddingProvider) return null;

    try {
      const result = await this.embeddingProvider.embed({
        input: query,
        model: this.config.embeddingModel,
      });
      return result.embeddings[0];
    } catch {
      return null;
    }
  }

  /**
   * Retrieve top-K chunks by cosine similarity
   */
  private retrieve(queryEmbedding: number[] | null, topK: number): RetrievalResult[] {
    if (!queryEmbedding) return [];

    const scored: RetrievalResult[] = [];

    for (const chunk of this.chunks.values()) {
      if (!chunk.embedding) continue;

      const score = this.cosineSimilarity(queryEmbedding, chunk.embedding);
      if (score < this.config.minScore) continue;

      scored.push({ chunk, score });
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  /**
   * Re-rank results (simple score-based re-ranking)
   */
  private rerank(results: RetrievalResult[], query: string): RetrievalResult[] {
    // Score boost for exact query term matches
    const queryTerms = query.toLowerCase().split(/\s+/);

    return results
      .map((r) => {
        const content = r.chunk.content.toLowerCase();
        const termMatches = queryTerms.filter((t) => content.includes(t)).length;
        const boost = termMatches / queryTerms.length * 0.2; // Max 20% boost
        return { ...r, score: r.score + boost };
      })
      .sort((a, b) => b.score - a.score);
  }

  /**
   * Cosine similarity
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      na += a[i] * a[i];
      nb += b[i] * b[i];
    }
    const mag = Math.sqrt(na) * Math.sqrt(nb);
    return mag === 0 ? 0 : dot / mag;
  }
}