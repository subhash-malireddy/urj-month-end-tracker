import cron from "node-cron";
import { logger, logSeparator } from "./utils/logger.js";
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
  try {
    logger.info(
      "TRACKING SETUP: Setting up time-based monitoring and finalization"
    );

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
          !minuteExecutionStatus.has(minuteKey) ||
          minuteExecutionStatus.get(minuteKey) === false
        ) {
          if (currentMinute === 59) {
            logger.info(
              { minute: currentMinute, time: now.toLocaleTimeString() },
              "FINALIZATION: Running final processing task"
            );
            const success = await finalizeMonthEndTracking();
            minuteExecutionStatus.set(minuteKey, success);

            // Log final execution overview
            const overview = Object.fromEntries(minuteExecutionStatus);
            logger.info(
              { executionOverview: overview },
              "FINALIZATION: Month-end tracking sequence completed. Execution overview logged"
            );
            break; // Exit the loop after finalization
          } else {
            logger.info(
              { minute: currentMinute, time: now.toLocaleTimeString() },
              "MONITORING: Running monitoring task"
            );
            const success = await monitorAndSyncTracking();
            minuteExecutionStatus.set(minuteKey, success);
          }
        }
      }

      // Break if we've passed 59 minutes (in case we missed it)
      if (currentMinute === 0) {
        logger.warn("MONITORING: Entered new hour. Exiting monitoring loop");
        break;
      }

      // Wait 1 second before checking again
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  } catch (error) {
    logger.error({ error }, "MONITORING: Error in monitoring sequence");
  }
}

// // Initialize tracking on the last day of the month
// async function initializeMonthEndTracking() {
//   try {
//     logger.info("INIT: Initializing month-end tracking");
//     const activeDevices = await getActiveDevicesAndTheirUsage();

//     if (!activeDevices || activeDevices.length === 0) {
//       logger.warn("INIT: No active devices found");
//       return;
//     }

//     // Clear any existing tracking data
//     trackingDevices.clear();

//     // Get current month energy for all active devices and store in memory
//     for (const device of activeDevices) {
//       try {
//         const { month_energy } = await getCurrentMonthEnergy(device);
//         trackingDevices.set(device.device_id, {
//           device_id: device.device_id,
//           alias: device.alias,
//           usage_record_id: device.usage_record_id,
//           ip_address: device.ip_address,
//           consumption: device.consumption,
//           month_energy: month_energy,
//         });

//         // Set tracking flag to true
//         await updateTrackingFlag(
//           device.usage_record_id,
//           true,
//           `INIT: Tracking failed for device - ${device.alias}`
//         );

//         logger.info(
//           {
//             deviceId: device.device_id,
//             ipAddress: device.ip_address,
//             alias: device.alias,
//           },
//           "INIT: Started tracking device"
//         );
//       } catch (error) {
//         logger.error(
//           { deviceId: device.device_id, error },
//           "INIT: Error initializing tracking for device"
//         );
//       }
//     }

//     logger.info(
//       { deviceCount: trackingDevices.size },
//       "INIT: Initialized tracking for devices"
//     );
//   } catch (error) {
//     logger.error({ error }, "INIT: Error initializing month-end tracking");
//   }
// }

