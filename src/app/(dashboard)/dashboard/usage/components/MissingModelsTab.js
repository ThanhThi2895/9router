"use client";

import { useState, useEffect, useCallback } from "react";
import Card from "@/shared/components/Card";
import Button from "@/shared/components/Button";
import Pagination from "@/shared/components/Pagination";
import { cn } from "@/shared/utils/cn";

const REASONS = [
  { value: "", label: "All reasons" },
  { value: "missing_model", label: "Missing model" },
  { value: "invalid_model_format", label: "Invalid format" },
  { value: "no_credentials", label: "No credentials" },
  { value: "upstream_model_not_found", label: "Upstream not found (404)" },
];

function getReasonBadge(reason) {
  switch (reason) {
    case "missing_model":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-500/10 text-amber-600 dark:text-amber-400">
          Missing model
        </span>
      );
    case "invalid_model_format":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-purple-500/10 text-purple-600 dark:text-purple-400">
          Invalid format
        </span>
      );
    case "no_credentials":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-500/10 text-orange-600 dark:text-orange-400">
          No credentials
        </span>
      );
    case "upstream_model_not_found":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-500/10 text-red-600 dark:text-red-400">
          Upstream 404
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-neutral-500/10 text-neutral-600 dark:text-neutral-400">
          {reason || "Unknown"}
        </span>
      );
  }
}

