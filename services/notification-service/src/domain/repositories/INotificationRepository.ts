import { Notification, NotificationProps } from '../entities/Notification';

export interface INotificationRepository {
  save(notification: Notification): Promise<Notification>;
  findById(id: string): Promise<Notification | null>;
  findByUserId(userId: string, limit?: number, offset?: number): Promise<Notification[]>;
  findUnreadByUserId(userId: string): Promise<Notification[]>;
  countUnreadByUserId(userId: string): Promise<number>;
  markAsRead(id: string): Promise<Notification | null>;
  markAllAsRead(userId: string): Promise<number>;
  delete(id: string): Promise<boolean>;
  deleteOldNotifications(olderThanDays: number): Promise<number>;
}