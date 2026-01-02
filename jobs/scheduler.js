// jobs/scheduler.js
// Job nền đơn giản để kiểm tra hệ thống có chạy background jobs hay không.
// Không phụ thuộc sàn, không phụ thuộc DB. Chỉ log ra mỗi JOBS_INTERVAL_SECONDS.

function startScheduler() {
  const enabled = (process.env.ENABLE_JOBS || "false").toLowerCase() === "true";
  const intervalSeconds = Number(process.env.JOBS_INTERVAL_SECONDS || "60");

  if (!enabled) {
    console.log("[SCHEDULER] ENABLE_JOBS=false → Scheduler is disabled.");
    return;
  }

  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 10) {
    console.log("[SCHEDULER] Invalid JOBS_INTERVAL_SECONDS. Use >= 10. Current:", intervalSeconds);
    return;
  }

  console.log(`[SCHEDULER] Scheduler enabled. Interval: ${intervalSeconds}s`);

  setInterval(() => {
    const now = new Date().toISOString();
    console.log(`[SCHEDULER] HEARTBEAT at ${now}`);
  }, intervalSeconds * 1000);
}

export { startScheduler };

