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
  }

  getLogs(): LogEntry[] {
    return this.logs;
  }
}

export const logger = new Logger();
