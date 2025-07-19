import { writeFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOG_FILE = join(__dirname, '..', 'log', 'mcp.log');

// Ensure log directory exists
const logDir = dirname(LOG_FILE);
if (!existsSync(logDir)) {
  mkdirSync(logDir, { recursive: true });
}

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  context?: Record<string, unknown>;
  error?: Error;
}

class Logger {
  private logLevel: LogLevel = LogLevel.INFO;

  constructor() {
    // Initialize log file with startup message
    this.initializeLogFile();
  }

  private initializeLogFile(): void {
    const startupMessage = this.formatLogEntry({
      timestamp: new Date().toISOString(),
      level: 'INFO',
      message: '=== MCP Server Starting ===',
    });
    writeFileSync(LOG_FILE, startupMessage + '\n');
  }

  private formatLogEntry(entry: LogEntry): string {
    const contextStr = entry.context ? ` | Context: ${JSON.stringify(entry.context)}` : '';
    const errorStr = entry.error
      ? ` | Error: ${entry.error.message}\nStack: ${entry.error.stack}`
      : '';
    return `${entry.timestamp} [${entry.level}] ${entry.message}${contextStr}${errorStr}`;
  }

  private log(
    level: LogLevel,
    levelName: string,
    message: string,
    context?: Record<string, unknown>,
    error?: Error
  ): void {
    if (level < this.logLevel) {
      return;
    }

    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level: levelName,
      message,
      context,
      error,
    };

    const formattedMessage = this.formatLogEntry(entry);

    // Write to stderr
    console.error(formattedMessage);

    // Append to log file
    try {
      appendFileSync(LOG_FILE, formattedMessage + '\n');
    } catch (fileError) {
      console.error('Failed to write to log file:', fileError);
    }
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, 'DEBUG', message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, 'INFO', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, 'WARN', message, context);
  }

  error(message: string, error?: Error, context?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, 'ERROR', message, context, error);
  }

  setLogLevel(level: LogLevel): void {
    this.logLevel = level;
    this.info(`Log level set to ${LogLevel[level]}`, { level });
  }

  // Utility methods for structured logging
  logRequest(method: string, params?: unknown): void {
    this.debug(`Incoming request: ${method}`, { method, params });
  }

  logResponse(method: string, duration: number, success: boolean): void {
    this.info(`Request completed: ${method}`, { method, duration, success });
  }

  logGitHubAPI(
    operation: string,
    owner: string,
    repo: string,
    details?: Record<string, unknown>
  ): void {
    this.debug(`GitHub API: ${operation}`, { operation, owner, repo, ...details });
  }

  logWorkflowExecution(stage: string, branchName: string, details?: Record<string, unknown>): void {
    this.info(`Workflow execution: ${stage}`, { stage, branchName, ...details });
  }

  logValidation(type: 'original' | 'mutated', success: boolean, errorCount?: number): void {
    this.info(`Workflow validation (${type}): ${success ? 'passed' : 'failed'}`, {
      type,
      success,
      errorCount,
    });
  }

  logCleanup(branchName: string, success: boolean, error?: Error): void {
    if (success) {
      this.info(`Branch cleanup successful`, { branchName });
    } else {
      this.warn(`Branch cleanup failed`, { branchName, error: error?.message });
    }
  }
}

// Export singleton instance
export const logger = new Logger();

// Set log level from environment variable
const envLogLevel = process.env.LOG_LEVEL?.toUpperCase();
if (envLogLevel && envLogLevel in LogLevel) {
  logger.setLogLevel(LogLevel[envLogLevel as keyof typeof LogLevel]);
}
