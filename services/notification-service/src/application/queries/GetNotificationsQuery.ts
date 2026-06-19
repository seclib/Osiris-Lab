import { INotificationRepository } from '../../domain/repositories/INotificationRepository';
import { Logger } from '../commands/SendNotificationCommand';
import { Notification } from '../../domain/entities/Notification';

export interface GetNotificationsQueryInput {
  userId: string;
  limit?: number;
  offset?: number;
  unreadOnly?: boolean;
}

export interface GetNotificationsQueryResult {
  notifications: Notification[];
  total: number;
  unreadCount: number;
}

export class GetNotificationsQuery {
  constructor(
    private notificationRepository: INotificationRepository,
    private logger: Logger
  ) {}

  async execute(input: GetNotificationsQueryInput): Promise<GetNotificationsQueryResult> {
    this.logger.info('Executing GetNotificationsQuery', {
      userId: input.userId,
      unreadOnly: input.unreadOnly,
    });

    try {
      const limit = input.limit || 50;
      const offset = input.offset || 0;

      // Get notifications
      const notifications = input.unreadOnly
        ? await this.notificationRepository.findUnreadByUserId(input.userId)
        : await this.notificationRepository.findByUserId(input.userId, limit, offset);

      // Get unread count
      const unreadCount = await this.notificationRepository.countUnreadByUserId(input.userId);

      this.logger.info('Notifications retrieved', {
        userId: input.userId,
        count: notifications.length,
        unreadCount,
      });

      return {
        notifications,
        total: notifications.length,
        unreadCount,
      };
    } catch (error) {
      this.logger.error('Failed to get notifications', {
        error: error instanceof Error ? error.message : 'Unknown error',
        userId: input.userId,
      });

      return {
        notifications: [],
        total: 0,
        unreadCount: 0,
      };
    }
  }
}