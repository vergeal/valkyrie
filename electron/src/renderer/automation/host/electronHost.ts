import { invoke, type QueryResultPayload, type SavedConnection } from "../../api";
import { toast } from "sonner";
import type {
  DatabaseService,
  FileService,
  HttpService,
  LoggerService,
  NodeServices,
  NotifyService,
  NotifyOptions,
  SecretsService,
  VariableStore
} from "../sdk";

function toTable(result: QueryResultPayload) {
  return {
    columns: (result.columns ?? []).map(column => ({ name: column.label || column.name, type: column.type })),
    rows: result.rows ?? [],
    rowCount: result.rowCount ?? result.rows?.length ?? 0,
    affected: result.hasResultSet ? undefined : result.rowCount
  };
}

class ElectronDatabaseService implements DatabaseService {
  private sessions = new Map<string, string>();

  constructor(private getConnections: () => SavedConnection[]) {}

  async open(connection: string): Promise<void> {
    const config = this.getConnections().find(item => item.name === connection);

    if (!config)
      throw new Error(`连接「${connection}」不存在`);

    if (this.sessions.has(connection))
      return;

    const opened = await invoke<{ sessionId: string }>("connection.open", { connection: config });
    this.sessions.set(connection, opened.sessionId);
  }

  async close(connection: string): Promise<void> {
    const sessionId = this.sessions.get(connection);

    if (!sessionId)
      return;

    this.sessions.delete(connection);
    await invoke("connection.close", { sessionId }).catch(() => undefined);
  }

  isOpen(connection: string): boolean {
    return this.sessions.has(connection);
  }

  private session(connection: string): string {
    const sessionId = this.sessions.get(connection);

    if (!sessionId)
      throw new Error(`连接「${connection}」尚未打开`);

    return sessionId;
  }

  async query(connection: string, sql: string): Promise<ReturnType<typeof toTable>> {
    return toTable(await invoke<QueryResultPayload>("query.execute", { sessionId: this.session(connection), sql }));
  }

  async execute(connection: string, sql: string): Promise<ReturnType<typeof toTable>> {
    return toTable(await invoke<QueryResultPayload>("query.execute", { sessionId: this.session(connection), sql }));
  }
}

class NoopSecrets implements SecretsService {
  async get(): Promise<string | undefined> {
    return undefined;
  }
}

class UnsupportedFiles implements FileService {
  async readText(): Promise<string> {
    throw new Error("文件读取暂未开放");
  }

  async writeText(): Promise<void> {
    throw new Error("文件写入暂未开放");
  }

  async chooseOpen(): Promise<string | null> {
    return null;
  }

  async chooseSave(): Promise<string | null> {
    return null;
  }
}

class FetchHttp implements HttpService {
  async request(request: { url: string; method?: string; headers?: Record<string, string>; body?: string }, signal: AbortSignal) {
    const response = await fetch(request.url, {
      method: request.method ?? "GET",
      headers: request.headers,
      body: request.body,
      signal
    });

    return {
      status: response.status,
      headers: Object.fromEntries(response.headers.entries()),
      body: await response.text()
    };
  }
}

class ToastNotify implements NotifyService {
  async notify(options: NotifyOptions): Promise<void> {
    const title = options.title ?? "自动化";

    if (options.level === "success")
      toast.success(title, { description: options.message });
    else if (options.level === "error")
      toast.error(title, { description: options.message });
    else if (options.level === "warning")
      toast.warning(title, { description: options.message });
    else
      toast(title, { description: options.message });
  }
}

class ConsoleLogger implements LoggerService {
  log(level: string, message: string): void {
    if (level === "error")
      console.error(`[automation] ${message}`);
    else if (level === "warn")
      console.warn(`[automation] ${message}`);
    else
      console.debug(`[automation] ${message}`);
  }
}

class LocalVariables implements VariableStore {
  private values = new Map<string, unknown>();

  get(name: string): unknown {
    return this.values.get(name);
  }

  set(name: string, value: unknown): void {
    this.values.set(name, value);
  }

  has(name: string): boolean {
    return this.values.has(name);
  }

  snapshot(): Record<string, unknown> {
    return Object.fromEntries(this.values);
  }
}

export interface ElectronHostOptions {
  getConnections: () => SavedConnection[];
}

export function createElectronServices(options: ElectronHostOptions): NodeServices {
  return {
    database: new ElectronDatabaseService(options.getConnections),
    secrets: new NoopSecrets(),
    files: new UnsupportedFiles(),
    http: new FetchHttp(),
    notify: new ToastNotify(),
    logger: new ConsoleLogger(),
    variables: new LocalVariables()
  };
}
