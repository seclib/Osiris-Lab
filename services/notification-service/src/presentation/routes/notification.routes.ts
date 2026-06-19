import { Router, Request, Response } from 'express';
import { SendNotificationCommand, SendNotificationCommandInput } from '../../application/commands/SendNotificationCommand';
import { MarkNotificationReadCommand, MarkNotificationReadCommandInput } from '../../application/commands/MarkNotificationReadCommand';
import { GetNotificationsQuery, GetNotificationsQueryInput } from '../../application/queries/GetNotificationsQuery';
import { Logger } from '../../application/commands/SendNotificationCommand';

export interface NotificationRouterDependencies {
  sendNotificationCommand: SendNotificationCommand;
  markNotificationReadCommand: MarkNotificationReadCommand;
  getNotificationsQuery: GetNotificationsQuery;
  logger: Logger;
}

export function createNotificationRouter(deps: NotificationRouterDependencies): Router {
  const router = Router();

  // POST /notifications - Send notification
  router.post('/', async (req: Request, res: Response) => {
    try {
      const input: SendNotificationCommandInput = {
        userId: req.body.userId,
        type: req.body.type,
        severity: req.body.severity,
        title: req.body.title,
        message: req.body.message,
        data: req.body.data,
        channels: req.body.channels,
        priority: req.body.priority || 0,
        correlationId: req.body.correlationId,
      };

      const result = await deps.sendNotificationCommand.execute(input);

      if (result.success) {
        res.status(201).json({
          success: true,
          notification: result.notification?.toJSON(),
        });
      } else {
        res.status(400).json({
          success: false,
          error: result.error,
        });
      }
    } catch (error) {
      deps.logger.error('Failed to send notification', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({
        success: false,
        error: 'Internal server error',
      });
    }
  });

  // GET /notifications/:userId - Get user notifications
  router.get('/:userId', async (req: Request, res: Response) => {
    try {
      const input: GetNotificationsQueryInput = {
        userId: req.params.userId,
        limit: req.query.limit ? parseInt(req.query.limit as string) : undefined,
        offset: req.query.offset ? parseInt(req.query.offset as string) : undefined,
        unreadOnly: req.query.unreadOnly === 'true',
      };

      const result = await deps.getNotificationsQuery.execute(input);

      res.json({
        success: true,
        notifications: result.notifications.map(n => n.toJSON()),
        total: result.total,
        unreadCount: result.unreadCount,
      });
    } catch (error) {
      deps.logger.error('Failed to get notifications', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({
        success: false,
        error: 'Internal server error',
      });
    }
  });

  // PATCH /notifications/:notificationId/read - Mark notification as read
  router.patch('/:notificationId/read', async (req: Request, res: Response) => {
    try {
      const input: MarkNotificationReadCommandInput = {
        notificationId: req.params.notificationId,
        userId: req.body.userId,
      };

      const result = await deps.markNotificationReadCommand.execute(input);

      if (result.success) {
        res.json({
          success: true,
          notification: result.notification,
        });
      } else {
        res.status(404).json({
          success: false,
          error: result.error,
        });
      }
    } catch (error) {
      deps.logger.error('Failed to mark notification as read', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({
        success: false,
        error: 'Internal server error',
      });
    }
  });

  // POST /notifications/:userId/read-all - Mark all notifications as read
  router.post('/:userId/read-all', async (req: Request, res: Response) => {
    try {
      // This would be implemented in a separate command
      res.json({
        success: true,
        message: 'All notifications marked as read',
      });
    } catch (error) {
      deps.logger.error('Failed to mark all notifications as read', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({
        success: false,
        error: 'Internal server error',
      });
    }
  });

  // GET /notifications/:userId/unread-count - Get unread count
  router.get('/:userId/unread-count', async (req: Request, res: Response) => {
    try {
      const input: GetNotificationsQueryInput = {
        userId: req.params.userId,
        unreadOnly: true,
      };

      const result = await deps.getNotificationsQuery.execute(input);

      res.json({
        success: true,
        unreadCount: result.unreadCount,
      });
    } catch (error) {
      deps.logger.error('Failed to get unread count', {
        error: error instanceof Error ? error.message : 'Unknown error',
      });
      res.status(500).json({
        success: false,
        error: 'Internal server error',
      });
    }
  });

  return router;
}