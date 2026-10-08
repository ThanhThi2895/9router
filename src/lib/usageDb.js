// Shim → re-export from new SQLite-based DB layer (src/lib/db/)
export {
  statsEmitter, trackPendingRequest, getActiveRequests,
  saveRequestUsage, getUsageHistory, getUsageStats, getChartData,
  appendRequestLog, getRecentLogs,
  saveRequestDetail, getRequestDetails, getRequestDetailById,
  recordUnresolvedModelEvent, flushUnresolvedModels, getUnresolvedModels,
  setUnresolvedModelResolved, deleteUnresolvedModel, clearUnresolvedModels,
} from "@/lib/db/index.js";
