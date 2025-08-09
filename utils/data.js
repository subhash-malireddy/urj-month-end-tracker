import { neon } from "@neondatabase/serverless";
import { logger } from "./logger.js";

if (!process.env.DATABASE_URL) {
  logger.fatal("ENV: DATABASE_URL is missing. Exiting.");
  process.exit(1);
}
const sql = neon(process.env.DATABASE_URL);

export const getActiveDevicesAndTheirUsage = async () => {
  const result =
    await sql`SELECT active_device.device_id, usage_record_id, device.ip_address, device.alias, consumption FROM active_device 
      LEFT JOIN usage ON active_device.usage_record_id = usage.id
      LEFT JOIN device ON active_device.device_id = device.id`;
  return result;
};

// Update tracking flag for a usage record
export const updateTrackingFlag = async (
  usageRecordId,
  isTracking,
  errorContext
) => {
  try {
    await sql`UPDATE usage SET is_tracking_previous_month = ${isTracking} WHERE id = ${usageRecordId}`;
    logger.info(
      { usageRecordId, isTracking },
      "DB: Updated tracking flag for usage record"
    );
  } catch (error) {
    logger.error(
      { usageRecordId, isTracking, error, errorContext },
      "DB: Error updating tracking flag for usage record"
    );
  }
};

// Store previous month accumulated value
export const storePreviousMonthAccumulated = async (
  usageRecordId,
  accumulatedValue
) => {
  try {
    await sql`UPDATE usage SET previous_month_accumulated = ${accumulatedValue}, is_tracking_previous_month = false WHERE id = ${usageRecordId}`;
    logger.info(
      { usageRecordId, accumulatedValue },
      "DB: Stored previous month accumulated value and reset tracking flag"
    );
  } catch (error) {
    logger.error(
      { usageRecordId, accumulatedValue, error },
      "DB: Error storing previous month accumulated value"
    );
  }
};
