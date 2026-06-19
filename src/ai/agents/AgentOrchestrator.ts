/**
 * OSIRIS AI Engine — Agent Orchestrator
 * 
 * Framework d'agents IA avec:
 * - Tool calling (exécution d'outils via le LLM)
 * - Planning (ReAct: Reason + Act)
 * - Reasoning (step-by-step chain of thought)
 * - Memory injection (contexte depuis MemoryService)
 * - Session management
 * 
 * Architecture:
 * AgentOrchestrator
 * ├── registerAgent(config)     → Enregistrer un agent
 * ├── execute(agentId, input)   → Exécuter un agent avec planification
 * ├── runStep(agentId, input)   → Exécution simple (sans planification)
 * └── getResult(agentId)        → Récupérer le résultat
 */

import type {
  AgentConfig,
  AgentContext,
  AgentResult,
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  ToolDefinition,
  MemoryEntry,
} from '../engine/types';
import { AIEngine, getAIEngine } from '../engine/AIEngine';
import { MemoryService } from '../services/MemoryService';

/**
 * Tool execution result
 */
interface ToolExecutionResult {
  toolName: string;
  success: boolean;
  output: unknown;
  durationMs: number;
  error?: string;
}

/**
 * Planning step
 */
interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  toolName?: string;
  toolInput?: Record<string, unknown>;
  result?: unknown;
}

/**
 * Agent session
 */
interface AgentSession {
  agentId: string;
  sessionId: string;
  config: AgentConfig;
  context: AgentContext;
  plan: PlanStep[];
  result?: AgentResult;
  createdAt: number;
  updatedAt: number;
}

/**
 * ReAct prompt template
 */
const REACT_SYSTEM_PROMPT = `You are an AI agent with access to tools. Follow this reasoning structure:

## AVAILABLE TOOLS
{tools_description}

## REASONING FORMAT
You MUST respond with valid JSON in the following format:
{
  "thought": "Your step-by-step reasoning about what to do next",
  "action": "tool_name or 'final'",
  "action_input": { "param": "value" }  // Only if action is a tool
}

## RULES
1. First reason about the user's request
2. If you need information, use a tool
3. If you have enough information, respond with action: "final" and your answer in action_input
4. Always think step by step
5. If a tool fails, try an alternative approach`;

/**
 * Agent Orchestrator
 */
export class AgentOrchestrator {
  private agents: Map<string, AgentConfig> = new Map();
  private sessions: Map<string, AgentSession> = new Map();
  private engine: AIEngine;
  private memoryService?: MemoryService;

  constructor(engine?: AIEngine, memoryService?: MemoryService) {
    this.engine = engine || getAIEngine();
    this.memoryService = memoryService;
  }

  /**
   * Register an agent configuration
   */
  registerAgent(config: AgentConfig): void {
    if (this.agents.has(config.id)) {
      throw new Error(`Agent already registered: ${config.id}`);
    }
    this.agents.set(config.id, config);
  }

  /**
   * Unregister an agent
   */
  unregisterAgent(agentId: string): void {
    this.agents.delete(agentId);
  }

  /**
   * Get registered agent config
   */
  getAgent(agentId: string): AgentConfig | undefined {
    return this.agents.get(agentId);
  }

  /**
   * List registered agents
   */
  listAgents(): AgentConfig[] {
    return Array.from(this.agents.values());
  }

