import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Search } from 'lucide-react';
import type { AuditLogEntry } from '../types/maya.ts';
import { formatTimestamp } from '../utils/format.ts';

interface AuditTrailPageProps {
  logs: AuditLogEntry[];
}

export function AuditTrailPage({ logs }: AuditTrailPageProps) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'ALL' | AuditLogEntry['status']>('ALL');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return logs.filter((log) => {
      if (statusFilter !== 'ALL' && log.status !== statusFilter) return false;
      if (
        q &&
        !log.targetLabel.toLowerCase().includes(q) &&
        !log.summary.toLowerCase().includes(q) &&
        !log.actionType.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [logs, search, statusFilter]);

  const statusColor = (status: AuditLogEntry['status']) => {
    switch (status) {
      case 'EXECUTED_SIMULATED':
        return 'text-teal-400';
      case 'REJECTED':
        return 'text-rose-400';
      case 'DETECTED':
        return 'text-amber-300';
      case 'SIMULATED_PLAN':
        return 'text-blue-300';
      default:
        return 'text-slate-400';
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Immutable Audit Trail</h2>
          <p className="text-xs text-slate-400">
            Complete history of change detections, simulated plans, user approvals, rejections,
            and execution records.
          </p>
        </div>
        <span className="text-xs font-mono tabular-nums text-slate-400">
          {filtered.length} of {logs.length} entries
        </span>
      </div>

      {/* Filters */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-3">
        <div className="relative max-w-sm w-full">
          <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search audit target, action, or summary..."
            className="w-full rounded-lg border border-slate-700/80 bg-[#0D1526] pl-9 pr-3 py-2 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1 p-1 rounded-lg bg-[#0D1526] border border-slate-800">
          {(
            [
              { key: 'ALL', label: 'All' },
              { key: 'EXECUTED_SIMULATED', label: 'Executed (Simulated)' },
              { key: 'REJECTED', label: 'Rejected' },
              { key: 'DETECTED', label: 'Detected' },
              { key: 'SIMULATED_PLAN', label: 'Plans' },
            ] as const
          ).map((tab) => (
            <button
              key={tab.key}
              type="button"
              onClick={() => setStatusFilter(tab.key)}
              className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                statusFilter === tab.key
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Audit Table */}
      <div className="rounded-xl border border-slate-800/80 bg-[#0D1526] overflow-hidden">
        {filtered.length === 0 ? (
          <div className="p-10 text-center text-xs text-slate-400">
            No audit records match your current filter.
          </div>
        ) : (
          <div className="divide-y divide-slate-800/70">
            {filtered.map((entry) => {
              const isExpanded = expandedId === entry.id;
              return (
                <div key={entry.id} className="hover:bg-slate-900/40 transition-colors">
                  <button
                    type="button"
                    onClick={() => setExpandedId(isExpanded ? null : entry.id)}
                    className="w-full px-5 py-3.5 text-left flex flex-col lg:flex-row lg:items-center justify-between gap-3"
                  >
                    <div className="flex items-start gap-3 min-w-0">
                      {isExpanded ? (
                        <ChevronDown className="h-4 w-4 text-slate-400 shrink-0 mt-0.5" />
                      ) : (
                        <ChevronRight className="h-4 w-4 text-slate-500 shrink-0 mt-0.5" />
                      )}
                      <div className="min-w-0 space-y-1">
                        <div className="flex flex-wrap items-center gap-2 text-xs">
                          <span className={`font-medium ${statusColor(entry.status)}`}>
                            {entry.status}
                          </span>
                          <span aria-hidden="true" className="text-slate-600">
                            ·
                          </span>
                          <span className="font-mono text-slate-300">{entry.actionType}</span>
                          <span aria-hidden="true" className="text-slate-600">
                            ·
                          </span>
                          <span className="text-slate-400">{entry.executionMode}</span>
                        </div>
                        <div className="text-sm font-medium text-slate-100 truncate">
                          {entry.targetLabel}
                        </div>
                        <p className="text-xs text-slate-400 line-clamp-2">{entry.summary}</p>
                      </div>
                    </div>

                    <div className="lg:text-right shrink-0 pl-7 lg:pl-0 space-y-0.5">
                      <div className="text-xs font-mono tabular-nums text-slate-300">
                        {formatTimestamp(entry.timestamp)}
                      </div>
                      <div className="text-[11px] text-slate-500">{entry.actor}</div>
                    </div>
                  </button>

                  {isExpanded && (
                    <div className="px-12 pb-4">
                      <div className="rounded-lg border border-slate-800 bg-slate-950/70 p-3 text-xs font-mono text-slate-300 overflow-x-auto">
                        <pre className="whitespace-pre-wrap break-words">
                          {JSON.stringify(entry.details, null, 2)}
                        </pre>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
