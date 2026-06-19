import { readFileSync } from 'fs';
import { join } from 'path';

export class EventSchemaValidator {
  private schemas: Map<string, Record<string, unknown>> = new Map();

  constructor() {
    this.loadSchemas();
  }

  private loadSchemas(): void {
    const schemasDir = join(process.cwd(), 'libs/events/schemas');
    
    // Notification schemas
    this.loadSchema(join(schemasDir, 'notification/requested.json'));
    this.loadSchema(join(schemasDir, 'notification/sent.json'));
    this.loadSchema(join(schemasDir, 'notification/delivered.json'));
    this.loadSchema(join(schemasDir, 'notification/failed.json'));
    this.loadSchema(join(schemasDir, 'notification/read.json'));
    
    // Workflow schemas
    this.loadSchema(join(schemasDir, 'workflow/created.json'));
    this.loadSchema(join(schemasDir, 'workflow/updated.json'));
    this.loadSchema(join(schemasDir, 'workflow/deleted.json'));
    this.loadSchema(join(schemasDir, 'workflow/execution.started.json'));
    this.loadSchema(join(schemasDir, 'workflow/step.completed.json'));
  }

  private loadSchema(filePath: string): void {
    try {
      const schema: Record<string, unknown> = JSON.parse(readFileSync(filePath, 'utf-8'));
      const eventType = this.extractEventType(filePath);
      this.schemas.set(eventType, schema);
    } catch (error) {
      console.warn(`Failed to load schema: ${filePath}`, error);
    }
  }

  private extractEventType(filePath: string): string {
    const parts = filePath.split('/');
    const category = parts[parts.length - 2];
    const filename = parts[parts.length - 1].replace('.json', '');
    return `${category}.${filename}`;
  }

  validate(eventType: string, payload: Record<string, unknown>): { valid: boolean; errors?: string[] } {
    const schema = this.schemas.get(eventType) as Record<string, unknown> | undefined;
    
    if (!schema) {
      return {
        valid: false,
        errors: [`Unknown event type: ${eventType}`]
      };
    }

    const errors: string[] = [];

    // Check required fields
    const required = schema.required as string[] | undefined;
    if (Array.isArray(required)) {
      for (const field of required) {
        if (!(field in payload)) {
          errors.push(`Missing required field: ${field}`);
        }
      }
    }

    // Check field types and constraints
    const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
    if (properties && errors.length === 0) {
      for (const [field, fieldSchema] of Object.entries(properties)) {
        if (!(field in payload)) continue;

        const value = payload[field];
        const fieldDef = fieldSchema as Record<string, unknown>;

        // Type check
        const fieldType = fieldDef.type as string | undefined;
        if (fieldType && typeof value !== fieldType) {
          errors.push(`Field ${field}: expected ${fieldType}, got ${typeof value}`);
        }

        // Enum check
        const enumValues = fieldDef.enum as (string | number)[] | undefined;
        if (Array.isArray(enumValues) && !enumValues.includes(value as string | number)) {
          errors.push(`Field ${field}: invalid enum value ${value}, allowed: ${enumValues.join(', ')}`);
        }

        // Format check (basic)
        if (fieldDef.format === 'uuid' && typeof value === 'string') {
          const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
          if (!uuidRegex.test(value)) {
            errors.push(`Field ${field}: invalid UUID format`);
          }
        }

        // Minimum/Maximum check
        const minimum = fieldDef.minimum as number | undefined;
        if (typeof minimum === 'number' && typeof value === 'number') {
          if (value < minimum) {
            errors.push(`Field ${field}: value ${value} is less than minimum ${minimum}`);
          }
        }
      }
    }

    return {
      valid: errors.length === 0,
      errors: errors.length > 0 ? errors : undefined
    };
  }

  getSupportedEventTypes(): string[] {
    return Array.from(this.schemas.keys());
  }
}