  /**
   * Execute an agent with ReAct planning
   */
  async execute(
    agentId: string,
    input: string,
    sessionId?: string
  ): Promise<AgentResult> {
    const config = this.agents.get(agentId);
    if (!config) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const sid = sessionId || this.generateSessionId();
    const startTime = Date.now();

    // Get or create session
    let session = this.sessions.get(sid);
    if (!session) {
      session = this.createSession(config, sid);
    }

    // Store user input in memory
    if (this.memoryService) {
      await this.memoryService.remember(input, { agentId, sessionId: sid, role: 'user' }, 'short_term');
    }

    // Build context with memory
    const memoryContext = await this.buildMemoryContext(agentId, sid);

    // Add user message
    session.context.messages.push({ role: 'user', content: input });

    // Execute ReAct loop
    const toolsCalled = await this.executeReActLoop(session, memoryContext);

    // Get final response
    const lastMessage = session.context.messages[session.context.messages.length - 1];
    const response = lastMessage?.content || 'No response generated';

    // Build result
    const result: AgentResult = {
      agentId,
      sessionId: sid,
      response,
      tokensUsed: 0, // Track from completion response
      latencyMs: Date.now() - startTime,
      toolsCalled,
    };

    session.result = result;
    session.updatedAt = Date.now();

    // Store result in memory
    if (this.memoryService) {
      await this.memoryService.remember(
        response,
        { agentId, sessionId: sid, role: 'assistant' },
        'short_term'
      );
    }

    return result;
  }

  /**
   * Execute a single step (no planning)
   */
  async runStep(
    agentId: string,
    input: string,
    sessionId?: string
  ): Promise<AgentResult> {
    const config = this.agents.get(agentId);
    if (!config) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const sid = sessionId || this.generateSessionId();
    const startTime = Date.now();

    let session = this.sessions.get(sid);
    if (!session) {
      session = this.createSession(config, sid);
    }

    // Build context with memory
    const memoryContext = await this.buildMemoryContext(agentId, sid);

    // Build prompt with context
    const systemPrompt = memoryContext
      ? `${config.systemPrompt}\n\n## RELEVANT CONTEXT\n${memoryContext}`
      : config.systemPrompt;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...session.context.messages.slice(-10), // Last 10 messages
      { role: 'user', content: input },
    ];

    // Execute completion
    const response = await this.engine.complete({
      messages,
      model: config.model,
    });

    // Store in context
    session.context.messages.push(
      { role: 'user', content: input },
      { role: 'assistant', content: response.content }
    );
    session.updatedAt = Date.now();

    const result: AgentResult = {
      agentId,
      sessionId: sid,
      response: response.content,
      tokensUsed: response.usage.totalTokens,
      latencyMs: Date.now() - startTime,
      toolsCalled: 0,
    };

