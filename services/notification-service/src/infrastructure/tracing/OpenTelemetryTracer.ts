import { Logger } from '../../shared/interfaces';

export interface TraceContext {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  serviceName: string;
  operationName: string;
  startTime: Date;
  tags?: Record<string, string>;
  baggage?: Record<string, string>;
}

export interface Span {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  operationName: string;
  startTime: Date;
  endTime?: Date;
  duration?: number;
  tags: Record<string, string>;
  logs: Array<{
    timestamp: Date;
    fields: Record<string, unknown>;
  }>;
  status: SpanStatus;
}

export enum SpanStatus {
  OK = 'OK',
  ERROR = 'ERROR',
  UNSET = 'UNSET',
}

export interface TraceExporter {
  export(spans: Span[]): Promise<void>;
  flush(): Promise<void>;
  shutdown(): Promise<void>;
}

/**
 * OpenTelemetry Distributed Tracing Implementation
 * 
 * Provides distributed tracing for microservices communication
 */
export class OpenTelemetryTracer {
  private serviceName: string;
  private logger: Logger;
  private exporter: TraceExporter;
  private activeSpans: Map<string, Span> = new Map();
  private traceIdCounter: number = 0;
  private spanIdCounter: number = 0;

  constructor(
    serviceName: string,
    exporter: TraceExporter,
    logger: Logger
  ) {
    this.serviceName = serviceName;
    this.logger = logger;
    this.exporter = exporter;
  }

  /**
   * Start a new trace span
   */
  startSpan(operationName: string, parentContext?: Partial<TraceContext>): Span {
    const traceId = parentContext?.traceId || this.generateTraceId();
    const parentSpanId = parentContext?.spanId;
    const spanId = this.generateSpanId();

    const span: Span = {
      traceId,
      spanId,
      parentSpanId,
      operationName,
      startTime: new Date(),
      tags: {
        'service.name': this.serviceName,
        'span.kind': 'server',
        ...parentContext?.tags,
      },
      logs: [],
      status: SpanStatus.UNSET,
    };

    this.activeSpans.set(spanId, span);

    this.logger.debug('Span started', {
      traceId,
      spanId,
      parentSpanId,
      operationName,
    });

    return span;
  }

  /**
   * Start a child span
   */
  startChildSpan(
    parentSpan: Span,
    operationName: string
  ): Span {
    return this.startSpan(operationName, {
      traceId: parentSpan.traceId,
      spanId: parentSpan.spanId,
      tags: parentSpan.tags,
    });
  }

  /**
   * Finish a span
   */
  finishSpan(span: Span, status: SpanStatus = SpanStatus.OK): void {
    const endTime = new Date();
    const duration = endTime.getTime() - span.startTime.getTime();

    span.endTime = endTime;
    span.duration = duration;
    span.status = status;

    this.logger.debug('Span finished', {
      traceId: span.traceId,
      spanId: span.spanId,
      operationName: span.operationName,
      duration,
      status,
    });

    // Export span
    this.exporter.export([span]).catch((error) => {
      this.logger.error('Failed to export span', {
        error: error instanceof Error ? error.message : 'Unknown error',
        traceId: span.traceId,
        spanId: span.spanId,
      });
    });

    // Remove from active spans
    this.activeSpans.delete(span.spanId);
  }

  /**
   * Add tags to span
   */
  addTags(span: Span, tags: Record<string, string>): void {
    Object.assign(span.tags, tags);
  }

  /**
   * Add log to span
   */
  addLog(span: Span, fields: Record<string, unknown>): void {
    span.logs.push({
      timestamp: new Date(),
      fields,
    });
  }

  /**
   * Set error on span
   */
  setError(span: Span, error: Error): void {
    span.status = SpanStatus.ERROR;
    this.addTags(span, {
      'error': 'true',
      'error.message': error.message,
      'error.stack': error.stack || '',
    });
  }

