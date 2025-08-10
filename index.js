import cron from "node-cron";
import {
  logger,
  logSeparator,
  executeOperation,
  executeDeviceOperation,
  executeBatchOperation,
} from "./utils/logger.js";
import {
  getActiveDevicesAndTheirUsage,
  updateTrackingFlag,
  storePreviousMonthAccumulated,
} from "./utils/data.js";

// In-memory storage for tracking devices during month transition
/**
 * @type {Map<string, {
 *   device_id: string;
 *   alias: string;
 *   usage_record_id: string;
 *   ip_address: string;
 *   consumption: number;
 *   month_energy: number;
 * }>}
 */
const trackingDevices = new Map();

// --- Configuration ---
const TIMEZONE = "Australia/Sydney";

// Global fault-handling hooks
process.on("unhandledRejection", (reason) => {
  logger.error({ reason }, "PROCESS: Unhandled promise rejection");
});
process.on("uncaughtException", (error) => {
  logger.error({ error }, "PROCESS: Uncaught exception");
});

// --- Cron Job Logic ---
async function checkAndPollTapoDevices() {
  const now = new Date();
  const lastDayOfMonth = new Date(
    now.getFullYear(),
    now.getMonth() + 1,
    //when a day is 0, it means the last day of the previous month but since we are using getMonth() + 1, it means the last day of the current month
    0
  ).getDate();

  logSeparator();
  logger.info("MONTH-END CHECKER: Cron job triggered");

  if (now.getDate() !== lastDayOfMonth) return;

  logger.info(`MONTH-END DETECTED: Last day of month (${now.toDateString()})`);

  await executeOperation(
    "MONTH-END-MONITORING-SEQUENCE",
    async () => {
      // Track execution status for each minute (minute -> success/failure)
      const minuteExecutionStatus = new Map();

      // Monitor loop - check every 5 seconds for the right minute
      while (true) {
        const now = new Date();
        const currentMinute = now.getMinutes();

        // Check if we're in the monitoring window (55, 56, 57, 58) or finalization minute (59)
        if ([55, 56, 57, 58, 59].includes(currentMinute)) {
          const minuteKey = `${now.getHours()}-${currentMinute}`;

          // Only process each minute once, and only if it hasn't succeeded yet
          if (
            minuteExecutionStatus.has(minuteKey) ||
            minuteExecutionStatus.get(minuteKey) === true
          ) {
            await delay();
            continue;
          }

          if (currentMinute === 59) {
            const success = await executeOperation(
              "FINALIZATION-MINUTE",
              async () => {
                await monitorAndSyncTracking();
                return await finalizeMonthEndTracking();
              },
              { minute: currentMinute, time: now.toLocaleTimeString() }
            );
            minuteExecutionStatus.set(minuteKey, success.success);

            // Log final execution overview
            const overview = Object.fromEntries(minuteExecutionStatus);
            logger.info(
              { executionOverview: overview },
              "FINALIZATION: Month-end tracking sequence completed. Execution overview logged"
            );
            break; // Exit the loop after finalization
          } else {
            const success = await executeOperation(
              "MONITORING-MINUTE",
              async () => {
                return await monitorAndSyncTracking();
              },
              { minute: currentMinute, time: now.toLocaleTimeString() }
            );
            minuteExecutionStatus.set(minuteKey, success.success);
          }
        }

        // Break if we've passed 59 minutes (in case we missed it)
        if (currentMinute === 0) {
          logger.warn("MONITORING: Entered new hour. Exiting monitoring loop");
          break;
        }

        // Wait 1 second before checking again
        await delay();
      }
    },
    { lastDayOfMonth: now.toDateString() }
  );
}

function delay(ms = 1000) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Monitor active devices every minute and keep tracking consistent
async function monitorAndSyncTracking() {
  const result = await executeOperation("MONITOR-SYNC", async () => {
    const currentActiveDevices = await getActiveDevicesAndTheirUsage();
    const currentActiveDeviceIds = new Set(
      currentActiveDevices.map((d) => d.device_id)
    );

    // Check for devices that are no longer active
    await syncInactiveDevices(currentActiveDeviceIds);

    // Check for newly active devices that aren't being tracked yet
    await syncActiveDevices(currentActiveDevices);

    return { deviceCount: currentActiveDevices.length };
  });

  return result.success;
}

/**
 * @param {Array<{
 *   device_id: string;
 *   alias: string;
 *   usage_record_id: string;
 *   ip_address: string;
 *   consumption: number;
 * }>} currentActiveDevices
 * @description Sync the in-memory active devices() with the database devices
 * @returns {Promise<void>}
 */
