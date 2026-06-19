import { Request, Response, NextFunction } from 'express';

export interface Permission {
  resource: string;
  action: 'create' | 'read' | 'update' | 'delete';
  scope?: 'own' | 'all';
}

export interface User {
  id: string;
  roles: string[];
  permissions: Permission[];
}

/**
 * RBAC Middleware for notification-service
 * 
 * Permissions:
 * - notification:create - Create notifications
 * - notification:read:own - Read own notifications
 * - notification:read:all - Read all notifications (admin)
 * - notification:update:own - Update own notifications
 * - notification:delete:own - Delete own notifications
 */
export class RBACMiddleware {
  /**
   * Check if user has required permission
   */
  static hasPermission(user: User, requiredPermission: Permission): boolean {
    // Check direct permission
    const hasDirectPermission = user.permissions.some(p => 
      p.resource === requiredPermission.resource &&
      p.action === requiredPermission.action &&
      (!requiredPermission.scope || p.scope === requiredPermission.scope)
    );

    if (hasDirectPermission) {
      return true;
    }

    // Check role-based permissions
    return user.roles.some(role => {
      switch (role) {
        case 'admin':
          return true; // Admin has all permissions
        case 'user':
          // Regular user can only access own resources
          return requiredPermission.scope === 'own';
        default:
          return false;
      }
    });
  }

  /**
   * Middleware factory for permission checking
   */
  static requirePermission(resource: string, action: 'create' | 'read' | 'update' | 'delete', scope: 'own' | 'all' = 'own') {
    return (req: Request, res: Response, next: NextFunction): void => {
      try {
        // Extract user from request (set by auth middleware)
        const user = req.user as User | undefined;

        if (!user) {
          res.status(401).json({
            success: false,
            error: 'Unauthorized - No user context',
          });
          return;
        }

        const requiredPermission: Permission = {
          resource,
          action,
          scope,
        };

        if (!this.hasPermission(user, requiredPermission)) {
          res.status(403).json({
            success: false,
            error: 'Forbidden - Insufficient permissions',
          });
          return;
        }

        // For 'own' scope, verify resource ownership
        if (scope === 'own') {
          const resourceOwnerId = this.extractResourceOwnerId(req);
          if (resourceOwnerId && resourceOwnerId !== user.id) {
            res.status(403).json({
              success: false,
              error: 'Forbidden - Cannot access other users resources',
            });
            return;
          }
        }

        next();
      } catch (error) {
        res.status(500).json({
          success: false,
          error: 'Internal server error during authorization',
        });
      }
    };
  }

  /**
   * Extract resource owner ID from request
   */
  private static extractResourceOwnerId(req: Request): string | null {
    // Extract from route params or body
    const userId = req.params.userId || req.body.userId;
    return typeof userId === 'string' ? userId : null;
  }

  /**
   * Middleware to inject user context (mock for development)
   * In production, this would be replaced by actual auth middleware
   */
  static injectUserContext(req: Request, res: Response, next: NextFunction): void {
    // Mock user for development
    // In production, this would come from JWT token or session
    const mockUser: User = {
      id: req.headers['x-user-id'] as string || 'user_123',
      roles: req.headers['x-user-role'] as string ? [req.headers['x-user-role'] as string] : ['user'],
      permissions: [
        { resource: 'notification', action: 'create', scope: 'own' },
        { resource: 'notification', action: 'read', scope: 'own' },
        { resource: 'notification', action: 'update', scope: 'own' },
        { resource: 'notification', action: 'delete', scope: 'own' },
      ],
    };

    req.user = mockUser;
    next();
  }
}

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: User;
    }
  }
}