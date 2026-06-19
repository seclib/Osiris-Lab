import { Server, Socket } from 'socket.io';
import { Logger } from '../../application/commands/SendNotificationCommand';
import { Notification, NotificationChannel } from '../../domain/entities/Notification';

export interface SocketIOGateway {
  initialize(): void;
  sendToUser(userId: string, notification: Notification): Promise<void>;
  sendToAll(notification: Notification): Promise<void>;
  getConnectedUsers(): string[];
  isUserOnline(userId: string): boolean;
  disconnect(): void;
}

export class SocketIOGatewayImpl implements SocketIOGateway {
  private io: Server | null = null;
  private connectedUsers: Map<string, Socket> = new Map();

  constructor(private logger: Logger) {}

  initialize(): void {
    this.io = new Server({
      cors: {
        origin: process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:3000'],
        credentials: true,
      },
      transports: ['websocket', 'polling'],
    });

    this.io.on('connection', (socket: Socket) => {
      this.logger.info('Client connected', { socketId: socket.id });

      // Authenticate user
      socket.on('authenticate', (userId: string) => {
        this.connectedUsers.set(userId, socket);
        this.logger.info('User authenticated', { userId, socketId: socket.id });
        
        // Join user-specific room
        socket.join(`user:${userId}`);
      });

      // Handle disconnect
      socket.on('disconnect', () => {
        // Remove from connected users
        for (const [userId, userSocket] of this.connectedUsers.entries()) {
          if (userSocket.id === socket.id) {
            this.connectedUsers.delete(userId);
            this.logger.info('User disconnected', { userId });
            break;
          }
        }
      });

      // Handle notification read
      socket.on('notification:read', async (data: { notificationId: string }) => {
        this.logger.info('Notification read via WebSocket', { notificationId: data.notificationId });
        // Emit event for other services to handle
        socket.to(`user:${socket.id}`).emit('notification:read:ack', {
          notificationId: data.notificationId,
          success: true,
        });
      });
    });

    const port = parseInt(process.env.WEBSOCKET_PORT || '4001', 10);
    this.io.listen(port);
    this.logger.info('Socket.IO gateway initialized', { port });
  }

  async sendToUser(userId: string, notification: Notification): Promise<void> {
    if (!this.io) {
      throw new Error('Socket.IO gateway not initialized');
    }

    const userSocket = this.connectedUsers.get(userId);
    if (userSocket) {
      // User is online, send via WebSocket
      userSocket.emit('notification:received', notification.toJSON());
      this.logger.info('Notification sent via WebSocket', {
        userId,
        notificationId: notification.id,
      });
    } else {
      this.logger.warn('User not connected via WebSocket', { userId });
    }
  }

  async sendToAll(notification: Notification): Promise<void> {
    if (!this.io) {
      throw new Error('Socket.IO gateway not initialized');
    }

    // Broadcast to all connected clients
    this.io.emit('notification:received', notification.toJSON());
    this.logger.info('Notification broadcasted to all users', {
      notificationId: notification.id,
    });
  }

  getConnectedUsers(): string[] {
    return Array.from(this.connectedUsers.keys());
  }

  isUserOnline(userId: string): boolean {
    return this.connectedUsers.has(userId);
  }

  disconnect(): void {
    if (this.io) {
      this.io.close();
      this.io = null;
      this.logger.info('Socket.IO gateway disconnected');
    }
  }
}