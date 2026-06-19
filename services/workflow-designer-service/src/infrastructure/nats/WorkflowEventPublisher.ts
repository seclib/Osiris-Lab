import { Logger } from '@osiris/logger';
import { Metrics } from '@osiris/metrics';

export interface INATSEventPublisher {
  publish(subject: string, data: unknown): Promise<void>;
}

export class NATSEventPublisher implements INATSEventPublisher {
  constructor(
    private nats: { publish: (subject: string, data: Buffer) => Promise<void> },
    private logger: Logger,
    private metrics: Metrics
  ) {}

  async publish(subject: string, data: unknown): Promise<void> {
    const startTime = Date.now();
    this.metrics.increment('nats.publish.attempts', { subject });

    try {
      const payload = Buffer.from(JSON.stringify({
        id: crypto.randomUUID(),
        type: subject,
        source: 'workflow-designer-service',
        timestamp: new Date().toISOString(),
        version: '1.0.0',
        payload: data,
      }));

      await this.nats.publish(subject, payload);
      
      this.metrics.timing('nats.publish.duration', Date.now() - startTime, { subject });
      this.metrics.increment('nats.publish.success', { subject });
      this.logger.info('Event published', { subject });
    } catch (error) {
      this.metrics.increment('nats.publish.errors', { subject });
      this.logger.error('Failed to publish event', { subject, error: (error as Error).message });
      throw error;
    }
  }
}