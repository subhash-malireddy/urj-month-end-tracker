// Configure Pino logger with timezone formatting
import pino from "pino";
import dotenv from "dotenv";

dotenv.config();
const TIMEZONE = "Australia/Sydney";

export const logger = pino({
  level: "info",
  timestamp: () => {
    return `,"time":"${new Date().toLocaleString("en-AU", {
      timeZone: TIMEZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: false,
    })}"`;
  },
  formatters: {
    level: (label) => {
      return { level: label.toUpperCase() };
    },
  },
  transport: {
    target: "pino-pretty",
    options: {
      colorize: true,
      translateTime: false, // We're handling timestamp formatting ourselves
      ignore: "pid,hostname",
      messageFormat: "[{time}] [{level}] {msg}",
    },
  },
});

// Helper logging functions for easy use
export const logSeparator = () => {
  logger.info("=" + "=".repeat(80));
};

// Centralized operation handler for consistent logging and error handling
export const executeOperation = async (
  operationName,
  operation,
  context = {}
) => {
  try {
    logger.info({ ...context }, `${operationName}: Starting operation`);
    await operation();
    logger.info(
      { ...context },
      `${operationName}: Operation completed successfully`
    );
    return { success: true };
  } catch (error) {
    logger.error({ ...context, error }, `${operationName}: Operation failed`);
    return { success: false };
  }
};

// Specialized handler for device operations with detailed context
export const executeDeviceOperation = async (
  operationName,
  deviceContext,
  operation
) => {
  const context = {
    deviceId: deviceContext.device_id,
    alias: deviceContext.alias,
    usageRecordId: deviceContext.usage_record_id,
  };

  return executeOperation(
    `${operationName}[${deviceContext.alias}]`,
    operation,
    context
  );
};

// Handler for batch operations that processes multiple items and collects results
export const executeBatchOperation = async (
  operationName,
  items,
  itemProcessor
) => {
  logger.info(
    { itemCount: items.length },
    `${operationName}: Starting batch operation`
  );

  let successCount = 0;
  let failureCount = 0;

  for (const item of items) {
    const result = await itemProcessor(item);

    if (result.success) {
      successCount++;
    } else {
      failureCount++;
    }
  }

  logger.info(
    {
      totalItems: items.length,
      successCount,
      failureCount,
      successRate: `${Math.round((successCount / items.length) * 100)}%`,
    },
    `${operationName}: Batch operation completed`
  );

  return { successCount, failureCount, hasErrors: failureCount > 0 };
};
