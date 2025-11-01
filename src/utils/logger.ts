import { appendFile, mkdir } from 'fs/promises';
import { dirname, resolve } from 'path';
import { ENV } from '../config/env';

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

const levelPriority: Record<LogLevel, number> = {
    error: 0,
    warn: 1,
    info: 2,
    debug: 3,
};

const normaliseLevel = (value: string | undefined): LogLevel => {
    const lower = value?.toLowerCase();
    if (lower === 'error' || lower === 'warn' || lower === 'info' || lower === 'debug') {
        return lower;
    }

    return 'info';
};

const configuredLevel = normaliseLevel(ENV.LOG_LEVEL);
const logFilePath = resolve(ENV.LOG_FILE_PATH);

let directoryEnsured = false;

const ensureDirectory = async () => {
    if (directoryEnsured) {
        return;
    }

    await mkdir(dirname(logFilePath), { recursive: true });
    directoryEnsured = true;
};

const logMessage = async (level: LogLevel, message: string, metadata?: Record<string, unknown>) => {
    if (levelPriority[level] > levelPriority[configuredLevel]) {
        return;
    }

    await ensureDirectory();

    const timestamp = new Date().toISOString();
    const metadataText = metadata ? ` ${JSON.stringify(metadata)}` : '';
    const logLine = `[${timestamp}] [${level.toUpperCase()}] ${message}${metadataText}\n`;

    try {
        await appendFile(logFilePath, logLine, { encoding: 'utf8' });
    } catch (error) {
        console.error('Unable to write log entry:', error);
        console.error(logLine);
    }
};

export const logger = {
    info: (message: string, metadata?: Record<string, unknown>) => logMessage('info', message, metadata),
    warn: (message: string, metadata?: Record<string, unknown>) => logMessage('warn', message, metadata),
    error: (message: string, metadata?: Record<string, unknown>) => logMessage('error', message, metadata),
    debug: (message: string, metadata?: Record<string, unknown>) => logMessage('debug', message, metadata),
};

export default logger;
