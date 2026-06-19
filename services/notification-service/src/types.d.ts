declare module 'express' {
  export const Router: any;
  export const Request: any;
  export const Response: any;
  export const NextFunction: any;
}

declare module 'redis' {
  export function createClient(config: any): any;
  export interface RedisClientType {
    connect(): Promise<void>;
    get(key: string): Promise<string | null>;
    setEx(key: string, ttl: number, value: string): Promise<void>;
    del(...keys: string[]): Promise<number>;
    keys(pattern: string): Promise<string[]>;
    ping(): Promise<string>;
    quit(): Promise<void>;
    on(event: string, callback: (...args: any[]) => void): void;
  }
}