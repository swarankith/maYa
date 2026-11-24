import { useState } from 'react';
import { ArrowRight, Check, CheckCheck, Info, ShieldCheck, X } from 'lucide-react';
import type { WorkspaceApi } from '../api/client.ts';
import type { ApprovalItem, WorkspaceMode } from '../types/maya.ts';
import { formatTimestamp } from '../utils/format.ts';
import { PermissionMarker } from '../components/FactMarker.tsx';

interface ApprovalsPageProps {
  mode: WorkspaceMode;
  workspaceApi: WorkspaceApi;
  approvals: ApprovalItem[];
  onRefresh: () => Promise<void>;
  onGoToSimulator: () => void;
  onGoToAudit: () => void;
}

export function ApprovalsPage({
  mode,
  workspaceApi,
  approvals,
  onRefresh,
  onGoToSimulator,
  onGoToAudit,
}: ApprovalsPageProps) {
  const [filter, setFilter] = useState<'ALL' | 'PENDING' | 'APPROVED' | 'REJECTED'>('ALL');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [batchBusy, setBatchBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pendingItems = approvals.filter((a) => a.status === 'PENDING');
  const filtered = approvals.filter((a) => (filter === 'ALL' ? true : a.status === filter));

  const handleApprove = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await workspaceApi.approveAction(id);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Approval execution failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleReject = async (id: string) => {
    setBusyId(id);
    setError(null);
    try {
      await workspaceApi.rejectAction(id);
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Rejection failed');
    } finally {
      setBusyId(null);
    }
  };

  const handleApproveAll = async () => {
    setBatchBusy(true);
    setError(null);
    try {
      await workspaceApi.approveAllPending();
      await onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Batch approval failed');
    } finally {
      setBatchBusy(false);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">
            Controlled Execution &amp; Human Approvals
          </h2>
          <p className="text-xs text-slate-400">
            No changes execute automatically. Every write is validated against policy and requires
            explicit user approval.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {pendingItems.length > 0 && (
            <button
              type="button"
              onClick={handleApproveAll}
              disabled={batchBusy}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-teal-600 hover:bg-teal-500 text-white transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <CheckCheck className="h-3.5 w-3.5" />
              <span>
                {batchBusy ? 'Executing Approved...' : `Approve All Pending (${pendingItems.length})`}
              </span>
            </button>
          )}
          <button
            type="button"
            onClick={onGoToAudit}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <span>View Audit Trail</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="rounded-xl border border-blue-500/30 bg-blue-500/10 p-4 flex items-start gap-3 text-xs text-blue-100">
        <Info className="h-4 w-4 text-blue-400 shrink-0 mt-0.5" />
        <div className="space-y-1">
          <div className="font-semibold text-blue-200">
            {mode === 'DEMO'
              ? 'Execution Mode: Isolated DEMO MODE (External Google APIs Disconnected)'
              : 'Execution Mode: Private Personal Workspace (External Google APIs Disconnected)'}
          </div>
          <p className="text-blue-200/80 leading-relaxed">
            Approving actions updates your {mode === 'DEMO' ? 'isolated demo' : 'private personal'}{' '}
            SQLite context graph and records an immutable entry in your Audit Trail. External
            Gmail, Calendar, and Tasks APIs remain disconnected.
          </p>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">
          {error}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1 p-1 rounded-lg bg-[#0D1526] border border-slate-800 w-fit">
        {(['ALL', 'PENDING', 'APPROVED', 'REJECTED'] as const).map((tab) => (
          <button
            key={tab}
            type="button"
            onClick={() => setFilter(tab)}
            className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
              filter === tab ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
            }`}
          >
            {tab === 'ALL'
              ? `All (${approvals.length})`
              : `${tab.charAt(0) + tab.slice(1).toLowerCase()} (${
                  approvals.filter((a) => a.status === tab).length
                })`}
          </button>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-xl border border-slate-800/80 bg-[#0D1526] p-10 text-center space-y-3">
          <ShieldCheck className="h-8 w-8 text-slate-600 mx-auto" />
          <h3 className="text-sm font-semibold text-slate-200">
            {approvals.length === 0
              ? 'No Staged Actions in Approval Queue'
              : 'No Actions Match This Filter'}
          </h3>
          <p className="text-xs text-slate-400 max-w-md mx-auto">
            Select a strategy in the What-if Simulator to stage exact proposed updates here for
            permission validation and approval.
          </p>
          {approvals.length === 0 && (
            <button
              type="button"
              onClick={onGoToSimulator}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white"
            >
              <span>Open What-if Simulator</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      ) : (
        <div className="space-y-3">
          {filtered.map((item) => {
            const isPending = item.status === 'PENDING';
            const isBusy = busyId === item.id;
            return (
              <article
                key={item.id}
                className="rounded-xl border border-slate-800/80 bg-[#0D1526] p-5 space-y-4"
              >
                <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                  <div className="space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                      <span className="font-mono text-blue-300">
                        Option {item.optionKey} · {item.actionType}
                      </span>
                      <span aria-hidden="true">·</span>
                      <span className="font-mono">{item.permissionScope}</span>
                      <span aria-hidden="true">·</span>
                      <span
                        className={
                          item.status === 'APPROVED'
                            ? 'text-teal-400 font-medium'
                            : item.status === 'REJECTED'
                              ? 'text-rose-400 font-medium'
                              : 'text-amber-300 font-medium'
                        }
                      >
                        {item.status === 'APPROVED'
                          ? 'Executed'
                          : item.status === 'REJECTED'
                            ? 'Rejected'
                            : 'Awaiting Approval'}
                      </span>
                    </div>
                    <h3 className="text-base font-medium text-slate-100">{item.targetLabel}</h3>
                    <p className="text-xs text-slate-400">{item.rationale}</p>
                  </div>

                  <div className="flex flex-col sm:items-end gap-2 shrink-0">
                    <PermissionMarker
                      valid={item.permissionValid}
                      executionMode={item.executionMode}
                    />
                    {isPending ? (
                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          onClick={() => handleReject(item.id)}
                          disabled={isBusy || batchBusy}
                          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 transition-colors disabled:opacity-50"
                        >
                          <X className="h-3.5 w-3.5" />
                          <span>Reject</span>
                        </button>
                        <button
                          type="button"
                          onClick={() => handleApprove(item.id)}
                          disabled={isBusy || batchBusy || !item.permissionValid}
                          className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-teal-600 hover:bg-teal-500 text-white transition-colors disabled:opacity-50"
                        >
                          <Check className="h-3.5 w-3.5" />
                          <span>{isBusy ? 'Executing...' : 'Approve & Execute'}</span>
                        </button>
                      </div>
                    ) : (
                      <span className="text-[11px] font-mono tabular-nums text-slate-500">
                        Decided: {item.decidedAt ? formatTimestamp(item.decidedAt) : '—'}
                      </span>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2 border-t border-slate-800/70">
                  <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
                    <div className="text-[11px] text-slate-500 mb-1">Before State</div>
                    <div className="text-xs font-mono text-slate-300 break-all">
                      {Object.entries(item.beforeState)
                        .map(([k, v]) => `${k}: ${String(v)}`)
                        .join(' · ')}
                    </div>
                  </div>
                  <div className="rounded-lg border border-teal-500/30 bg-teal-500/10 p-3">
                    <div className="text-[11px] text-teal-300 mb-1">Proposed After State</div>
                    <div className="text-xs font-mono text-teal-100 break-all">
                      {Object.entries(item.afterState)
                        .map(([k, v]) => `${k}: ${String(v)}`)
                        .join(' · ')}
                    </div>
                  </div>
                </div>

                <div className="text-[11px] text-slate-400">
                  Policy Check: {item.permissionReason}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </div>
  );
}
