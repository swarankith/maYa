import { useState } from 'react';
import { AlertTriangle, ArrowRight, CheckCircle2, Play, ShieldAlert } from 'lucide-react';
import type { WorkspaceApi } from '../api/client.ts';
import type { ImpactAnalysisResult, WhatIfPlan, WorkspaceMode } from '../types/maya.ts';
import { formatDisplayDate } from '../utils/format.ts';

interface SimulatorPageProps {
  mode: WorkspaceMode;
  workspaceApi: WorkspaceApi;
  analysis: ImpactAnalysisResult | null;
  plans: WhatIfPlan[];
  demoRunning: boolean;
  onRunDemo: () => void;
  onPlanSelected: () => Promise<void>;
  onGoToApprovals: () => void;
  onGoToImpact: () => void;
}

export function SimulatorPage({
  mode,
  workspaceApi,
  analysis,
  plans,
  demoRunning,
  onRunDemo,
  onPlanSelected,
  onGoToApprovals,
  onGoToImpact,
}: SimulatorPageProps) {
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSelectPlan = async (planId: string) => {
    setSelectingId(planId);
    setError(null);
    try {
      await workspaceApi.selectPlan(planId);
      await onPlanSelected();
      onGoToApprovals();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stage plan for approval');
    } finally {
      setSelectingId(null);
    }
  };

  if (!analysis || plans.length === 0) {
    return (
      <div className="rounded-xl border border-slate-800/80 bg-[#0D1526] p-10 text-center space-y-4">
        <h3 className="text-base font-semibold text-slate-100">What-if Simulator Ready</h3>
        <p className="text-sm text-slate-400 max-w-lg mx-auto">
          Run an impact analysis first so maYa can deterministically generate and conflict-check
          alternative response plans from your active workspace&apos;s tasks, meetings, and
          dependencies.
        </p>
        {mode === 'DEMO' ? (
          <button
            type="button"
            onClick={onRunDemo}
            disabled={demoRunning}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            <Play className="h-4 w-4" />
            <span>{demoRunning ? 'Running Analysis...' : 'Run maYa Demo'}</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={onGoToImpact}
            className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
          >
            <span>Open Impact Lens</span>
            <ArrowRight className="h-4 w-4" />
          </button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">
            What-if Simulator · Response Plan Comparison
          </h2>
          <p className="text-xs text-slate-400">
            Comparing {plans.length} deterministic response strategies for{' '}
            <span className="text-slate-200 font-medium">{analysis.changeEvent.projectTitle}</span>{' '}
            ({formatDisplayDate(analysis.changeEvent.originalValue)} -&gt;{' '}
            {formatDisplayDate(analysis.changeEvent.newValue)}). Selecting a plan stages actions in
            Approvals without executing them.
          </p>
        </div>
        {plans.some((p) => p.status === 'SELECTED') && (
          <button
            type="button"
            onClick={onGoToApprovals}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-amber-600 hover:bg-amber-500 text-white transition-colors whitespace-nowrap shrink-0"
          >
            <span>Open Approval Queue</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {error && (
        <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-4 py-3 text-xs text-rose-300">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
        {plans.map((plan) => {
          const isSelected = plan.status === 'SELECTED';
          return (
            <section
              key={plan.id}
              className={`rounded-xl border p-6 flex flex-col justify-between space-y-5 transition-colors ${
                isSelected
                  ? 'border-teal-500/60 bg-[#0D192B]'
                  : 'border-slate-800/80 bg-[#0D1526]'
              }`}
            >
              <div className="space-y-5">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-xs font-mono text-blue-400">
                      STRATEGY OPTION {plan.optionKey}
                    </span>
                    <span
                      className={`text-xs font-medium ${
                        isSelected
                          ? 'text-teal-400'
                          : plan.status === 'DISCARDED'
                            ? 'text-slate-500'
                            : 'text-slate-400'
                      }`}
                    >
                      {isSelected
                        ? 'Selected for Approval'
                        : plan.status === 'DISCARDED'
                          ? 'Alternative Not Selected'
                          : 'Ready to Compare'}
                    </span>
                  </div>
                  <h3 className="text-base font-semibold text-slate-100">{plan.title}</h3>
                  <p className="text-xs text-slate-300 leading-relaxed">{plan.strategySummary}</p>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 space-y-1.5">
                    <div className="text-[11px] font-semibold text-slate-400">
                      Tasks Affected ({plan.tasksAffected.length})
                    </div>
                    {plan.tasksAffected.length === 0 ? (
                      <div className="text-xs text-slate-500">No task date updates</div>
                    ) : (
                      plan.tasksAffected.map((t, idx) => (
                        <div key={`${t.id}-${idx}`} className="text-xs space-y-0.5">
                          <div className="text-slate-200 truncate">{t.title}</div>
                          <div className="font-mono text-[11px] text-teal-300">{t.change}</div>
                        </div>
                      ))
                    )}
                  </div>
                  <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 space-y-1.5">
                    <div className="text-[11px] font-semibold text-slate-400">
                      Meetings Affected ({plan.meetingsAffected.length})
                    </div>
                    {plan.meetingsAffected.length === 0 ? (
                      <div className="text-xs text-slate-500">No meeting changes</div>
                    ) : (
                      plan.meetingsAffected.map((m) => (
                        <div key={m.id} className="text-xs space-y-0.5">
                          <div className="text-slate-200 truncate">{m.title}</div>
                          <div className="font-mono text-[11px] text-violet-300">{m.change}</div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="text-xs font-semibold text-slate-300">
                    Deterministic Conflict Checks
                  </div>
                  {plan.potentialConflicts.map((c, idx) => (
                    <div
                      key={idx}
                      className={`rounded-lg border p-3 text-xs flex items-start gap-2 ${
                        c.severity === 'WARNING'
                          ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                          : 'border-slate-800 bg-slate-900/50 text-slate-300'
                      }`}
                    >
                      <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
                      <span>{c.description}</span>
                    </div>
                  ))}
                </div>

                <div className="space-y-2">
                  <div className="text-xs font-semibold text-slate-300">
                    Proposed Updates ({plan.proposedChanges.length})
                  </div>
                  <div className="divide-y divide-slate-800/70 rounded-lg border border-slate-800 bg-slate-900/40">
                    {plan.proposedChanges.map((chg, idx) => (
                      <div key={idx} className="p-2.5 text-xs space-y-1">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-medium text-slate-200">{chg.targetTitle}</span>
                          <span className="font-mono text-[11px] text-slate-400">
                            {chg.permissionScope}
                          </span>
                        </div>
                        <div className="font-mono text-[11px] text-slate-400">
                          {chg.beforeValue} -&gt;{' '}
                          <span className="text-teal-300">{chg.afterValue}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                  <div className="space-y-1.5">
                    <div className="font-semibold text-teal-400">Advantages</div>
                    <ul className="space-y-1 text-slate-300">
                      {plan.advantages.map((adv, idx) => (
                        <li key={idx} className="flex items-start gap-1.5">
                          <CheckCircle2 className="h-3.5 w-3.5 text-teal-400 shrink-0 mt-0.5" />
                          <span>{adv}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div className="space-y-1.5">
                    <div className="font-semibold text-amber-300">Trade-offs</div>
                    <ul className="space-y-1 text-slate-300">
                      {plan.tradeoffs.map((tr, idx) => (
                        <li key={idx} className="flex items-start gap-1.5">
                          <ShieldAlert className="h-3.5 w-3.5 text-amber-400 shrink-0 mt-0.5" />
                          <span>{tr}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </div>

                <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 space-y-1.5">
                  <div className="text-[11px] font-semibold text-slate-300">
                    Requires Explicit User Confirmation
                  </div>
                  <ul className="space-y-1 text-xs text-slate-400 list-disc list-inside">
                    {plan.requiresUserConfirmation.map((item, idx) => (
                      <li key={idx}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className="pt-2 border-t border-slate-800/80">
                <button
                  type="button"
                  onClick={() => handleSelectPlan(plan.id)}
                  disabled={selectingId !== null}
                  className={`w-full py-2.5 px-4 rounded-lg text-sm font-semibold transition-colors inline-flex items-center justify-center gap-2 ${
                    isSelected
                      ? 'bg-teal-600 hover:bg-teal-500 text-white'
                      : 'bg-blue-600 hover:bg-blue-500 text-white'
                  } disabled:opacity-60`}
                >
                  <span>
                    {selectingId === plan.id
                      ? 'Staging Proposed Actions...'
                      : isSelected
                        ? `Re-stage Option ${plan.optionKey} in Approvals`
                        : `Select Option ${plan.optionKey} & Stage Approvals`}
                  </span>
                  <ArrowRight className="h-4 w-4" />
                </button>
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
