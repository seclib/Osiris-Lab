/**
 * OSIRIS AI Engine — LLM Gateway API Routes
 * 
 * Endpoints REST pour le moteur IA:
 * - POST /api/ai/complete — Génération de texte
 * - POST /api/ai/stream — Génération streaming (SSE)
 * - POST /api/ai/embed — Génération d'embeddings
 * - POST /api/ai/agents/execute — Exécution d'agent
 * - POST /api/ai/rag/query — RAG query
 * - POST /api/ai/rag/ingest — Ingest document
 * 
 * Toutes les routes utilisent getAIEngine() pour l'abstraction provider.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getAIEngine, AIEngine } from '@/ai/engine';
import { AgentOrchestrator } from '@/ai/agents/AgentOrchestrator';
import { RAGService } from '@/ai/rag/RAGService';
import { MemoryService } from '@/ai/services/MemoryService';
import { initializeSecurity, getSecurityMiddleware } from '@/security';

// Initialize security middleware
const security = initializeSecurity();

// Shared instances (singleton pattern)
let engine: AIEngine | null = null;
let agentOrchestrator: AgentOrchestrator | null = null;
let ragService: RAGService | null = null;
let memoryService: MemoryService | null = null;

/**
 * Get or create AI engine instance
 */
function getEngine(): AIEngine {
  if (!engine) {
    engine = getAIEngine();
  }
  return engine;
}

/**
 * Get or create agent orchestrator
 */
function getAgentOrchestrator(): AgentOrchestrator {
  if (!agentOrchestrator) {
    agentOrchestrator = new AgentOrchestrator(getEngine(), getMemoryService());
  }
  return agentOrchestrator;
}

/**
 * Get or create RAG service
 */
function getRAGService(): RAGService {
  if (!ragService) {
    ragService = new RAGService(undefined, getEngine());
  }
  return ragService;
}

/**
 * Get or create memory service
 */
function getMemoryService(): MemoryService {
  if (!memoryService) {
    memoryService = new MemoryService();
  }
  return memoryService;
}

/**
 * Apply security middleware to a request
 */
async function applySecurity(request: NextRequest): Promise<NextResponse | null> {
  const result = await security.apply(request);
  
  if (!result.allowed) {
    return NextResponse.json(
      { error: result.status === 401 ? 'Unauthorized' : 'Forbidden' },
      { status: result.status, headers: result.headers }
    );
  }

  return null;
}

/**
 * POST /api/ai/complete
 * Generate a completion
 */
export async function POST(request: NextRequest) {
  // Apply security
  const securityResponse = await applySecurity(request);
  if (securityResponse) return securityResponse;

  try {
    const body = await request.json();
    const { action, ...params } = body;

    const engine = getEngine();

    switch (action) {
      case 'complete': {
        const { messages, model } = params;
        if (!messages || !Array.isArray(messages)) {
          return NextResponse.json(
            { error: 'messages array is required' },
            { status: 400 }
          );
        }

        const response = await engine.complete({ messages, model });
        return NextResponse.json({
          content: response.content,
          model: response.model,
          usage: response.usage,
          latencyMs: response.latencyMs,
          finishReason: response.finishReason,
        });
      }

      case 'stream': {
        const { messages, model } = params;
        if (!messages || !Array.isArray(messages)) {
          return NextResponse.json(
            { error: 'messages array is required' },
            { status: 400 }
          );
        }

        // Return streaming response
        const stream = new ReadableStream({
          async start(controller) {
            const encoder = new TextEncoder();
            try {
              for await (const chunk of engine.completeStream({ messages, model })) {
                const data = `data: ${JSON.stringify(chunk)}\n\n`;
                controller.enqueue(encoder.encode(data));
              }
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
            } catch (error) {
              controller.enqueue(encoder.encode(`data: ${JSON.stringify({ error: 'Stream error' })}\n\n`));
            } finally {
              controller.close();
            }
          },
        });

        return new Response(stream, {
          headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
          },
        });
      }

      case 'embed': {
        const { input, model } = params;
        if (!input) {
          return NextResponse.json(
            { error: 'input is required' },
            { status: 400 }
          );
        }

        const response = await engine.embed({ input, model });
        return NextResponse.json({
          embeddings: response.embeddings,
          model: response.model,
          usage: response.usage,
          latencyMs: response.latencyMs,
        });
      }

      case 'agent.execute': {
        const { agentId, input, sessionId } = params;
        if (!agentId || !input) {
          return NextResponse.json(
            { error: 'agentId and input are required' },
            { status: 400 }
          );
        }

        const orchestrator = getAgentOrchestrator();
        const result = await orchestrator.execute(agentId, input, sessionId);
        return NextResponse.json(result);
      }

      case 'agent.runStep': {
        const { agentId, input, sessionId } = params;
        if (!agentId || !input) {
          return NextResponse.json(
            { error: 'agentId and input are required' },
            { status: 400 }
          );
        }

        const orchestrator = getAgentOrchestrator();
        const result = await orchestrator.runStep(agentId, input, sessionId);
        return NextResponse.json(result);
      }

      case 'rag.query': {
        const { query, topK } = params;
        if (!query) {
          return NextResponse.json(
            { error: 'query is required' },
            { status: 400 }
          );
        }

        const rag = getRAGService();
        const result = await rag.query(query, topK);
        return NextResponse.json(result);
      }

      case 'rag.ingest': {
        const { document } = params;
        if (!document) {
          return NextResponse.json(
            { error: 'document is required' },
            { status: 400 }
          );
        }

        const rag = getRAGService();
        const chunksCount = await rag.ingest(document);
        return NextResponse.json({
          documentId: document.id,
          chunksCount,
          stats: rag.stats(),
        });
      }

      case 'memory.remember': {
        const { content, metadata, type, ttl } = params;
        if (!content) {
          return NextResponse.json(
            { error: 'content is required' },
            { status: 400 }
          );
        }

        const memory = getMemoryService();
        const entry = await memory.remember(content, metadata, type, ttl);
        return NextResponse.json(entry);
      }

      case 'memory.recall': {
        const { query, type, sessionId, agentId, limit, minScore } = params;
        const memory = getMemoryService();
        const entries = await memory.recall({
          query,
          type,
          sessionId,
          agentId,
          limit,
          minScore,
        });
        return NextResponse.json({ entries, count: entries.length });
      }

      case 'memory.consolidate': {
        const memory = getMemoryService();
        const result = await memory.consolidate();
        return NextResponse.json(result);
      }

      case 'memory.stats': {
        const memory = getMemoryService();
        return NextResponse.json(memory.getStats());
      }

      default:
        return NextResponse.json(
          { error: `Unknown action: ${action}` },
          { status: 400 }
        );
    }
  } catch (error) {
    console.error('[AI API] Error:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal server error' },
      { status: 500 }
    );
  }
}

/**
 * GET /api/ai — Health check and info
 */
export async function GET() {
  try {
    const engine = getEngine();
    const health = await engine.health();
    const stats = engine.getStats();

    return NextResponse.json({
      status: 'ok',
      engine: {
        healthy: health.healthy,
        providers: health.providers,
        defaultModel: health.defaultModel,
      },
      stats: {
        totalRequests: stats.totalRequests,
        totalTokens: stats.totalTokens,
        avgLatencyMs: stats.avgLatencyMs,
        errorRate: stats.errorRate,
      },
      features: {
        agents: true,
        rag: true,
        memory: true,
        streaming: true,
        multiProvider: true,
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'AI Engine not initialized' },
      { status: 503 }
    );
  }
}