  /**
   * Get trace context for propagation
   */
  getTraceContext(span: Span): TraceContext {
    return {
      traceId: span.traceId,
      spanId: span.spanId,
      parentSpanId: span.parentSpanId,
      serviceName: this.serviceName,
      operationName: span.operationName,
      startTime: span.startTime,
      tags: span.tags,
    };
  }

  /**
   * Extract trace context from headers
   */
  extractTraceContext(headers: Record<string, string>): Partial<TraceContext> | undefined {
    const traceId = headers['x-trace-id'] || headers['traceparent']?.split('-')[1];
    const spanId = headers['x-span-id'] || headers['traceparent']?.split('-')[2];

    if (!traceId || !spanId) {
      return undefined;
    }

    return {
      traceId,
      spanId,
      tags: {
        'http.method': headers[':method'] || headers['method'],
        'http.url': headers[':path'] || headers['path'],
        'http.host': headers[':authority'] || headers['host'],
      },
    };
  }

  /**
   * Inject trace context into headers
   */
  injectTraceContext(span: Span): Record<string, string> {
    return {
      'x-trace-id': span.traceId,
      'x-span-id': span.spanId,
      'x-parent-span-id': span.parentSpanId || '',
      'traceparent': `00-${span.traceId}-${span.spanId}-01`,
    };
  }

  /**
   * Generate unique trace ID
   */
  private generateTraceId(): string {
    this.traceIdCounter++;
    const timestamp = Date.now().toString(16);
    const random = Math.random().toString(16).substring(2, 10);
    const counter = this.traceIdCounter.toString(16).padStart(4, '0');
    return `${timestamp}${counter}${random}`;
  }

  /**
   * Generate unique span ID
   */
  private generateSpanId(): string {
    this.spanIdCounter++;
    const timestamp = Date.now().toString(16);
    const counter = this.spanIdCounter.toString(16).padStart(4, '0');
    return `${timestamp}${counter}`;
  }

  /**
   * Flush all pending spans
   */
  async flush(): Promise<void> {
    this.logger.info('Flushing traces', {
      activeSpans: this.activeSpans.size,
    });

    try {
      await this.exporter.flush();
    } catch (error) {
      this.logger.error('Failed to flush traces', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Shutdown tracer
   */
  async shutdown(): Promise<void> {
    this.logger.info('Shutting down tracer');

    try {
      // Finish all active spans
      this.activeSpans.forEach((span, spanId) => {
        this.finishSpan(span, SpanStatus.ERROR);
      });

      await this.exporter.shutdown();
    } catch (error) {
      this.logger.error('Failed to shutdown tracer', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
    }
  }

  /**
   * Get active spans count
   */
  getActiveSpansCount(): number {
    return this.activeSpans.size;
  }
}

/**
 * Console Trace Exporter (for development)
 */
export class ConsoleTraceExporter implements TraceExporter {
  private logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  async export(spans: Span[]): Promise<void> {
    for (const span of spans) {
      this.logger.info('Trace exported', {
        traceId: span.traceId,
        spanId: span.spanId,
        parentSpanId: span.parentSpanId,
        operationName: span.operationName,
        duration: span.duration,
        status: span.status,
        tags: span.tags,
      });
    }
  }

  async flush(): Promise<void> {
    // No-op for console exporter
  }

  async shutdown(): Promise<void> {
    // No-op for console exporter
  }
}

/**
 * In-Memory Trace Exporter (for testing)
 */
export class InMemoryTraceExporter implements TraceExporter {
  private spans: Span[] = [];

  async export(spans: Span[]): Promise<void> {
    this.spans.push(...spans);
  }

  async flush(): Promise<void> {
    // No-op
  }

  async shutdown(): Promise<void> {
    this.spans = [];
  }

  getSpans(): Span[] {
    return [...this.spans];
  }

  reset(): void {
    this.spans = [];
  }
}