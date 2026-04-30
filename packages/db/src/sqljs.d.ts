declare module 'sql.js' {
  export interface QueryExecResult {
    columns: string[];
    values: unknown[][];
  }

  export interface Database {
    run(sql: string, params?: unknown[]): void;
    exec(sql: string, params?: unknown[]): QueryExecResult[];
    export(): Uint8Array;
  }

  export interface SqlJsStatic {
    Database: new (data?: Uint8Array) => Database;
  }

  export default function initSqlJs(config?: unknown): Promise<SqlJsStatic>;
}
