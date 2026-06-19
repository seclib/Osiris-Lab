import { Pool } from 'pg';
import { Notification, NotificationChannel, NotificationStatus, NotificationType, NotificationSeverity } from '../../domain/entities/Notification';
import { INotificationRepository } from '../../domain/repositories/INotificationRepository';

export class PostgresNotificationRepository implements INotificationRepository {
  constructor(private db: Pool) {}

  async save(notification: Notification): Promise<Notification> {
    const query = `
      INSERT INTO notifications (
        id, user_id, type, severity, title, message, data, channels,
        priority, status, read, read_at, created_at, updated_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
      ON CONFLICT (id) DO UPDATE SET
        status = EXCLUDED.status,
        read = EXCLUDED.read,
        read_at = EXCLUDED.read_at,
        updated_at = EXCLUDED.updated_at
      RETURNING *
    `;

    const values = [
      notification.id,
      notification.userId,
      notification.type,
      notification.severity,
      notification.title,
      notification.message,
      JSON.stringify(notification.data),
      notification.channels,
      notification.priority,
      notification.status,
      notification.read,
      notification.readAt,
      notification.createdAt,
      notification.updatedAt,
    ];

    const result = await this.db.query(query, values);
    return this.mapRowToNotification(result.rows[0]);
  }

  async findById(id: string): Promise<Notification | null> {
    const query = 'SELECT * FROM notifications WHERE id = $1';
    const result = await this.db.query(query, [id]);
    
    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToNotification(result.rows[0]);
  }

  async findByUserId(userId: string, limit = 50, offset = 0): Promise<Notification[]> {
    const query = `
      SELECT * FROM notifications 
      WHERE user_id = $1 
      ORDER BY created_at DESC 
      LIMIT $2 OFFSET $3
    `;
    const result = await this.db.query(query, [userId, limit, offset]);
    
    return result.rows.map(row => this.mapRowToNotification(row));
  }

  async findUnreadByUserId(userId: string): Promise<Notification[]> {
    const query = `
      SELECT * FROM notifications 
      WHERE user_id = $1 AND read = false 
      ORDER BY created_at DESC
    `;
    const result = await this.db.query(query, [userId]);
    
    return result.rows.map(row => this.mapRowToNotification(row));
  }

  async countUnreadByUserId(userId: string): Promise<number> {
    const query = 'SELECT COUNT(*) FROM notifications WHERE user_id = $1 AND read = false';
    const result = await this.db.query(query, [userId]);
    
    return parseInt(result.rows[0].count, 10);
  }

  async markAsRead(id: string): Promise<Notification | null> {
    const query = `
      UPDATE notifications 
      SET read = true, read_at = NOW(), updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `;
    const result = await this.db.query(query, [id]);
    
    if (result.rows.length === 0) {
      return null;
    }

    return this.mapRowToNotification(result.rows[0]);
  }

  async markAllAsRead(userId: string): Promise<number> {
    const query = `
      UPDATE notifications 
      SET read = true, read_at = NOW(), updated_at = NOW()
      WHERE user_id = $1 AND read = false
    `;
    const result = await this.db.query(query, [userId]);
    
    return result.rowCount || 0;
  }

  async delete(id: string): Promise<boolean> {
    const query = 'DELETE FROM notifications WHERE id = $1';
    const result = await this.db.query(query, [id]);
    
    return (result.rowCount || 0) > 0;
  }

  async deleteOldNotifications(olderThanDays: number): Promise<number> {
    const query = `
      DELETE FROM notifications 
      WHERE created_at < NOW() - INTERVAL '${olderThanDays} days'
    `;
    const result = await this.db.query(query);
    
    return result.rowCount || 0;
  }

  private mapRowToNotification(row: Record<string, unknown>): Notification {
    return new Notification({
      id: row.id as string,
      userId: row.user_id as string,
      type: row.type as NotificationType,
      severity: row.severity as NotificationSeverity,
      title: row.title as string,
      message: row.message as string,
      data: row.data ? JSON.parse(row.data as string) : undefined,
      channels: row.channels as NotificationChannel[],
      priority: row.priority as number,
      status: row.status as NotificationStatus,
      read: row.read as boolean,
      readAt: row.read_at as Date | undefined,
      createdAt: row.created_at as Date,
      updatedAt: row.updated_at as Date,
    });
  }
}