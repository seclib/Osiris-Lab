import { INotificationRepository } from '../../domain/repositories/INotificationRepository';
import { Logger } from '../../application/commands/SendNotificationCommand';

export interface MarkNotificationReadCommandInput {
  notificationId: string;
  userId: string;
}

export interface MarkNotificationReadCommandResult {
  success: boolean;
  notification?: {
    id: string;
    read: boolean;
    readAt: string;
  };
  error?: string;
}

export class MarkNotificationReadCommand {
  constructor(
    private notificationRepository: INotificationRepository,
    private logger: Logger
  ) {}

  async execute(input: MarkNotificationReadCommandInput): Promise<MarkNotificationReadCommandResult> {
    this.logger.info('Executing MarkNotificationReadCommand', {
      notificationId: input.notificationId,
      userId: input.userId,
    });

    try {
      // Find notification
      const notification = await this.notificationRepository.findById(input.notificationId);
      
      if (!notification) {
        this.logger.warn('Notification not found', { notificationId: input.notificationId });
        return {
          success: false,
          error: 'Notification not found',
        };
      }

      // Verify ownership
      if (notification.userId !== input.userId) {
        this.logger.warn('Unauthorized access attempt', {
          notificationId: input.notificationId,
          userId: input.userId,
        });
        return {
          success: false,
          error: 'Unauthorized',
        };
      }

      // Mark as read
      notification.markAsRead();
      const updatedNotification = await this.notificationRepository.save(notification);

      this.logger.info('Notification marked as read', {
        notificationId: input.notificationId,
      });

      return {
        success: true,
        notification: {
          id: updatedNotification.id,
          read: updatedNotification.read,
          readAt: updatedNotification.readAt!.toISOString(),
        },
      };
    } catch (error) {
      this.logger.error('Failed to mark notification as read', {
        error: error instanceof Error ? error.message : 'Unknown error',
        notificationId: input.notificationId,
      });

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }
}