import { useEffect, useState } from 'react';
import {
  ArrowRight,
  CalendarClock,
  FileSearch,
  GitFork,
  Mail,
  Play,
  Send,
  Sparkles,
} from 'lucide-react';
import type { WorkspaceApi } from '../api/client.ts';
import type {
  ContextNode,
  ImpactAnalysisResult,
  ImpactedItem,
  SourceRecord,
  WorkspaceMode,
} from '../types/maya.ts';
import { formatDisplayDate, formatTimestamp } from '../utils/format.ts';
import { FactMarker, SeverityMarker } from '../components/FactMarker.tsx';

interface ImpactLensPageProps {
  mode: WorkspaceMode;
  workspaceApi: WorkspaceApi;
  analysis: ImpactAnalysisResult | null;
  sourceRecords: SourceRecord[];
  projects: ContextNode[];
  demoRunning: boolean;
  onRunDemo: () => void;
  onAnalysisCreated: () => Promise<void>;
  onGoToSimulator: () => void;
  onGoToGraph: () => void;
}

export function ImpactLensPage({
  mode,
  workspaceApi,
  analysis,
  sourceRecords,
  projects,
  demoRunning,
  onRunDemo,
  onAnalysisCreated,
  onGoToSimulator,
  onGoToGraph,
}: ImpactLensPageProps) {
  const [bucket, setBucket] = useState<'ALL' | 'DIRECT' | 'DOWNSTREAM' | 'UNAFFECTED'>('ALL');
  const [activeTool, setActiveTool] = useState<'NONE' | 'DIRECT_SHIFT' | 'MESSAGE_SIGNAL'>('NONE');

  // Direct Deadline Shift state
  const [shiftProjectId, setShiftProjectId] = useState(projects[0]?.id ?? '');
  const [shiftDate, setShiftDate] = useState('2026-11-25T17:00');
  const [shiftReason, setShiftReason] = useState('Deadline moved earlier by stakeholder request.');

  // Message Signal state
  const [customTitle, setCustomTitle] = useState('');
  const [customContent, setCustomContent] = useState('');
  const [customProjectId, setCustomProjectId] = useState(projects[0]?.id ?? '');

  const [submitting, setSubmitting] = useState(false);
  const [customError, setCustomError] = useState<string | null>(null);

  useEffect(() => {
    if (projects.length > 0) {
      setShiftProjectId((prev) =>
        projects.some((p) => p.id === prev) ? prev : projects[0].id,
      );
      setCustomProjectId((prev) =>
        projects.some((p) => p.id === prev) ? prev : projects[0].id,
      );
    } else {
      setShiftProjectId('');
      setCustomProjectId('');
    }
  }, [projects]);

  const handleAnalyzeCustom = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setCustomError(null);
    try {
      await workspaceApi.analyzeCustomMessage({
        sender: 'Workspace Signal <update@local.maya>',
        title: customTitle,
        content: customContent,
        projectId: customProjectId || undefined,
      });
      setActiveTool('NONE');
      setCustomTitle('');
      setCustomContent('');
      await onAnalysisCreated();
    } catch (err) {
      setCustomError(err instanceof Error ? err.message : 'Failed to analyze message');
    } finally {
      setSubmitting(false);
    }
  };

  const handleRunDirectShift = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!shiftProjectId) return;
    setSubmitting(true);
    setCustomError(null);
    try {
      await workspaceApi.runProjectImpact({
        projectId: shiftProjectId,
        newDate: shiftDate,
        reason: shiftReason,
      });
      setActiveTool('NONE');
      await onAnalysisCreated();
    } catch (err) {
      setCustomError(err instanceof Error ? err.message : 'Failed to run impact analysis');
    } finally {
      setSubmitting(false);
    }
  };

  const incomingSource = analysis
    ? sourceRecords.find((s) => s.id === analysis.changeEvent.sourceRecordId)
    : null;

  const renderImpactList = (items: ImpactedItem[], heading: string, description: string) => {
    if (items.length === 0) return null;
    return (
      <section className="space-y-3">
        <div className="flex flex-col sm:flex-row sm:items-baseline sm:justify-between gap-1">
          <h3 className="text-sm font-semibold text-slate-100">
            {heading} ({items.length})
          </h3>
          <span className="text-xs text-slate-400">{description}</span>
        </div>

        <div className="space-y-3">
          {items.map((item) => (
            <article
              key={`${item.category}-${item.nodeId}`}
              className="rounded-xl border border-slate-800/80 bg-[#0D1526] p-4 space-y-3"
            >
              <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-2">
                <div className="space-y-1">
                  <div className="flex flex-wrap items-center gap-2 text-xs text-slate-400">
                    <span className="font-mono text-blue-300">{item.nodeType}</span>
                    <span aria-hidden="true">·</span>
                    <span>{item.status}</span>
                    {item.currentDate && (
                      <>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono tabular-nums text-slate-200">
                          {formatDisplayDate(item.currentDate)}
                        </span>
                      </>
                    )}
                  </div>
                  <h4 className="text-base font-medium text-slate-100">{item.title}</h4>
                </div>

                <div className="flex flex-wrap items-center gap-4 shrink-0">
                  <SeverityMarker severity={item.severity} />
                  <FactMarker status={item.factStatus} />
                </div>
              </div>

              <div className="text-sm text-slate-300 leading-relaxed">{item.reason}</div>

              <div className="pt-2 border-t border-slate-800/70 flex flex-col gap-2 text-xs">
                <div className="flex flex-wrap items-center gap-1.5 text-slate-400">
                  <GitFork className="h-3.5 w-3.5 text-teal-400 shrink-0" />
                  <span className="text-slate-500">Graph Path:</span>
                  <span className="font-mono text-slate-300">
                    {item.relationshipPath.join(' -> ')}
                  </span>
                </div>

                {item.supportingEvidence.length > 0 && (
                  <div className="space-y-1">
                    {item.supportingEvidence.map((ev, idx) => (
                      <div
                        key={`${ev.sourceId}-${idx}`}
                        className="rounded-lg border border-slate-800/80 bg-slate-900/50 px-3 py-2 text-xs text-slate-400"
                      >
                        <span className="text-slate-300 font-medium">{ev.sourceTitle}:</span>{' '}
                        {ev.evidenceText}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">
            Ripple Impact Engine &amp; Explainable Intelligence
          </h2>
          <p className="text-xs text-slate-400">
            Deterministic traversal strictly across your active workspace&apos;s stored
            relationships, due dates, and source evidence.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {projects.length > 0 && (
            <>
              <button
                type="button"
                onClick={() =>
                  setActiveTool(activeTool === 'DIRECT_SHIFT' ? 'NONE' : 'DIRECT_SHIFT')
                }
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                <CalendarClock className="h-3.5 w-3.5 text-amber-400" />
                <span>Simulate Deadline Shift</span>
              </button>
              <button
                type="button"
                onClick={() =>
                  setActiveTool(activeTool === 'MESSAGE_SIGNAL' ? 'NONE' : 'MESSAGE_SIGNAL')
                }
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
              >
                <FileSearch className="h-3.5 w-3.5 text-blue-400" />
                <span>Analyze Message Signal</span>
              </button>
            </>
          )}
          {analysis && (
            <button
              type="button"
              onClick={onGoToSimulator}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-teal-600 hover:bg-teal-500 text-white transition-colors whitespace-nowrap shrink-0"
            >
              <span>Compare What-if Plans</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Direct Deadline Shift Form */}
      {activeTool === 'DIRECT_SHIFT' && projects.length > 0 && (
        <form
          onSubmit={handleRunDirectShift}
          className="rounded-xl border border-amber-500/30 bg-[#0D1526] p-5 space-y-4"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-100">
              Test Project Deadline Shift
            </h3>
            <span className="text-xs text-slate-400">
              Runs deterministic graph traversal on selected project
            </span>
          </div>
          {customError && <p className="text-xs text-rose-400">{customError}</p>}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs text-slate-400 mb-1">Project</label>
              <select
                value={shiftProjectId}
                onChange={(e) => setShiftProjectId(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title} (current: {p.date ?? 'unset'})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">
                Revised Deadline (ISO Date/Time)
              </label>
              <input
                type="text"
                required
                value={shiftDate}
                onChange={(e) => setShiftDate(e.target.value)}
                placeholder="2026-11-25T17:00"
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm font-mono text-slate-100"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Change Reason</label>
            <input
              type="text"
              required
              value={shiftReason}
              onChange={(e) => setShiftReason(e.target.value)}
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setActiveTool('NONE')}
              className="px-3 py-2 text-xs text-slate-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
            >
              <Play className="h-3.5 w-3.5" />
              <span>{submitting ? 'Tracing...' : 'Run Ripple Impact Engine'}</span>
            </button>
          </div>
        </form>
      )}

      {/* Custom Message Signal Form */}
      {activeTool === 'MESSAGE_SIGNAL' && projects.length > 0 && (
        <form
          onSubmit={handleAnalyzeCustom}
          className="rounded-xl border border-blue-500/30 bg-[#0D1526] p-5 space-y-4"
        >
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-slate-100">
              Ingest Email / Schedule Signal
            </h3>
            <span className="text-xs text-slate-400">
              Scoped exclusively to your workspace projects
            </span>
          </div>
          {customError && <p className="text-xs text-rose-400">{customError}</p>}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <div className="md:col-span-2">
              <label className="block text-xs text-slate-400 mb-1">Subject / Title</label>
              <input
                type="text"
                required
                value={customTitle}
                onChange={(e) => setCustomTitle(e.target.value)}
                placeholder="e.g., Review moved earlier to Wednesday"
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
              />
            </div>
            <div>
              <label className="block text-xs text-slate-400 mb-1">Target Project</label>
              <select
                value={customProjectId}
                onChange={(e) => setCustomProjectId(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.title}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <label className="block text-xs text-slate-400 mb-1">Message Body</label>
            <textarea
              rows={3}
              required
              value={customContent}
              onChange={(e) => setCustomContent(e.target.value)}
              placeholder="Paste email or calendar update mentioning the revised date..."
              className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setActiveTool('NONE')}
              className="px-3 py-2 text-xs text-slate-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white disabled:opacity-50"
            >
              <Send className="h-3.5 w-3.5" />
              <span>{submitting ? 'Analyzing...' : 'Extract Change & Run Ripple Engine'}</span>
            </button>
          </div>
        </form>
      )}

      {!analysis ? (
        <div className="rounded-xl border border-slate-800/80 bg-[#0D1526] p-10 text-center space-y-4">
          <h3 className="text-base font-semibold text-slate-100">
            {projects.length === 0
              ? 'Create Context First to Run Ripple Impact Analysis'
              : 'No Impact Analysis Run Yet'}
          </h3>
          <p className="text-sm text-slate-400 max-w-lg mx-auto">
            {mode === 'DEMO'
              ? 'Click "Run maYa Demo" to ingest an incoming email moving the AI Research Project deadline from Friday to Wednesday.'
              : projects.length === 0
                ? 'Your personal workspace currently has 0 projects. Add a project, tasks, and deadlines in Context Graph, then return here to trace change consequences.'
                : 'Select "Simulate Deadline Shift" or "Analyze Message Signal" above to trace direct and downstream impacts across your personal workspace.'}
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
          ) : projects.length === 0 ? (
            <button
              type="button"
              onClick={onGoToGraph}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              <span>Build Personal Context Graph</span>
              <ArrowRight className="h-4 w-4" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setActiveTool('DIRECT_SHIFT')}
              className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors"
            >
              <CalendarClock className="h-4 w-4" />
              <span>Simulate Deadline Shift</span>
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
            <section className="lg:col-span-5 rounded-xl border border-slate-800/80 bg-[#0D1526] p-5 space-y-3">
              <div className="flex items-center justify-between text-xs text-slate-400">
                <span className="inline-flex items-center gap-1.5 font-medium text-cyan-300">
                  <Mail className="h-3.5 w-3.5" />
                  <span>Incoming Source Record</span>
                </span>
                <span className="font-mono tabular-nums">
                  {formatTimestamp(analysis.changeEvent.detectedAt)}
                </span>
              </div>
              <div className="text-sm font-semibold text-slate-100">
                {incomingSource?.title ?? analysis.changeEvent.sourceRecordTitle}
              </div>
              {incomingSource && (
                <>
                  <div className="text-xs text-slate-400">From: {incomingSource.sender}</div>
                  <p className="rounded-lg border border-slate-800 bg-slate-900/60 p-3 text-xs text-slate-300 leading-relaxed">
                    {incomingSource.content}
                  </p>
                </>
              )}
              <div className="text-[11px] text-slate-400">
                Extraction: {analysis.changeEvent.extractionConfidenceNote}
              </div>
            </section>

            <section className="lg:col-span-7 rounded-xl border border-slate-800/80 bg-[#0D1526] p-5 flex flex-col justify-between space-y-4">
              <div className="space-y-2">
                <div className="text-xs font-medium text-amber-300">
                  Detected Change · {analysis.changeEvent.projectTitle}
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
                  <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3">
                    <div className="text-[11px] text-slate-400">Original Value</div>
                    <div className="mt-1 text-sm font-mono tabular-nums text-slate-300 line-through">
                      {formatDisplayDate(analysis.changeEvent.originalValue)}
                    </div>
                  </div>
                  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3">
                    <div className="text-[11px] text-amber-300">New Value</div>
                    <div className="mt-1 text-sm font-mono tabular-nums font-semibold text-amber-200">
                      {formatDisplayDate(analysis.changeEvent.newValue)}
                    </div>
                  </div>
                </div>
              </div>

              <div className="space-y-2 border-t border-slate-800/80 pt-3">
                <div className="text-xs font-semibold text-slate-200">
                  Deterministic Traversal Summary
                </div>
                <p className="text-xs text-slate-300 leading-relaxed">
                  {analysis.explanationSummary}
                </p>
                {analysis.aiNarrative && (
                  <div className="rounded-lg border border-violet-500/30 bg-violet-500/10 p-3 text-xs text-violet-200 leading-relaxed flex items-start gap-2">
                    <Sparkles className="h-4 w-4 text-violet-300 shrink-0 mt-0.5" />
                    <div>
                      <span className="font-semibold">Gemini Briefing: </span>
                      {analysis.aiNarrative}
                    </div>
                  </div>
                )}
              </div>
            </section>
          </div>

          <div className="flex flex-wrap items-center gap-1 p-1 rounded-lg bg-[#0D1526] border border-slate-800 w-fit">
            {(
              [
                { key: 'ALL', label: 'All Categories' },
                { key: 'DIRECT', label: `Direct (${analysis.directImpacts.length})` },
                { key: 'DOWNSTREAM', label: `Downstream (${analysis.downstreamImpacts.length})` },
                { key: 'UNAFFECTED', label: `Unaffected (${analysis.unaffectedItems.length})` },
              ] as const
            ).map((tab) => (
              <button
                key={tab.key}
                type="button"
                onClick={() => setBucket(tab.key)}
                className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  bucket === tab.key
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          <div className="space-y-8">
            {(bucket === 'ALL' || bucket === 'DIRECT') &&
              renderImpactList(
                analysis.directImpacts,
                'Direct Impacts',
                'Items directly violating the revised deadline or referencing the original date',
              )}
            {(bucket === 'ALL' || bucket === 'DOWNSTREAM') &&
              renderImpactList(
                analysis.downstreamImpacts,
                'Downstream Impacts',
                'Dependent tasks and responsible people reached via graph traversal',
              )}
            {(bucket === 'ALL' || bucket === 'UNAFFECTED') &&
              renderImpactList(
                analysis.unaffectedItems,
                'Unaffected Items',
                'Completed work or independent project streams with zero schedule conflict',
              )}
          </div>
        </>
      )}
    </div>
  );
}
