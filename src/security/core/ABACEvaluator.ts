/**
 * OSIRIS Security Framework — ABAC Evaluator
 * 
 * Attribute-Based Access Control (ABAC).
 * Évalue les PermissionCondition (field, operator, value).
 * 
 * Zero Trust: Dynamic authorization based on attributes.
 */

import type { PermissionCondition, SecurityContext } from './types';

/**
 * ABAC evaluation result
 */
export interface ABACResult {
  allowed: boolean;
  reason?: string;
  matchedConditions: number;
  totalConditions: number;
}

/**
 * Attribute source for ABAC
 */
export interface AttributeSource {
  // User attributes
  getUserAttribute(context: SecurityContext, field: string): unknown;
  
  // Resource attributes
  getResourceAttribute(resourceType: string, resourceId: string, field: string): Promise<unknown>;
  
  // Environment attributes
  getEnvironmentAttribute(field: string): unknown;
  
  // Action attributes
  getActionAttribute(action: string, field: string): unknown;
}

/**
 * Default attribute source (in-memory)
 */
export class DefaultAttributeSource implements AttributeSource {
  private userAttributes: Map<string, Record<string, unknown>> = new Map();
  private resourceAttributes: Map<string, Record<string, unknown>> = new Map();
  private environmentAttributes: Record<string, unknown> = {};

  /**
   * Set user attributes
   */
  setUserAttributes(userId: string, attributes: Record<string, unknown>): void {
    this.userAttributes.set(userId, attributes);
  }

  /**
   * Set resource attributes
   */
  setResourceAttributes(resourceKey: string, attributes: Record<string, unknown>): void {
    this.resourceAttributes.set(resourceKey, attributes);
  }

  /**
   * Set environment attributes
   */
  setEnvironmentAttributes(attributes: Record<string, unknown>): void {
    this.environmentAttributes = { ...this.environmentAttributes, ...attributes };
  }

  getUserAttribute(context: SecurityContext, field: string): unknown {
    if (!context.userId) return undefined;
    const attrs = this.userAttributes.get(context.userId);
    return attrs?.[field];
  }

  async getResourceAttribute(resourceType: string, resourceId: string, field: string): Promise<unknown> {
    const key = `${resourceType}:${resourceId}`;
    const attrs = this.resourceAttributes.get(key);
    return attrs?.[field];
  }

  getEnvironmentAttribute(field: string): unknown {
    return this.environmentAttributes[field];
  }

  getActionAttribute(action: string, field: string): unknown {
    return { action }[field];
  }
}

/**
 * ABAC Evaluator
 */
export class ABACEvaluator {
  private attributeSource: AttributeSource;

  constructor(attributeSource?: AttributeSource) {
    this.attributeSource = attributeSource || new DefaultAttributeSource();
  }

  /**
   * Set attribute source
   */
  setAttributeSource(source: AttributeSource): void {
    this.attributeSource = source;
  }

  /**
   * Evaluate a single condition
   */
  async evaluateCondition(
    condition: PermissionCondition,
    context: SecurityContext,
    resourceType: string,
    resourceId: string,
    action: string
  ): Promise<boolean> {
    const value = await this.resolveAttribute(condition.field, context, resourceType, resourceId, action);
    const targetValue = condition.value;

    switch (condition.operator) {
      case 'eq':
        return value === targetValue;
      
      case 'neq':
        return value !== targetValue;
      
      case 'in':
        if (!Array.isArray(targetValue)) return false;
        return targetValue.includes(value);
      
      case 'contains':
        if (typeof value !== 'string' || typeof targetValue !== 'string') return false;
        return value.includes(targetValue);
      
      case 'startsWith':
        if (typeof value !== 'string' || typeof targetValue !== 'string') return false;
        return value.startsWith(targetValue);
      
      case 'gt':
        return this.compareNumbers(value, targetValue) > 0;
      
      case 'lt':
        return this.compareNumbers(value, targetValue) < 0;
      
      default:
        return false;
    }
  }

  /**
   * Evaluate multiple conditions (AND logic)
   */
  async evaluateConditions(
    conditions: PermissionCondition[],
    context: SecurityContext,
    resourceType: string,
    resourceId: string,
    action: string
  ): Promise<ABACResult> {
    if (conditions.length === 0) {
      return {
        allowed: true,
        matchedConditions: 0,
        totalConditions: 0,
      };
    }

    let matched = 0;
    for (const condition of conditions) {
      const result = await this.evaluateCondition(condition, context, resourceType, resourceId, action);
      if (result) {
        matched++;
      } else {
        return {
          allowed: false,
          reason: `Condition failed: ${condition.field} ${condition.operator} ${condition.value}`,
          matchedConditions: matched,
          totalConditions: conditions.length,
        };
      }
    }

    return {
      allowed: true,
      matchedConditions: matched,
      totalConditions: conditions.length,
    };
  }

  /**
   * Resolve attribute value from field name
   * Field format: "user:role", "resource:owner", "env:time", "action:method"
   */
  private async resolveAttribute(
    field: string,
    context: SecurityContext,
    resourceType: string,
    resourceId: string,
    action: string
  ): Promise<unknown> {
    const [source, attribute] = field.split(':');

    switch (source) {
      case 'user':
        return this.attributeSource.getUserAttribute(context, attribute);
      
      case 'resource':
        return this.attributeSource.getResourceAttribute(resourceType, resourceId, attribute);
      
      case 'env':
        return this.attributeSource.getEnvironmentAttribute(attribute);
      
      case 'action':
        return this.attributeSource.getActionAttribute(action, attribute);
      
      default:
        return undefined;
    }
  }

  /**
   * Compare two values as numbers
   */
  private compareNumbers(a: unknown, b: unknown): number {
    const numA = typeof a === 'number' ? a : parseFloat(String(a));
    const numB = typeof b === 'number' ? b : parseFloat(String(b));
    
    if (isNaN(numA) || isNaN(numB)) return 0;
    return numA - numB;
  }

  /**
   * Quick check: does user have required role?
   */
  hasRole(context: SecurityContext, requiredRole: string): boolean {
    return context.role === requiredRole;
  }

  /**
   * Quick check: does user have required permission?
   */
  hasPermission(context: SecurityContext, requiredPermission: string): boolean {
    return context.permissions?.includes(requiredPermission) || false;
  }

  /**
   * Quick check: is user in required group?
   */
  isInGroup(context: SecurityContext, requiredGroup: string): boolean {
    // Groups are stored in permissions with prefix "group:"
    return context.permissions?.some((p) => p === `group:${requiredGroup}`) || false;
  }

  /**
   * Check time-based access (business hours)
   */
  isWithinBusinessHours(startHour: number = 9, endHour: number = 18): boolean {
    const now = new Date();
    const hour = now.getUTCHours();
    return hour >= startHour && hour < endHour;
  }

  /**
   * Check IP-based access (whitelist)
   */
  isFromAllowedIp(context: SecurityContext, allowedIps: string[]): boolean {
    if (!context.ip) return false;
    return allowedIps.includes(context.ip);
  }

  /**
   * Check MFA requirement
   */
  isMfaVerified(context: SecurityContext, required: boolean = true): boolean {
    if (!required) return true;
    return context.mfaVerified === true;
  }
}