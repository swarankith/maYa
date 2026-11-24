import { useState } from 'react';
import {
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Circle,
  GitBranch,
  Layers,
  Mail,
  Play,
  Plus,
  RotateCcw,
  ShieldCheck,
  X,
  Zap,
} from 'lucide-react';
import type { WorkspaceApi } from '../api/client.ts';
import type { DashboardSummary, NodeType, SourceRecord, WorkspaceMode } from '../types/maya.ts';
import { formatDisplayDate } from '../utils/format.ts';
import { FactMarker } from '../components/FactMarker.tsx';

export type NavTab =
  | 'dashboard'
  | 'graph'
  | 'inbox'
  | 'impact'
  | 'simulator'
  | 'approvals'
  | 'audit'
  | 'integrations';

interface DashboardPageProps {
  mode: WorkspaceMode;
  workspaceApi: WorkspaceApi;
  summary: DashboardSummary | null;
  loading: boolean;
  demoRunning: boolean;
  onRunDemo: () => void;
  onResetDemo: () => void;
  onRefresh: () => Promise<void>;
  onNavigate: (tab: NavTab) => void;
}

export function DashboardPage({
  mode,
  workspaceApi,
  summary,
  loading,
  demoRunning,
  onRunDemo,
  onResetDemo,
  onRefresh,
  onNavigate,
}: DashboardPageProps) {
  const [quickAddType, setQuickAddType] = useState<NodeType | 'SOURCE_DOC' | null>(null);
  const [title, setTitle] = useState('');
  const [subtitle, setSubtitle] = useState('');
  const [date, setDate] = useState('');
  const [projectId, setProjectId] = useState('');
  const [sourceContent, setSourceContent] = useState('');
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  if (loading && !summary) {
    return (
      <div className="space-y-6">
        <div className="h-32 rounded-xl border border-slate-800/80 bg-[#0D1526] animate-pulse" />
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div
              key={i}
              className="h-24 rounded-xl border border-slate-800/80 bg-[#0D1526] animate-pulse"
            />
          ))}
        </div>
      </div>
    );
  }

  if (!summary) {
    return (
      <div className="rounded-xl border border-slate-800/80 bg-[#0D1526] p-8 text-center">
        <p className="text-slate-300">Unable to load workspace summary.</p>
      </div>
    );
  }

  const openQuickAdd = (type: NodeType | 'SOURCE_DOC') => {
    setQuickAddType(type);
    setTitle('');
    setSubtitle('');
    setDate(type === 'PROJECT' || type === 'DEADLINE' ? '2026-12-01' : '');
    setProjectId(summary.activeProjects[0]?.id ?? '');
    setSourceContent('');
    setFormError(null);
  };

  const handleQuickAddSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!quickAddType || !title.trim()) return;
    setSaving(true);
    setFormError(null);
    try {
      if (quickAddType === 'SOURCE_DOC') {
        await workspaceApi.createSourceRecord({
          sourceType: 'DOCUMENT' as SourceRecord['sourceType'],
          sender: summary.workspace.name,
          title,
          content: sourceContent || subtitle || title,
          projectId: projectId || null,
        });
      } else {
        const created = await workspaceApi.createNode({
          type: quickAddType,
          title,
          subtitle,
          date: date.trim() || null,
          projectId: quickAddType === 'PROJECT' || quickAddType === 'PERSON' ? null : projectId || null,
        });
        // Automatically add a BELONGS_TO or RELATES_TO edge when user selects a parent project
        if (projectId && quickAddType !== 'PROJECT' && quickAddType !== 'PERSON') {
          const relType =
            quickAddType === 'TASK' || quickAddType === 'DEADLINE' ? 'BELONGS_TO' : 'RELATES_TO';
          await workspaceApi.createEdge({
            sourceId: created.id,
            targetId: projectId,
            relationshipType: relType,
            evidenceText: `Linked "${created.title}" to project during workspace setup.`,
          });
        }
      }
      setQuickAddType(null);
      await onRefresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'Failed to save record');
    } finally {
      setSaving(false);
    }
  };

  const isDemo = mode === 'DEMO';
  const c = summary.counts;

  const onboardingSteps = [
    {
      num: 1,
      title: 'Welcome to maYa',
      detail: 'Private personal workspace created.',
      done: true,
      cta: null as null | { label: string; action: () => void },
    },
    {
      num: 2,
      title: 'Create your first project',
      detail: `${c.activeProjects} project(s) stored.`,
      done: c.activeProjects >= 1,
      cta: { label: 'Create Project', action: () => openQuickAdd('PROJECT') },
    },
    {
      num: 3,
      title: 'Add people and tasks',
      detail: `${c.people} people · ${c.tasks} tasks.`,
      done: c.people >= 1 && c.tasks >= 1,
      cta:
        c.people === 0
          ? { label: 'Add Person', action: () => openQuickAdd('PERSON') }
          : { label: 'Add Task', action: () => openQuickAdd('TASK') },
    },
    {
      num: 4,
      title: 'Connect tasks, deadlines & meetings',
      detail: `${c.upcomingDeadlines} deadlines · ${c.meetings} meetings · ${c.edges} links.`,
      done: c.edges >= 1 && (c.upcomingDeadlines >= 1 || c.meetings >= 1),
      cta:
        c.upcomingDeadlines === 0
          ? { label: 'Add Deadline', action: () => openQuickAdd('DEADLINE') }
          : { label: 'Connect in Graph', action: () => onNavigate('graph') },
    },
    {
      num: 5,
      title: 'Inspect Living Context Graph',
      detail: `${c.nodes} nodes connected.`,
      done: c.nodes >= 2 && c.edges >= 1,
      cta: { label: 'Open Context Graph', action: () => onNavigate('graph') },
    },
    {
      num: 6,
      title: 'Run first Ripple Impact Analysis',
      detail: `${c.impactAnalyses} impact run(s) completed.`,
      done: c.impactAnalyses >= 1,
      cta: { label: 'Open Impact Lens', action: () => onNavigate('impact') },
    },
  ];

  const demoSteps = [
    { key: 'BASELINE', label: '1. Demo Context Seeded', done: true },
    {
      key: 'IMPACT_DETECTED',
      label: '2. Ripple Impact Traced',
      done: summary.demoPhase !== 'BASELINE',
    },
    {
      key: 'PLAN_SELECTED',
      label: '3. What-if Plan Staged',
      done: summary.demoPhase === 'PLAN_SELECTED' || summary.demoPhase === 'EXECUTED',
    },
    {
      key: 'EXECUTED',
      label: '4. Approved & Logged',
      done: summary.demoPhase === 'EXECUTED',
    },
  ];

  return (
    <div className="space-y-6">
      {isDemo ? (
        <section className="rounded-xl border border-amber-500/30 bg-[#0D1526] p-6">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-5">
            <div className="space-y-2 max-w-2xl">
              <div className="flex items-center gap-2 text-xs text-amber-300 font-medium">
                <span>DEMO MODE · Isolated Showcase Workspace</span>
                <span aria-hidden="true" className="text-slate-600">
                  /
                </span>
                <span className="text-slate-400">Separate from all personal workspaces</span>
              </div>
              <h2 className="text-xl font-semibold text-slate-100">
                Don&apos;t just see what changed. Trace everything that change affects.
              </h2>
              <p className="text-sm text-slate-400 leading-relaxed">
                Run the signature Friday-to-Wednesday deadline-shift scenario on seeded demo data,
                or reset demo records at any time without affecting personal accounts.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3 shrink-0">
              <button
                type="button"
                onClick={onResetDemo}
                disabled={demoRunning}
                className="inline-flex items-center gap-2 px-4 py-2.5 text-sm font-medium rounded-lg border border-slate-700/80 bg-slate-900/70 text-slate-200 hover:bg-slate-800 hover:text-white transition-colors whitespace-nowrap shrink-0 disabled:opacity-50"
              >
                <RotateCcw className="h-4 w-4" />
                <span>Reset Demo</span>
              </button>
              <button
                type="button"
                onClick={onRunDemo}
                disabled={demoRunning}
                className="inline-flex items-center gap-2 px-5 py-2.5 text-sm font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors whitespace-nowrap shrink-0 disabled:opacity-60"
              >
                <Play className="h-4 w-4" />
                <span>{demoRunning ? 'Running Analysis...' : 'Run maYa Demo'}</span>
              </button>
            </div>
          </div>

          <div className="mt-6 pt-5 border-t border-slate-800/80 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
            {demoSteps.map((step) => (
              <div
                key={step.key}
                className={`flex items-center gap-2.5 rounded-lg border px-3.5 py-2.5 text-xs font-medium transition-colors ${
                  step.done
                    ? 'border-teal-500/30 bg-teal-500/10 text-teal-300'
                    : 'border-slate-800 bg-slate-900/40 text-slate-400'
                }`}
              >
                <CheckCircle2
                  className={`h-4 w-4 shrink-0 ${step.done ? 'text-teal-400' : 'text-slate-600'}`}
                />
                <span className="truncate">{step.label}</span>
              </div>
            ))}
          </div>
        </section>
      ) : (
        /* Personal Workspace Welcome & 6-Step Onboarding */
        <section className="rounded-xl border border-slate-800/90 bg-[#0D1526] p-6 space-y-5">
          <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <div className="space-y-1.5">
              <div className="text-xs font-medium text-teal-400">
                {summary.workspace.name} · Private Workspace
              </div>
              <h2 className="text-xl font-semibold text-slate-100">
                Welcome to maYa. Let&apos;s build your world of connected context.
              </h2>
              <p className="text-sm text-slate-400 max-w-2xl">
                Add your projects, people, tasks, deadlines, meetings, and documents. Everything you
                create is persisted privately to your workspace.
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-2 shrink-0">
              {(
                [
                  { type: 'PROJECT', label: 'New Project' },
                  { type: 'TASK', label: 'Add Task' },
                  { type: 'PERSON', label: 'Add Person' },
                  { type: 'DEADLINE', label: 'Add Deadline' },
                  { type: 'MEETING', label: 'Add Meeting' },
                  { type: 'SOURCE_DOC', label: 'Add Source' },
                ] as const
              ).map((item) => (
                <button
                  key={item.type}
                  type="button"
                  onClick={() => openQuickAdd(item.type)}
                  className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-lg border border-slate-700/80 bg-slate-900/70 text-slate-200 hover:bg-slate-800 hover:text-white transition-colors whitespace-nowrap shrink-0"
                >
                  <Plus className="h-3.5 w-3.5 text-blue-400" />
                  <span>{item.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* 6-Step Onboarding Flow */}
          <div className="pt-4 border-t border-slate-800/80 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
            {onboardingSteps.map((step) => (
              <div
                key={step.num}
                className={`rounded-lg border p-3.5 flex items-start justify-between gap-3 ${
                  step.done
                    ? 'border-teal-500/30 bg-teal-500/10'
                    : 'border-slate-800 bg-slate-900/50'
                }`}
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  {step.done ? (
                    <CheckCircle2 className="h-4 w-4 text-teal-400 shrink-0 mt-0.5" />
                  ) : (
                    <Circle className="h-4 w-4 text-slate-500 shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-100">
                      Step {step.num}: {step.title}
                    </div>
                    <div className="text-[11px] text-slate-400 mt-0.5">{step.detail}</div>
                  </div>
                </div>
                {step.cta && !step.done && (
                  <button
                    type="button"
                    onClick={step.cta.action}
                    className="text-[11px] font-semibold text-blue-400 hover:text-blue-300 whitespace-nowrap shrink-0"
                  >
                    {step.cta.label}
                  </button>
                )}
              </div>
            ))}
          </div>

          {!isDemo && (c.pendingEmailInsights ?? 0) > 0 && (
            <div className="rounded-lg border border-blue-500/35 bg-blue-500/10 px-4 py-3 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
              <div className="flex items-center gap-2 text-blue-100">
                <Mail className="h-4 w-4 text-blue-400 shrink-0" />
                <span>
                  <span className="font-mono font-semibold tabular-nums">
                    {c.pendingEmailInsights}
                  </span>{' '}
                  staged Gmail insight(s) waiting for your review before entering your Context Graph.
                </span>
              </div>
              <button
                type="button"
                onClick={() => onNavigate('inbox')}
                className="inline-flex items-center gap-1 font-semibold text-blue-300 hover:text-white shrink-0"
              >
                <span>Review Email Insights</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </section>
      )}

      {/* 4-Column Workspace Metric Strip (Real Counts Only) */}
      <section className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <button
          type="button"
          onClick={() => onNavigate('graph')}
          className="text-left rounded-xl border border-slate-800/80 bg-[#0D1526] p-5 hover:border-blue-500/40 transition-colors"
        >
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Living Context Graph</span>
            <GitBranch className="h-4 w-4 text-blue-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-slate-100 tabular-nums font-mono">
              {c.nodes}
            </span>
            <span className="text-xs text-slate-400 tabular-nums">
              nodes · {c.edges} edges
            </span>
          </div>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('graph')}
          className="text-left rounded-xl border border-slate-800/80 bg-[#0D1526] p-5 hover:border-teal-500/40 transition-colors"
        >
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Active Projects</span>
            <Layers className="h-4 w-4 text-teal-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-slate-100 tabular-nums font-mono">
              {c.activeProjects}
            </span>
            <span className="text-xs text-slate-400 tabular-nums">
              {c.upcomingDeadlines} deadline(s) · {c.tasks} task(s)
            </span>
          </div>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('impact')}
          className="text-left rounded-xl border border-slate-800/80 bg-[#0D1526] p-5 hover:border-violet-500/40 transition-colors"
        >
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Impact Analyses</span>
            <Zap className="h-4 w-4 text-violet-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-slate-100 tabular-nums font-mono">
              {c.impactAnalyses}
            </span>
            <span className="text-xs text-slate-400">
              {summary.latestAnalysis
                ? `${summary.latestAnalysis.directImpacts.length} direct · ${summary.latestAnalysis.downstreamImpacts.length} downstream`
                : 'None run yet'}
            </span>
          </div>
        </button>

        <button
          type="button"
          onClick={() => onNavigate('approvals')}
          className="text-left rounded-xl border border-slate-800/80 bg-[#0D1526] p-5 hover:border-amber-500/40 transition-colors"
        >
          <div className="flex items-center justify-between text-xs text-slate-400">
            <span>Pending Approvals</span>
            <ShieldCheck className="h-4 w-4 text-amber-400" />
          </div>
          <div className="mt-2 flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-slate-100 tabular-nums font-mono">
              {c.pendingApprovals}
            </span>
            <span className="text-xs text-slate-400 tabular-nums">
              {c.auditEntries} audit record(s)
            </span>
          </div>
        </button>
      </section>

      {/* Main 2-Column Overview */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        <div className="lg:col-span-7 space-y-6">
          <section className="rounded-xl border border-slate-800/80 bg-[#0D1526] overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-800/80 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-100">Active Projects</h3>
              <button
                type="button"
                onClick={() => onNavigate('graph')}
                className="text-xs font-medium text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"
              >
                <span>Open Graph</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>
            {summary.activeProjects.length === 0 ? (
              <div className="p-6 text-center space-y-3">
                <p className="text-xs text-slate-400">
                  No projects in your personal workspace yet. Create your first project to start
                  building your Living Context Graph.
                </p>
                {!isDemo && (
                  <button
                    type="button"
                    onClick={() => openQuickAdd('PROJECT')}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white"
                  >
                    <Plus className="h-3.5 w-3.5" />
                    <span>Create First Project</span>
                  </button>
                )}
              </div>
            ) : (
              <div className="divide-y divide-slate-800/60">
                {summary.activeProjects.map((proj) => (
                  <div
                    key={proj.id}
                    className="px-5 py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 hover:bg-slate-900/40 transition-colors"
                  >
                    <div className="space-y-0.5">
                      <div className="text-sm font-medium text-slate-100">{proj.title}</div>
                      <div className="text-xs text-slate-400 flex flex-wrap items-center gap-2">
                        <span>{proj.subtitle || 'Personal Project'}</span>
                        <span aria-hidden="true">·</span>
                        <FactMarker status={proj.factStatus} />
                      </div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs font-mono tabular-nums text-slate-200">
                        {formatDisplayDate(proj.date)}
                      </div>
                      <div className="text-xs text-teal-400">{proj.status}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section className="rounded-xl border border-slate-800/80 bg-[#0D1526] overflow-hidden">
            <div className="px-5 py-4 border-b border-slate-800/80 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-100">Upcoming Deadlines</h3>
              <CalendarClock className="h-4 w-4 text-slate-400" />
            </div>
            {summary.upcomingDeadlines.length === 0 ? (
              <div className="p-6 text-center text-xs text-slate-400">
                No deadlines tracked yet. Add a deadline and connect it to a project to enable
                ripple impact tracking.
              </div>
            ) : (
              <div className="divide-y divide-slate-800/60">
                {summary.upcomingDeadlines.map((dl) => (
                  <div
                    key={dl.id}
                    className="px-5 py-3.5 flex items-center justify-between gap-4 hover:bg-slate-900/40 transition-colors"
                  >
                    <div>
                      <div className="text-sm font-medium text-slate-100">{dl.title}</div>
                      <div className="text-xs text-slate-400">
                        {dl.provenance} · {dl.status}
                      </div>
                    </div>
                    <div className="text-xs font-mono tabular-nums text-amber-300 shrink-0">
                      {formatDisplayDate(dl.date)}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        <div className="lg:col-span-5 space-y-6">
          <section className="rounded-xl border border-slate-800/80 bg-[#0D1526] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-100">Latest Impact Analysis</h3>
              {summary.latestAnalysis && (
                <button
                  type="button"
                  onClick={() => onNavigate('impact')}
                  className="text-xs font-medium text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"
                >
                  <span>Open Impact Lens</span>
                  <ArrowRight className="h-3.5 w-3.5" />
                </button>
              )}
            </div>

            {summary.latestAnalysis ? (
              <div className="space-y-3">
                <div className="rounded-lg border border-slate-800 bg-slate-900/60 p-3.5 space-y-1.5">
                  <div className="text-xs text-blue-400 font-medium">
                    {summary.latestAnalysis.changeEvent.projectTitle}
                  </div>
                  <div className="text-sm font-medium text-slate-100">
                    Deadline shifted:{' '}
                    <span className="font-mono text-slate-400 line-through">
                      {formatDisplayDate(summary.latestAnalysis.changeEvent.originalValue)}
                    </span>{' '}
                    <span aria-hidden="true">-&gt;</span>{' '}
                    <span className="font-mono text-amber-300">
                      {formatDisplayDate(summary.latestAnalysis.changeEvent.newValue)}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">
                    {summary.latestAnalysis.explanationSummary}
                  </p>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    onClick={() => onNavigate('impact')}
                    className="flex-1 px-3 py-2 text-xs font-medium rounded-lg border border-slate-700 text-slate-200 hover:bg-slate-800 transition-colors"
                  >
                    Inspect Evidence
                  </button>
                  <button
                    type="button"
                    onClick={() => onNavigate('simulator')}
                    className="flex-1 px-3 py-2 text-xs font-medium rounded-lg bg-teal-600/20 border border-teal-500/40 text-teal-300 hover:bg-teal-600/30 transition-colors"
                  >
                    Compare What-if Plans
                  </button>
                </div>
              </div>
            ) : (
              <div className="rounded-lg border border-dashed border-slate-800 p-5 text-center space-y-2">
                <p className="text-xs text-slate-400 leading-relaxed">
                  {isDemo
                    ? 'Click "Run maYa Demo" to trace the signature Friday-to-Wednesday deadline shift.'
                    : 'Once you have a project and connected tasks or deadlines, run an impact analysis in Impact Lens.'}
                </p>
              </div>
            )}
          </section>

          <section className="rounded-xl border border-slate-800/80 bg-[#0D1526] p-5 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-100">Pending Approvals</h3>
              <button
                type="button"
                onClick={() => onNavigate('approvals')}
                className="text-xs font-medium text-blue-400 hover:text-blue-300 inline-flex items-center gap-1"
              >
                <span>Review Queue</span>
                <ArrowRight className="h-3.5 w-3.5" />
              </button>
            </div>

            {summary.pendingApprovals.length > 0 ? (
              <div className="space-y-2.5">
                {summary.pendingApprovals.slice(0, 4).map((apr) => (
                  <div
                    key={apr.id}
                    className="rounded-lg border border-slate-800 bg-slate-900/50 px-3.5 py-2.5 flex items-center justify-between gap-3"
                  >
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-slate-200 truncate">
                        {apr.targetLabel}
                      </div>
                      <div className="text-xs text-slate-400 truncate">
                        {apr.actionType.replace(/_/g, ' ')} · {apr.permissionScope}
                      </div>
                    </div>
                    <span className="text-xs font-mono text-amber-300 shrink-0">PENDING</span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="text-xs text-slate-400">
                No actions waiting for approval. Selecting a What-if plan stages proposed updates
                here before any write occurs.
              </p>
            )}
          </section>
        </div>
      </div>

      {/* Quick-Add Context Modal for Personal Workspace */}
      {quickAddType && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-700 bg-[#0D1526] p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-100">
                {quickAddType === 'SOURCE_DOC'
                  ? 'Add Document / Source Record'
                  : `Add ${quickAddType.charAt(0) + quickAddType.slice(1).toLowerCase()}`}
              </h3>
              <button
                type="button"
                onClick={() => setQuickAddType(null)}
                className="text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <form onSubmit={handleQuickAddSubmit} className="space-y-3">
              {formError && <p className="text-xs text-rose-400">{formError}</p>}

              <div>
                <label className="block text-xs text-slate-400 mb-1">Title</label>
                <input
                  type="text"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={
                    quickAddType === 'PROJECT'
                      ? 'e.g., Thesis Defense Preparation'
                      : quickAddType === 'PERSON'
                        ? 'e.g., Dr. Priya Nair'
                        : 'Enter title'
                  }
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">
                  {quickAddType === 'PERSON' ? 'Role / Email' : 'Description / Details'}
                </label>
                <input
                  type="text"
                  value={subtitle}
                  onChange={(e) => setSubtitle(e.target.value)}
                  placeholder="Optional details"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                />
              </div>

              {quickAddType === 'SOURCE_DOC' && (
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Source Content</label>
                  <textarea
                    rows={3}
                    required
                    value={sourceContent}
                    onChange={(e) => setSourceContent(e.target.value)}
                    placeholder="Paste document excerpt, email text, or meeting note..."
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                  />
                </div>
              )}

              {quickAddType !== 'PERSON' && quickAddType !== 'SOURCE_DOC' && (
                <div>
                  <label className="block text-xs text-slate-400 mb-1">
                    Target Date / Time (ISO YYYY-MM-DD or YYYY-MM-DDTHH:mm)
                  </label>
                  <input
                    type="text"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    placeholder="2026-12-01T17:00"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs font-mono text-slate-100"
                  />
                </div>
              )}

              {quickAddType !== 'PROJECT' &&
                quickAddType !== 'PERSON' &&
                summary.activeProjects.length > 0 && (
                  <div>
                    <label className="block text-xs text-slate-400 mb-1">
                      Connect to Project
                    </label>
                    <select
                      value={projectId}
                      onChange={(e) => setProjectId(e.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                    >
                      <option value="">Standalone (link later)</option>
                      {summary.activeProjects.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.title}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setQuickAddType(null)}
                  className="px-4 py-2 text-xs text-slate-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save to Workspace'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
