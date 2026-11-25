// Runtime module: node:sqlite. The repository's transitive Node 18 type
// package predates this built-in, so declare the subset Triggerfish uses.
declare module "node:sqlite" {
  type Binding = null | number | bigint | string | Uint8Array;
  type Row = Record<string, Binding>;

  interface Statement {
    get(...parameters: Binding[]): Row | undefined;
    all(...parameters: Binding[]): Row[];
    run(
      ...parameters: Binding[]
    ): { changes: number | bigint; lastInsertRowid: number | bigint };
  }

  export class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean });
    close(): void;
    exec(sql: string): void;
    prepare(sql: string): Statement;
  }
}
