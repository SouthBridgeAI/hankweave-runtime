import { EventEmitter } from "node:events";
import type { ServerEvent } from "./types.js";

/**
 * Type-safe wrapper around Node's EventEmitter.
 * Ensures event names and argument types are consistent at compile time.
 */
export class TypedEventEmitter<T extends Record<string, unknown[]>> {
  private emitter = new EventEmitter();

  on<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this {
    this.emitter.on(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  off<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this {
    this.emitter.off(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  emit<K extends keyof T>(event: K, ...args: T[K]): boolean {
    return this.emitter.emit(event as string, ...args);
  }

  once<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this {
    this.emitter.once(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  removeAllListeners<K extends keyof T>(event?: K): this {
    if (event) {
      this.emitter.removeAllListeners(event as string);
    } else {
      this.emitter.removeAllListeners();
    }
    return this;
  }

  // Additional EventEmitter compatibility methods
  addListener<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this {
    return this.on(event, listener);
  }

  removeListener<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this {
    return this.off(event, listener);
  }

  setMaxListeners(n: number): this {
    this.emitter.setMaxListeners(n);
    return this;
  }

  getMaxListeners(): number {
    return this.emitter.getMaxListeners();
  }

  listeners(event: keyof T): Function[] {
    return this.emitter.listeners(event as string);
  }

  rawListeners(event: keyof T): Function[] {
    return this.emitter.rawListeners(event as string);
  }

  eventNames(): (string | symbol)[] {
    return this.emitter.eventNames();
  }

  listenerCount(event: keyof T): number {
    return this.emitter.listenerCount(event as string);
  }

  prependListener<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this {
    this.emitter.prependListener(event as string, listener as (...args: unknown[]) => void);
    return this;
  }

  prependOnceListener<K extends keyof T>(event: K, listener: (...args: T[K]) => void): this {
    this.emitter.prependOnceListener(event as string, listener as (...args: unknown[]) => void);
    return this;
  }
}

// Define server event map
export interface ServerInternalEvents {
  event: [ServerEvent];
  exit: [code: number];
  error: [error: Error];
  stdout: [data: string];
  stderr: [data: string];
  [key: string]: unknown[]; // Index signature to satisfy constraint
}

// Define process manager event map
export interface ProcessEvents {
  exit: [code: number];
  error: [error: Error];
  stdout: [data: string];
  stderr: [data: string];
  [key: string]: unknown[]; // Index signature to satisfy constraint
}