async function syncActiveDevices(currentActiveDevices) {
  // Filter to only new devices that aren't already being tracked
  const newDevices = currentActiveDevices.filter(
    (device) => !trackingDevices.has(device.device_id)
  );

  if (newDevices.length === 0) return;

  await executeBatchOperation(
    "SYNC-NEW-DEVICES",
    newDevices,
    async (device) => {
      return await executeDeviceOperation(
        "ADD-TO-TRACKING",
        device,
        async () => {
          const { month_energy } = await getCurrentMonthEnergy(
            device.ip_address
          );

          // First update database flag, then add to memory only if successful
          await updateTrackingFlag(
            device.usage_record_id,
            true,
            `SYNC: Tracking failed for newly detected device - ${device.alias}`
          );

          // Only add to in-memory tracking if database update succeeded
          trackingDevices.set(device.device_id, {
            device_id: device.device_id,
            alias: device.alias,
            usage_record_id: device.usage_record_id,
            ip_address: device.ip_address,
            consumption: device.consumption,
            month_energy: month_energy,
          });
        }
      );
    }
  );
}

/**
 * @param {Set<string>} currentActiveDeviceIds
 * @description Sync the in-memory active devices() with the database devices
 */
async function syncInactiveDevices(currentActiveDeviceIds) {
  const trackedDevicesArray = Array.from(trackingDevices.entries()).map(
    ([deviceId, trackedData]) => ({ deviceId, ...trackedData })
  );

  await executeBatchOperation(
    "SYNC-TRACKED-DEVICES",
    trackedDevicesArray,
    async (trackedDevice) => {
      const { deviceId } = trackedDevice;

      if (!currentActiveDeviceIds.has(deviceId)) {
        // Device is no longer active - remove from tracking
        return await executeDeviceOperation(
          "REMOVE-FROM-TRACKING",
          trackedDevice,
          async () => {
            // First update database flag, then remove from memory only if successful
            await updateTrackingFlag(
              trackedDevice.usage_record_id,
              false,
              `MONITORING: Failed to stop tracking device - ${trackedDevice.alias}`
            );

            // Only remove from in-memory tracking if database update succeeded
            trackingDevices.delete(deviceId);
          }
        );
      } else {
        // Device is still active - update month_energy
        return await executeDeviceOperation(
          "UPDATE-MONTH-ENERGY",
          trackedDevice,
          async () => {
            const { month_energy } = await getCurrentMonthEnergy(
              trackedDevice.ip_address
            );
            trackingDevices.set(deviceId, {
              ...trackedDevice,
              month_energy: month_energy,
            });
          }
        );
      }
    }
  );
}

// Final processing at 11:59 PM
async function finalizeMonthEndTracking() {
  const trackedDevicesArray = Array.from(trackingDevices.entries()).map(
    ([deviceId, trackedData]) => ({ deviceId, ...trackedData })
  );

  const batchResult = await executeBatchOperation(
    "FINALIZE-MONTH-END",
    trackedDevicesArray,
    async (trackedDevice) => {
      return await executeDeviceOperation(
        "STORE-ACCUMULATED-VALUE",
        trackedDevice,
        async () => {
          const finalMonthEnergy = trackedDevice.month_energy;
          const accumulatedValue = finalMonthEnergy - trackedDevice.consumption;

          await storePreviousMonthAccumulated(
            trackedDevice.usage_record_id,
            accumulatedValue
          );
        }
      );
    }
  );

  // Clear memory
  trackingDevices.clear();

  if (batchResult.hasErrors) {
    logger.warn(
      {
        successCount: batchResult.successCount,
        failureCount: batchResult.failureCount,
      },
      "FINAL: Month-end tracking completed with some errors"
    );
    return false;
  } else {
    logger.info(
      { deviceCount: batchResult.successCount },
      "FINAL: Month-end tracking finalized and cleaned up successfully"
    );
    return true;
  }
}

async function getCurrentMonthEnergy(device_ip_address) {
  let month_energy;

  const result = await executeOperation(
    "API-GET-MONTH-ENERGY",
    async () => {
      const credentials = Buffer.from(
        `${process.env.URJ_FSFY_API_USER}:${process.env.URJ_FSFY_API_PWD}`
      ).toString("base64");
      const response = await fetch(
        `${process.env.URJ_FSFY_API}/usage/${device_ip_address}`,
        {
          method: "GET",
          headers: {
            "Content-Type": "application/json",
            "x-forwarded-authybasic": `Basic ${credentials}`,
          },
        }
      );
      const data = await response.json();
      month_energy = data.usage.month_energy;
    },
    { deviceIpAddress: device_ip_address }
  );

  if (!result.success) {
    throw new Error(
      `Failed to get month energy for device ${device_ip_address}`
    );
  }

  return { month_energy };
}

// --- Schedule the Single Cron Job ---

// Single cron job - runs every day at 11:55 PM and handles all month-end logic with setTimeout
cron.schedule(
  "55 23 * * *",
  () => {
    logger.info("CRON: Running scheduled task - Month-End Checker");
    checkAndPollTapoDevices().catch((error) => {
      logger.error({ error }, "CRON: Error in scheduled task");
    });
  },
  {
    timezone: TIMEZONE,
  }
);

// Keep the Node.js process alive
process.on("SIGINT", () => {
  logger.info("SHUTDOWN: Cron job script terminated via SIGINT");
  process.exit(0);
});
process.on("SIGTERM", () => {
  logger.info("SHUTDOWN: Cron job script terminated via SIGTERM");
  process.exit(0);
});