// Monitor active devices every minute and keep tracking consistent
async function monitorAndSyncTracking() {
  try {
    logger.info("SYNC: Monitoring and syncing tracking data");
    const currentActiveDevices = await getActiveDevicesAndTheirUsage();
    const currentActiveDeviceIds = new Set(
      currentActiveDevices.map((d) => d.device_id)
    );

    // Check for devices that are no longer active
    await syncInactiveDevices(currentActiveDeviceIds);

    // Check for newly active devices that aren't being tracked yet
    for (const device of currentActiveDevices) {
      if (!trackingDevices.has(device.device_id)) {
        try {
          logger.info(
            { deviceId: device.device_id, alias: device.alias },
            "SYNC: New active device detected, adding to tracking"
          );

          const { month_energy } = await getCurrentMonthEnergy(
            device.ip_address
          );

          await updateTrackingFlag(
            device.usage_record_id,
            true,
            `SYNC: Tracking failed for newly detected device - ${device.alias}`
          );

          trackingDevices.set(device.device_id, {
            device_id: device.device_id,
            alias: device.alias,
            usage_record_id: device.usage_record_id,
            ip_address: device.ip_address,
            consumption: device.consumption,
            month_energy: month_energy,
          });

          logger.info(
            { deviceId: device.device_id, alias: device.alias },
            "SYNC: Successfully added new device to tracking"
          );
        } catch (error) {
          logger.error(
            { deviceId: device.device_id, error },
            "SYNC: Error adding new device to tracking"
          );
          return false; // Return failure if adding a new device fails
        }
      }
    }

    logger.info("SYNC: Monitoring and syncing completed successfully");
    return true; // Return success
  } catch (error) {
    logger.error({ error }, "SYNC: Error monitoring tracking data");
    return false; // Return failure
  }
}

/**
 * @param {Set<string>} currentActiveDeviceIds
 * @description Sync the in-memory active devices() with the database devices
 */
async function syncInactiveDevices(currentActiveDeviceIds) {
  for (const [deviceId, trackedData] of trackingDevices) {
    if (!currentActiveDeviceIds.has(deviceId)) {
      logger.info(
        { deviceId },
        `SYNC: Device - ${trackedData.alias} is no longer active, removing from tracking`
      );

      await updateTrackingFlag(
        trackedData.usage_record_id,
        false,
        `MONITORING: Failed to stop tracking device - ${trackedData.alias}`
      );

      trackingDevices.delete(deviceId);
    } else {
      const { month_energy } = await getCurrentMonthEnergy(
        trackedData.ip_address
      );
      trackingDevices.set(deviceId, {
        ...trackedData,
        month_energy: month_energy,
      });
    }
  }
}

// Final processing at 11:59 PM
async function finalizeMonthEndTracking() {
  let hasErrors = false;

  try {
    logger.info("FINAL: Finalizing month-end tracking");

    // Get final month energy values for all tracked devices
    for (const [deviceId, trackedData] of trackingDevices) {
      let finalMonthEnergy = trackedData.month_energy;
      try {
        const { month_energy } = await getCurrentMonthEnergy(
          trackedData.ip_address
        );
        finalMonthEnergy = month_energy;
      } catch (error) {
        logger.error(
          { deviceId, error },
          "FINAL: Error getting final month energy, using previously stored value"
        );
        hasErrors = true;
      }

      // Calculate the difference between final and original month_energy
      try {
        const accumulatedValue = finalMonthEnergy - trackedData.consumption;
        // Store the accumulated value
        await storePreviousMonthAccumulated(
          trackedData.usage_record_id,
          accumulatedValue
        );

        logger.info(
          {
            deviceId,
            originalConsumption: trackedData.consumption,
            finalMonthEnergy,
            accumulatedValue,
          },
          "FINAL: Device processing completed"
        );
      } catch (error) {
        logger.error(
          { deviceId, error },
          "FINAL: Error storing accumulated value for device"
        );
        hasErrors = true;
      }
    }

    // Clear memory
    trackingDevices.clear();

    if (hasErrors) {
      logger.warn("FINAL: Month-end tracking completed with some errors");
      return false; // Return failure if any device had errors
    } else {
      logger.info(
        "FINAL: Month-end tracking finalized and cleaned up successfully"
      );
      return true; // Return success
    }
  } catch (error) {
    logger.error({ error }, "FINAL: Error finalizing month-end tracking");
    return false; // Return failure
  }
}

async function getCurrentMonthEnergy(device_ip_address) {
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

  return { month_energy: data.usage.month_energy };
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

/**
 * TODO:: Handle the case where the device might be turned on during the final minute
 */
