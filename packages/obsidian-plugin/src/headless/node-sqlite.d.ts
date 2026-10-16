// The part of Node's built-in `node:sqlite` that cacheLock.ts uses. The
// installed `@types/node` predates the module.
declare module "node:sqlite" {
  export class DatabaseSync {
    constructor(path: string, options?: { timeout?: number });
    exec(sql: string): void;
    close(): void;
  }
}
