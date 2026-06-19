export enum NotificationType {
  ALERT = 'alert',
  INFO = 'info',
  WARNING = 'warning',
  SYSTEM = 'system',
}

export enum NotificationSeverity {
  LOW = 'low',
  MEDIUM = 'medium',
  HIGH = 'high',
  CRITICAL = 'critical',
}

export enum NotificationChannel {
  WEBSOCKET = 'websocket',
  PUSH = 'push',
  EMAIL = 'email',
  SMS = 'sms',
}

export enum NotificationStatus {
  PENDING = 'pending',
  SENT = 'sent',
  DELIVERED = 'delivered',
  FAILED = 'failed',
  READ = 'read',
}

export interface NotificationProps {
  id?: string;
  userId: string;
  type: NotificationType;
  severity: NotificationSeverity;
  title: string;
  message: string;
  data?: Record<string, unknown>;
  channels: NotificationChannel[];
  priority: number;
  status?: NotificationStatus;
  read?: boolean;
  readAt?: Date;
  createdAt?: Date;
  updatedAt?: Date;
}

export class Notification {
  public readonly id: string;
  public readonly userId: string;
  public readonly type: NotificationType;
  public readonly severity: NotificationSeverity;
  public readonly title: string;
  public readonly message: string;
  public data: Record<string, unknown>;
  public readonly channels: NotificationChannel[];
  public readonly priority: number;
  public status: NotificationStatus;
  public read: boolean;
  public readAt?: Date;
  public readonly createdAt: Date;
  public updatedAt: Date;

  constructor(props: NotificationProps) {
    this.id = props.id || this.generateId();
    this.userId = props.userId;
    this.type = props.type;
    this.severity = props.severity;
    this.title = props.title;
    this.message = props.message;
    this.data = props.data || {};
    this.channels = props.channels;
    this.priority = props.priority;
    this.status = props.status || NotificationStatus.PENDING;
    this.read = props.read || false;
    this.readAt = props.readAt;
    this.createdAt = props.createdAt || new Date();
    this.updatedAt = props.updatedAt || new Date();
  }

  private generateId(): string {
    return `notif_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }

  public markAsRead(): void {
    if (!this.read) {
      this.read = true;
      this.readAt = new Date();
      this.updatedAt = new Date();
    }
  }

  public markAsSent(): void {
    if (this.status === NotificationStatus.PENDING) {
      this.status = NotificationStatus.SENT;
      this.updatedAt = new Date();
    }
  }

  public markAsDelivered(): void {
    if (this.status === NotificationStatus.SENT) {
      this.status = NotificationStatus.DELIVERED;
      this.updatedAt = new Date();
    }
  }

  public markAsFailed(error?: string): void {
    this.status = NotificationStatus.FAILED;
    this.updatedAt = new Date();
    if (error) {
      this.data = {
        ...this.data,
        error: error as unknown,
      };
    }
  }

  public isCritical(): boolean {
    return this.severity === NotificationSeverity.CRITICAL;
  }

  public hasChannel(channel: NotificationChannel): boolean {
    return this.channels.includes(channel);
  }

  public toJSON() {
    return {
      id: this.id,
      userId: this.userId,
      type: this.type,
      severity: this.severity,
      title: this.title,
      message: this.message,
      data: this.data,
      channels: this.channels,
      priority: this.priority,
      status: this.status,
      read: this.read,
      readAt: this.readAt,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }
}