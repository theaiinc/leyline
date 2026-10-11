export interface LogEntry {
  id: string;
  requestId: string;
  timestamp: string;
  provider: string;
  model: string;
  status: 'success' | 'error' | 'rate_limited';
  duration?: number;
  error?: string;
  usage?: { prompt_tokens?: number, completion_tokens?: number, total_tokens?: number, chars?: number };
}

export class Logger {
  private logs: LogEntry[] = [];
  private maxLogs: number;
  private sink?: (entry: LogEntry) => void;
  private source?: () => Promise<LogEntry[]>;

  constructor(maxLogs: number = 100) {
    this.maxLogs = maxLogs;
  }

  log(entry: Omit<LogEntry, 'id' | 'timestamp'>) {
    const logEntry: LogEntry = {
      id: Math.random().toString(36).substring(7),
      timestamp: new Date().toISOString(),
      ...entry
    };
    this.logs.unshift(logEntry);
    if (this.logs.length > this.maxLogs) {
      this.logs.pop();
    }
    this.sink?.(logEntry);
  }

  /** Keep entries somewhere shared too (the Worker: D1), and read recent ones from there. */
  persistTo(sink: (entry: LogEntry) => void, source: () => Promise<LogEntry[]>) {
    this.sink = sink;
    this.source = source;
  }

  /** Recent entries, newest first: from the shared store when there is one, else this process. */
  async recent(): Promise<LogEntry[]> {
    if (this.source) {
      try {
        return await this.source();
      } catch (err) {
        console.error('[Leyline] reading shared logs failed', err);
      }
    }
    return this.getLogs();
  }

  getLogs(): LogEntry[] {
    return [...this.logs];
  }

  clear() {
    this.logs = [];
  }
}

export const logger = new Logger();