    session.result = result;
    return result;
  }

  /**
   * Get session result
   */
  getResult(sessionId: string): AgentResult | undefined {
    return this.sessions.get(sessionId)?.result;
  }

  /**
   * Get session context
   */
  getContext(sessionId: string): AgentContext | undefined {
    const session = this.sessions.get(sessionId);
    return session?.context;
  }

  /**
   * Clear session
   */
  clearSession(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /**
   * Clear all sessions
   */
  clearAllSessions(): void {
    this.sessions.clear();
  }

  /**
   * Execute ReAct loop
   */
  private async executeReActLoop(
    session: AgentSession,
    memoryContext: string
  ): Promise<number> {
    let toolsCalled = 0;
    const maxIterations = 10;

    for (let i = 0; i < maxIterations; i++) {
      // Build ReAct prompt
      const toolsDescription = this.buildToolsDescription(session.config.tools);
      const systemPrompt = REACT_SYSTEM_PROMPT.replace('{tools_description}', toolsDescription);

      const memorySection = memoryContext
        ? `\n## RELEVANT CONTEXT FROM MEMORY\n${memoryContext}\n`
        : '';

      const messages: ChatMessage[] = [
        { role: 'system', content: systemPrompt + memorySection },
        ...session.context.messages.slice(-5), // Last 5 for context window
      ];

      // Get LLM reasoning
      const response = await this.engine.complete({
        messages,
        model: session.config.model,
        responseFormat: 'json',
      });

      // Parse response
      let reasoning: { thought: string; action: string; action_input?: Record<string, unknown> };
      try {
        reasoning = JSON.parse(response.content);

        if (!reasoning.action || !reasoning.thought) {
          throw new Error('Invalid ReAct format');
        }
      } catch {
        // If LLM didn't return valid JSON, treat as final response
        session.context.messages.push({ role: 'assistant', content: response.content });
        break;
      }

      // Store reasoning step
      const step: PlanStep = {
        id: `step_${i}`,
        description: reasoning.thought,
        status: 'in_progress',
      };

      // Handle "final" action
      if (reasoning.action === 'final') {
        const finalResponse = typeof reasoning.action_input === 'object'
          ? JSON.stringify(reasoning.action_input)
          : response.content;
        session.context.messages.push({ role: 'assistant', content: finalResponse });
        step.status = 'completed';
        step.result = finalResponse;
        session.plan.push(step);
        break;
      }

      // Execute tool
      const toolResult = await this.executeTool(
        session.config,
        reasoning.action,
        reasoning.action_input || {}
      );
      toolsCalled++;
      step.toolName = reasoning.action;
      step.toolInput = reasoning.action_input;
      step.result = toolResult;
      step.status = toolResult.success ? 'completed' : 'failed';
      session.plan.push(step);

      // Add tool result to context
      const toolMessage = `Tool ${reasoning.action} returned: ${JSON.stringify(toolResult.output)}`;
      session.context.messages.push({ role: 'system', content: `[Tool Result] ${toolMessage}` });

      // If all steps completed, break
      if (i === maxIterations - 1) {
        session.context.messages.push({
          role: 'assistant',
          content: 'I have completed my analysis. Here are my findings based on the available tools and data.',
        });
      }
    }

    return toolsCalled;
  }

  /**
   * Execute a tool
   */
  private async executeTool(
    config: AgentConfig,
    toolName: string,
    input: Record<string, unknown>
  ): Promise<ToolExecutionResult> {
    const startTime = Date.now();
    const tool = config.tools.find((t) => t.name === toolName);

    if (!tool) {
      return {
        toolName,
        success: false,
        output: null,
        durationMs: Date.now() - startTime,
        error: `Tool not found: ${toolName}`,
      };
    }

    try {
      const output = await tool.handler(input);
      return {
        toolName,
        success: true,
        output,
        durationMs: Date.now() - startTime,
      };
    } catch (error) {
      return {
        toolName,
        success: false,
        output: null,
        durationMs: Date.now() - startTime,
        error: error instanceof Error ? error.message : 'Tool execution failed',
      };
    }
  }

  /**
   * Build tools description for ReAct prompt
   */
  private buildToolsDescription(tools: ToolDefinition[]): string {
    if (tools.length === 0) return 'No tools available. Respond directly.';

    return tools
      .map(
        (t) =>
          `- ${t.name}: ${t.description}\n  Parameters: ${JSON.stringify(t.parameters, null, 2)}`
      )
      .join('\n');
  }

  /**
   * Build memory context
   */
  private async buildMemoryContext(
    agentId: string,
    sessionId: string
  ): Promise<string> {
    if (!this.memoryService) return '';

    try {
      const memories = await this.memoryService.recall({
        agentId,
        sessionId,
        limit: 10,
        minScore: 0.7,
      });

      if (memories.length === 0) return '';

      return memories
        .map((m) => `[${new Date(m.timestamp).toISOString()}] ${m.content}`)
        .join('\n');
    } catch {
      return '';
    }
  }

  /**
   * Create a new session
   */
  private createSession(config: AgentConfig, sessionId: string): AgentSession {
    const session: AgentSession = {
      agentId: config.id,
      sessionId,
      config,
      context: {
        agentId: config.id,
        sessionId,
        messages: [{ role: 'system', content: config.systemPrompt }],
        memory: [],
        metadata: {},
      },
      plan: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    this.sessions.set(sessionId, session);
    return session;
  }

  /**
   * Generate session ID
   */
  private generateSessionId(): string {
    return `session_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
  }
}