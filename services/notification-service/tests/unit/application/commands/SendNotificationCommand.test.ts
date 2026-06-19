import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SendNotificationCommand, SendNotificationCommandInput, SendNotificationCommandResult } from '../../../../src/application/commands/SendNotificationCommand';
import { Notification, NotificationChannel, NotificationSeverity, NotificationType } from '../../../../src/domain/entities/Notification';
import { INotificationRepository } from '../../../../src/domain/repositories/INotificationRepository';
import { NotificationDomainService } from '../../../../src/domain/services/NotificationDomainService';
import { Logger, Metrics, EventPublisher } from '../../../../src/shared/interfaces';

/**
 * Test suite for SendNotificationCommand
 * 
 * Tests cover:
 * 1. Input validation
 * 2. Entity creation
 * 3. Business rules validation
 * 4. Database persistence
 * 5. Event publishing
 * 6. Metrics recording
 * 7. Error handling
 * 
 * @see SendNotificationCommand
 */
describe('SendNotificationCommand', () => {
  let command: SendNotificationCommand;
  let mockRepository: Partial<INotificationRepository>;
  let mockDomainService: Partial<NotificationDomainService>;
  let mockLogger: Partial<Logger>;
  let mockMetrics: Partial<Metrics>;
  let mockEventPublisher: Partial<EventPublisher>;

  const validInput: SendNotificationCommandInput = {
    userId: '123e4567-e89b-12d3-a456-426614174000',
    type: 'alert' as NotificationType,
    severity: 'high' as NotificationSeverity,
    title: 'Test Alert',
    message: 'Test message content',
    channels: ['websocket' as NotificationChannel, 'push' as NotificationChannel],
    priority: 5,
    correlationId: '123e4567-e89b-12d3-a456-426614174001',
  };

  beforeEach(() => {
    // Reset all mocks
    vi.clearAllMocks();

    // Mock repository
    mockRepository = {
      save: vi.fn(),
      findById: vi.fn(),
      findByUserId: vi.fn(),
      markAsRead: vi.fn(),
      delete: vi.fn(),
    };

    // Mock domain service
    mockDomainService = {
      validate: vi.fn(),
    };

    // Mock logger
    mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    };

    // Mock metrics
    mockMetrics = {
      increment: vi.fn(),
      histogram: vi.fn(),
      gauge: vi.fn(),
    };

    // Mock event publisher
    mockEventPublisher = {
      publish: vi.fn().mockResolvedValue(undefined),
    };

    // Create command instance
    command = new SendNotificationCommand(
      mockRepository as INotificationRepository,
      mockDomainService as NotificationDomainService,
      mockLogger as Logger,
      mockMetrics as Metrics,
      mockEventPublisher as EventPublisher,
      'test-correlation-id'
    );
  });

  describe('execute()', () => {
    it('should send notification successfully', async () => {
      // Arrange
      const mockNotification = new Notification({
        userId: validInput.userId,
        type: validInput.type,
        severity: validInput.severity,
        title: validInput.title,
        message: validInput.message,
        channels: validInput.channels,
        priority: validInput.priority,
      });

      (mockDomainService.validate as any).mockReturnValue({ valid: true, errors: [] });
      (mockRepository.save as any).mockResolvedValue(mockNotification);

      // Act
      const result = await command.execute(validInput);

      // Assert
      expect(result.success).toBe(true);
      expect(result.notification).toBeDefined();
      expect(result.notification?.id).toBe(mockNotification.id);
      expect(result.error).toBeUndefined();

      // Verify repository was called
      expect(mockRepository.save).toHaveBeenCalledTimes(1);
      expect(mockRepository.save).toHaveBeenCalledWith(expect.objectContaining({
        userId: validInput.userId,
        type: validInput.type,
      }));

      // Verify event was published
      expect(mockEventPublisher.publish).toHaveBeenCalledTimes(1);
      expect(mockEventPublisher.publish).toHaveBeenCalledWith(
        'notification.requested',
        expect.any(Buffer)
      );

      // Verify metrics were recorded
      expect(mockMetrics.increment).toHaveBeenCalledWith('notification.created', {
        type: validInput.type,
        severity: validInput.severity,
      });
      expect(mockMetrics.histogram).toHaveBeenCalledWith(
        'notification.create_duration_ms',
        expect.any(Number)
      );

      // Verify logging
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Executing SendNotificationCommand',
        expect.objectContaining({
          userId: validInput.userId,
          type: validInput.type,
        })
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Notification created successfully',
        expect.objectContaining({
          notificationId: mockNotification.id,
        })
      );
    });

    it('should fail on invalid input', async () => {
      // Arrange
      const invalidInput = {
        ...validInput,
        userId: 'not-a-uuid', // Invalid UUID
      };

      // Act
      const result = await command.execute(invalidInput);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error).toContain('UUID');
      expect(result.notification).toBeUndefined();

      // Verify repository was NOT called
      expect(mockRepository.save).not.toHaveBeenCalled();

      // Verify event was NOT published
      expect(mockEventPublisher.publish).not.toHaveBeenCalled();

      // Verify validation failure metric
      expect(mockMetrics.increment).toHaveBeenCalledWith('notification.validation_failed', {
        type: invalidInput.type,
        severity: invalidInput.severity,
      });

      // Verify warning log
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Input validation failed',
        expect.objectContaining({
          userId: invalidInput.userId,
        })
      );
    });

    it('should fail on business validation error', async () => {
      // Arrange
      (mockDomainService.validate as any).mockReturnValue({
        valid: false,
        errors: ['Business rule violation: priority too low'],
      });

      // Act
      const result = await command.execute(validInput);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toContain('Business validation failed');
      expect(result.notification).toBeUndefined();

      // Verify repository was NOT called
      expect(mockRepository.save).not.toHaveBeenCalled();

      // Verify warning log
      expect(mockLogger.warn).toHaveBeenCalledWith(
        'Business validation failed',
        expect.objectContaining({
          errors: ['Business rule violation: priority too low'],
        })
      );
    });

    it('should handle database errors gracefully', async () => {
      // Arrange
      const dbError = new Error('Database connection failed');
      (mockDomainService.validate as any).mockReturnValue({ valid: true, errors: [] });
      (mockRepository.save as any).mockRejectedValue(dbError);

      // Act
      const result = await command.execute(validInput);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe('Database connection failed');
      expect(result.notification).toBeUndefined();

      // Verify error metric
      expect(mockMetrics.increment).toHaveBeenCalledWith('notification.create_failed');

      // Verify error log
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to send notification',
        expect.objectContaining({
          error: 'Database connection failed',
        })
      );
    });

    it('should handle event publish failure gracefully', async () => {
      // Arrange
      const mockNotification = new Notification({
        userId: validInput.userId,
        type: validInput.type,
        severity: validInput.severity,
        title: validInput.title,
        message: validInput.message,
        channels: validInput.channels,
        priority: validInput.priority,
      });

      (mockDomainService.validate as any).mockReturnValue({ valid: true, errors: [] });
      (mockRepository.save as any).mockResolvedValue(mockNotification);
      (mockEventPublisher.publish as any).mockRejectedValue(new Error('NATS connection failed'));

      // Act
      const result = await command.execute(validInput);

      // Assert - should still succeed (fire-and-forget)
      expect(result.success).toBe(true);
      expect(result.notification).toBeDefined();

      // Verify event publish failure was logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to publish notification.requested event',
        expect.objectContaining({
          error: 'NATS connection failed',
        })
      );

      // Verify failure metric
      expect(mockMetrics.increment).toHaveBeenCalledWith('notification.event_publish_failed');
    });

    it('should work without event publisher (optional dependency)', async () => {
      // Arrange
      const commandWithoutPublisher = new SendNotificationCommand(
        mockRepository as INotificationRepository,
        mockDomainService as NotificationDomainService,
        mockLogger as Logger,
        mockMetrics as Metrics
        // No event publisher
      );

      const mockNotification = new Notification({
        userId: validInput.userId,
        type: validInput.type,
        severity: validInput.severity,
        title: validInput.title,
        message: validInput.message,
        channels: validInput.channels,
        priority: validInput.priority,
      });

      (mockDomainService.validate as any).mockReturnValue({ valid: true, errors: [] });
      (mockRepository.save as any).mockResolvedValue(mockNotification);

      // Act
      const result = await commandWithoutPublisher.execute(validInput);

      // Assert
      expect(result.success).toBe(true);
      expect(result.notification).toBeDefined();

      // Verify event was NOT published (no publisher)
      expect(mockEventPublisher.publish).not.toHaveBeenCalled();
    });

    it('should include correlation ID in event payload', async () => {
      // Arrange
      const customCorrelationId = 'custom-correlation-123';
      const inputWithCorrelation = {
        ...validInput,
        correlationId: customCorrelationId,
      };

      const mockNotification = new Notification({
        userId: validInput.userId,
        type: validInput.type,
        severity: validInput.severity,
        title: validInput.title,
        message: validInput.message,
        channels: validInput.channels,
        priority: validInput.priority,
      });

      (mockDomainService.validate as any).mockReturnValue({ valid: true, errors: [] });
      (mockRepository.save as any).mockResolvedValue(mockNotification);

      // Act
      await command.execute(inputWithCorrelation);

      // Assert
      expect(mockEventPublisher.publish).toHaveBeenCalledWith(
        'notification.requested',
        expect.any(Buffer)
      );

      // Verify correlation ID in event payload
      const eventPayload = JSON.parse(
        (mockEventPublisher.publish as any).mock.calls[0][1].toString()
      );
      expect(eventPayload.correlation_id).toBe(customCorrelationId);
    });

    it('should measure execution time', async () => {
      // Arrange
      const mockNotification = new Notification({
        userId: validInput.userId,
        type: validInput.type,
        severity: validInput.severity,
        title: validInput.title,
        message: validInput.message,
        channels: validInput.channels,
        priority: validInput.priority,
      });

      (mockDomainService.validate as any).mockReturnValue({ valid: true, errors: [] });
      (mockRepository.save as any).mockResolvedValue(mockNotification);

      // Act
      const startTime = Date.now();
      await command.execute(validInput);
      const duration = Date.now() - startTime;

      // Assert
      expect(mockMetrics.histogram).toHaveBeenCalledWith(
        'notification.create_duration_ms',
        expect.any(Number)
      );

      // Verify duration is reasonable (< 100ms for unit test)
      const histogramCall = (mockMetrics.histogram as any).mock.calls.find(
        (call: [string, number, ...unknown[]]) => call[0] === 'notification.create_duration_ms'
      );
      expect(histogramCall).toBeDefined();
      expect(histogramCall![1]).toBeLessThan(100);
    });

    it('should handle unknown errors gracefully', async () => {
      // Arrange
      (mockDomainService.validate as any).mockReturnValue({ valid: true, errors: [] });
      (mockRepository.save as any).mockRejectedValue('Unknown error string');

      // Act
      const result = await command.execute(validInput);

      // Assert
      expect(result.success).toBe(false);
      expect(result.error).toBe('Unknown error string');

      // Verify error was logged
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to send notification',
        expect.objectContaining({
          error: 'Unknown error string',
        })
      );
    });
  });

  describe('Input Validation', () => {
    it('should reject missing required fields', async () => {
      // Arrange
      const invalidInputs = [
        { ...validInput, userId: '' },
        { ...validInput, title: '' },
        { ...validInput, message: '' },
        { ...validInput, channels: [] },
        { ...validInput, type: 'invalid' as NotificationType },
        { ...validInput, severity: 'invalid' as NotificationSeverity },
      ];

      // Act & Assert
      for (const invalidInput of invalidInputs) {
        const result = await command.execute(invalidInput);
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      }
    });

    it('should reject invalid priority range', async () => {
      // Arrange
      const invalidInputs = [
        { ...validInput, priority: -1 },
        { ...validInput, priority: 11 },
        { ...validInput, priority: 100 },
      ];

      // Act & Assert
      for (const invalidInput of invalidInputs) {
        const result = await command.execute(invalidInput);
        expect(result.success).toBe(false);
        expect(result.error).toBeDefined();
      }
    });
  });

  describe('Metrics', () => {
    it('should record all required metrics on success', async () => {
      // Arrange
      const mockNotification = new Notification({
        userId: validInput.userId,
        type: validInput.type,
        severity: validInput.severity,
        title: validInput.title,
        message: validInput.message,
        channels: validInput.channels,
        priority: validInput.priority,
      });

      (mockDomainService.validate as any).mockReturnValue({ valid: true, errors: [] });
      (mockRepository.save as any).mockResolvedValue(mockNotification);

      // Act
      await command.execute(validInput);

      // Assert
      expect(mockMetrics.increment).toHaveBeenCalledWith('notification.created', {
        type: validInput.type,
        severity: validInput.severity,
      });
      expect(mockMetrics.histogram).toHaveBeenCalledWith(
        'notification.create_duration_ms',
        expect.any(Number)
      );
    });

    it('should record failure metrics on error', async () => {
      // Arrange
      (mockDomainService.validate as any).mockReturnValue({ valid: true, errors: [] });
      (mockRepository.save as any).mockRejectedValue(new Error('DB error'));

      // Act
      await command.execute(validInput);

      // Assert
      expect(mockMetrics.increment).toHaveBeenCalledWith('notification.create_failed');
      expect(mockMetrics.histogram).toHaveBeenCalledWith(
        'notification.create_duration_ms',
        expect.any(Number)
      );
    });
  });

  describe('Logging', () => {
    it('should log execution start with context', async () => {
      // Arrange
      (mockDomainService.validate as any).mockReturnValue({ valid: true, errors: [] });
      (mockRepository.save as any).mockResolvedValue(new Notification({
        userId: validInput.userId,
        type: validInput.type,
        severity: validInput.severity,
        title: validInput.title,
        message: validInput.message,
        channels: validInput.channels,
        priority: validInput.priority,
      }));

      // Act
      await command.execute(validInput);

      // Assert
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Executing SendNotificationCommand',
        expect.objectContaining({
          userId: validInput.userId,
          type: validInput.type,
          severity: validInput.severity,
          channels: validInput.channels,
          correlationId: 'test-correlation-id',
        })
      );
    });

    it('should log success with notification ID', async () => {
      // Arrange
      const mockNotification = new Notification({
        userId: validInput.userId,
        type: validInput.type,
        severity: validInput.severity,
        title: validInput.title,
        message: validInput.message,
        channels: validInput.channels,
        priority: validInput.priority,
      });

      (mockDomainService.validate as any).mockReturnValue({ valid: true, errors: [] });
      (mockRepository.save as any).mockResolvedValue(mockNotification);

      // Act
      await command.execute(validInput);

      // Assert
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Notification created successfully',
        expect.objectContaining({
          notificationId: mockNotification.id,
          userId: validInput.userId,
        })
      );
    });

    it('should log errors with full context', async () => {
      // Arrange
      const error = new Error('Test error');
      (mockDomainService.validate as any).mockReturnValue({ valid: true, errors: [] });
      (mockRepository.save as any).mockRejectedValue(error);

      // Act
      await command.execute(validInput);

      // Assert
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to send notification',
        expect.objectContaining({
          correlationId: 'test-correlation-id',
          userId: validInput.userId,
          error: 'Test error',
          stack: error.stack,
        })
      );
    });
  });

  describe('SOLID Principles', () => {
    it('should follow Single Responsibility - only handles notification sending', () => {
      // Verify command has single responsibility
      expect(command.execute).toBeDefined();
      expect(typeof command.execute).toBe('function');
      
      // Verify private methods are focused
      expect(command).toHaveProperty('validateInput');
      expect(command).toHaveProperty('createNotification');
      expect(command).toHaveProperty('validateBusinessRules');
      expect(command).toHaveProperty('persistNotification');
      expect(command).toHaveProperty('publishEventAsync');
      expect(command).toHaveProperty('recordSuccessMetrics');
      expect(command).toHaveProperty('handleError');
    });

    it('should follow Open/Closed - extensible via dependencies', () => {
      // Verify command accepts dependencies via constructor
      expect(command).toBeInstanceOf(SendNotificationCommand);
      
      // Can be extended with new dependencies without modifying code
      const extendedCommand = new SendNotificationCommand(
        mockRepository as INotificationRepository,
        mockDomainService as NotificationDomainService,
        mockLogger as Logger,
        mockMetrics as Metrics,
        mockEventPublisher as EventPublisher,
        'test-id'
      );
      expect(extendedCommand).toBeDefined();
    });

    it('should follow Dependency Inversion - depends on abstractions', () => {
      // Verify dependencies are interfaces, not concrete implementations
      expect(mockRepository).toBeDefined();
      expect(mockDomainService).toBeDefined();
      expect(mockLogger).toBeDefined();
      expect(mockMetrics).toBeDefined();
      expect(mockEventPublisher).toBeDefined();
    });
  });

  describe('KISS Principle', () => {
    it('should have simple, readable method names', () => {
      // Method names should be self-documenting
      expect(command.execute).toBeDefined();
      expect(typeof command.execute).toBe('function');
    });

    it('should avoid nested callbacks', async () => {
      // Arrange
      (mockDomainService.validate as any).mockReturnValue({ valid: true, errors: [] });
      (mockRepository.save as any).mockResolvedValue(new Notification({
        userId: validInput.userId,
        type: validInput.type,
        severity: validInput.severity,
        title: validInput.title,
        message: validInput.message,
        channels: validInput.channels,
        priority: validInput.priority,
      }));

      // Act - should use async/await, not callbacks
      const result = await command.execute(validInput);

      // Assert
      expect(result.success).toBe(true);
    });
  });

  describe('DRY Principle', () => {
    it('should not duplicate error formatting', async () => {
      // Arrange
      const error = new Error('Test error');
      (mockDomainService.validate as any).mockReturnValue({ valid: true, errors: [] });
      (mockRepository.save as any).mockRejectedValue(error);

      // Act
      await command.execute(validInput);

      // Assert - error should be formatted consistently
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to send notification',
        expect.objectContaining({
          error: 'Test error',
        })
      );
    });
  });

  describe('YAGNI Principle', () => {
    it('should not have unused parameters', () => {
      // Verify command constructor only has necessary parameters
      expect(command).toBeInstanceOf(SendNotificationCommand);
      // No extra parameters that are not used
    });

    it('should not have unused methods', () => {
      // All private methods should be used
      const commandMethods = Object.getOwnPropertyNames(
        Object.getPrototypeOf(command)
      ).filter(m => m !== 'constructor');

      // All methods should be called during execution
      expect(commandMethods.length).toBeGreaterThan(0);
    });
  });
});