export default function MissingModelsTab() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [actionLoading, setActionLoading] = useState(null);

  const [reasonFilter, setReasonFilter] = useState("");
  const [includeResolved, setIncludeResolved] = useState(false);

  const [currentPage, setCurrentPage] = useState(1);
  const [pageSize, setPageSize] = useState(20);
  const [totalItems, setTotalItems] = useState(0);

  const fetchItems = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        page: String(currentPage),
        pageSize: String(pageSize),
        includeResolved: String(includeResolved),
      });
      if (reasonFilter) params.set("reason", reasonFilter);

      const res = await fetch(`/api/usage/missing-models?${params.toString()}`);
      if (!res.ok) {
        throw new Error(`Failed to load data (${res.status})`);
      }
      const data = await res.json();
      setItems(data.items || []);
      setTotalItems(data.pagination?.totalItems || 0);
    } catch (err) {
      setError(err.message || "Failed to load missing model logs");
    } finally {
      setLoading(false);
    }
  }, [currentPage, pageSize, reasonFilter, includeResolved]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  const handleToggleResolved = async (item) => {
    const nextState = !item.resolved;
    setActionLoading(item.id);
    try {
      const res = await fetch("/api/usage/missing-models", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: item.id, resolved: nextState }),
      });
      if (!res.ok) throw new Error("Failed to update status");
      await fetchItems();
    } catch (err) {
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm("Delete this missing model record?")) return;
    setActionLoading(id);
    try {
      const res = await fetch(`/api/usage/missing-models?id=${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to delete record");
      await fetchItems();
    } catch (err) {
      alert(err.message);
    } finally {
      setActionLoading(null);
    }
  };

  const handleClearAll = async () => {
    if (!window.confirm("Delete ALL missing model records, including resolved ones and every reason (not only the current filter)?")) return;
    setLoading(true);
    try {
      const res = await fetch("/api/usage/missing-models", {
        method: "DELETE",
      });
      if (!res.ok) throw new Error("Failed to clear records");
      // Changing the page re-triggers the fetch effect; refetch directly only when already on page 1.
      if (currentPage !== 1) setCurrentPage(1);
      else await fetchItems();
    } catch (err) {
      alert(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Filters and actions bar */}
      <Card padding="sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex flex-wrap items-center gap-3">
            <div className="min-w-[180px]">
              <select
                value={reasonFilter}
                onChange={(e) => {
                  setReasonFilter(e.target.value);
                  setCurrentPage(1);
                }}
                className={cn(
                  "h-9 px-3 rounded-lg border border-black/10 dark:border-white/10 bg-surface",
                  "w-full text-sm text-text-main focus:outline-none focus:ring-2 focus:ring-primary/20"
                )}
              >
                {REASONS.map((r) => (
                  <option key={r.value} value={r.value}>
                    {r.label}
                  </option>
                ))}
              </select>
            </div>

            <label className="flex items-center gap-2 text-sm text-text-main cursor-pointer select-none">
              <input
                type="checkbox"
                checked={includeResolved}
                onChange={(e) => {
                  setIncludeResolved(e.target.checked);
                  setCurrentPage(1);
                }}
                className="rounded border-black/20 dark:border-white/20 text-primary focus:ring-primary/20"
              />
              <span>Show resolved</span>
            </label>
          </div>

          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={fetchItems}
              disabled={loading}
              className="flex items-center gap-1.5"
            >
              <span className={cn("material-symbols-outlined text-[16px]", loading && "animate-spin")}>
                refresh
              </span>
              <span>Refresh</span>
            </Button>

            <Button
              variant="ghost"
              size="sm"
              onClick={handleClearAll}
              disabled={loading}
              className="text-red-600 hover:text-red-700 hover:bg-red-500/10 flex items-center gap-1.5"
            >
              <span className="material-symbols-outlined text-[16px]">delete_sweep</span>
              <span>Clear all</span>
            </Button>
          </div>
        </div>
      </Card>

      {/* Table */}
      <Card padding="none">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[960px]">
            <thead>
              <tr className="border-b border-black/5 dark:border-white/5">
                <th className="text-left p-4 text-sm font-semibold text-text-main">Model</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Reason</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Provider</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Endpoint</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">Hits</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">First seen</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Last seen</th>
                <th className="text-left p-4 text-sm font-semibold text-text-main">Last error</th>
                <th className="text-right p-4 text-sm font-semibold text-text-main">Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan="9" className="p-8 text-center text-text-muted">
                    <div className="flex items-center justify-center gap-2">
                      <span className="material-symbols-outlined animate-spin text-[20px]">
                        progress_activity
                      </span>
                      <span>Loading missing models...</span>
                    </div>
                  </td>
                </tr>
              ) : error ? (
                <tr>
                  <td colSpan="9" className="p-8 text-center text-red-500">
                    {error}
                  </td>
                </tr>
              ) : items.length === 0 ? (
                <tr>
                  <td colSpan="9" className="p-8 text-center text-text-muted">
                    No missing model requests recorded
                  </td>
                </tr>
              ) : (
                items.map((item) => (
                  <tr
                    key={item.id}
                    className={cn(
                      "border-b border-black/5 dark:border-white/5 last:border-b-0 hover:bg-black/[0.02] dark:hover:bg-white/[0.02] transition-colors",
                      item.resolved && "opacity-60 bg-black/[0.01] dark:bg-white/[0.01]"
                    )}
                  >
                    <td className="p-4 font-mono text-sm text-text-main max-w-[220px] truncate" title={item.requestedModel || "(empty)"}>
                      {item.requestedModel ? (
                        <span>{item.requestedModel}</span>
                      ) : (
                        <span className="text-text-muted italic">(empty)</span>
                      )}
                    </td>

                    <td className="p-4 text-sm whitespace-nowrap">
                      {getReasonBadge(item.reason)}
                    </td>

                    <td className="p-4 text-sm text-text-main whitespace-nowrap">
                      {item.provider || "—"}
                    </td>

                    <td className="p-4 font-mono text-xs text-text-muted whitespace-nowrap">
                      {item.endpoint || "—"}
                    </td>

                    <td className="p-4 text-sm text-right font-mono text-text-main whitespace-nowrap">
                      {Number(item.count || 0).toLocaleString()}
                    </td>

                    <td className="p-4 text-xs text-text-muted whitespace-nowrap">
                      {new Date(item.firstSeen).toLocaleString()}
                    </td>

                    <td className="p-4 text-xs text-text-muted whitespace-nowrap">
                      {new Date(item.lastSeen).toLocaleString()}
                    </td>

                    <td className="p-4 text-xs text-text-muted max-w-[200px] truncate" title={item.lastError || ""}>
                      {item.lastError || "—"}
                    </td>

                    <td className="p-4 text-sm text-right whitespace-nowrap">
                      <div className="flex items-center justify-end gap-1.5">
                        <Button
                          variant={item.resolved ? "ghost" : "outline"}
                          size="sm"
                          onClick={() => handleToggleResolved(item)}
                          disabled={actionLoading === item.id}
                          className="h-7 px-2 text-xs"
                        >
                          {item.resolved ? "Unresolve" : "Mark resolved"}
                        </Button>

                        <button
                          type="button"
                          onClick={() => handleDelete(item.id)}
                          disabled={actionLoading === item.id}
                          className="p-1 rounded text-text-muted hover:text-red-600 hover:bg-red-500/10 transition-colors"
                          title="Delete"
                          aria-label="Delete entry"
                        >
                          <span className="material-symbols-outlined text-[18px]">delete</span>
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        {totalItems > 0 && (
          <div className="border-t border-black/5 dark:border-white/5">
            <Pagination
              currentPage={currentPage}
              pageSize={pageSize}
              totalItems={totalItems}
              onPageChange={setCurrentPage}
              onPageSizeChange={(newSize) => {
                setPageSize(newSize);
                setCurrentPage(1);
              }}
            />
          </div>
        )}
      </Card>
    </div>
  );
}
