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
