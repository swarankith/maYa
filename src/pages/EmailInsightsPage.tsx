import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronUp,
  Edit3,
  GitBranch,
  Link2,
  Mail,
  Plug,
  RefreshCw,
  ShieldCheck,
  X,
} from 'lucide-react';
import type { WorkspaceApi } from '../api/client.ts';
import { FactMarker } from '../components/FactMarker.tsx';
import type {
  ContextNode,
  EmailExtractedItem,
  EmailExtractedItemType,
  EmailInsightsResponse,
  EmailMatchClassification,
  EmailSuggestedRelationship,
  ExtractionStatus,
  FactStatus,
  WorkspaceMode,
} from '../types/maya.ts';
import { formatDisplayDate, formatTimestamp } from '../utils/format.ts';

interface EmailInsightsPageProps {
  mode: WorkspaceMode;
  workspaceApi: WorkspaceApi;
  workspaceNodes: ContextNode[];
  onRefresh: () => Promise<void>;
  onGoToIntegrations: () => void;
  onGoToGraph: () => void;
}

type InsightsTab = 'pending' | 'conflicts' | 'relationships' | 'messages' | 'history';

const ITEM_TYPE_OPTIONS: EmailExtractedItemType[] = [
  'TASK',
  'DEADLINE',
  'MEETING',
  'PROJECT',
  'PERSON',
  'DECISION',
  'PLAN_CHANGE',
  'CONFLICT',
];

function classificationLabel(c: EmailMatchClassification): { text: string; className: string } {
  switch (c) {
    case 'CONFLICT':
      return { text: 'CONFLICT DETECTED', className: 'text-rose-400' };
    case 'UPDATE':
      return { text: 'UPDATES EXISTING', className: 'text-amber-300' };
    case 'POSSIBLE_DUPLICATE':
      return { text: 'POSSIBLE DUPLICATE', className: 'text-violet-300' };
    case 'NEW':
    default:
      return { text: 'NEW ENTITY', className: 'text-teal-400' };
  }
}

export function EmailInsightsPage({
  mode,
  workspaceApi,
  workspaceNodes,
  onRefresh,
  onGoToIntegrations,
  onGoToGraph,
}: EmailInsightsPageProps) {
  const [data, setData] = useState<EmailInsightsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [retryingQueue, setRetryingQueue] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<InsightsTab>('pending');
  const [expandedMsgId, setExpandedMsgId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Inline Edit & Accept state
  const [editingItemId, setEditingItemId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [editDescription, setEditDescription] = useState('');
  const [editItemType, setEditItemType] = useState<EmailExtractedItemType>('TASK');
  const [editDate, setEditDate] = useState('');
  const [editFactStatus, setEditFactStatus] = useState<FactStatus>('CONFIRMED');
  const [editActionMode, setEditActionMode] = useState<'CREATE_NEW' | 'UPDATE_MATCHED'>('CREATE_NEW');
  const [editTargetNodeId, setEditTargetNodeId] = useState('');

  // Optional node overrides for suggested relationships
  const [relOverrides, setRelOverrides] = useState<
    Record<string, { sourceNodeId?: string; targetNodeId?: string }>
  >({});

  const loadInsights = useCallback(
    async (silent = false) => {
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      try {
        const res = await workspaceApi.getEmailInsights();
        setData(res);
      } catch (err) {
        if (!silent) {
          setError(err instanceof Error ? err.message : 'Unable to load email insights');
        }
      } finally {
        if (!silent) {
          setLoading(false);
        }
      }
    },
    [workspaceApi],
  );

  useEffect(() => {
    if (mode === 'DEMO') {
      setLoading(false);
      setData(null);
      return;
    }
    void loadInsights();
    setNotice(null);
    setEditingItemId(null);
  }, [loadInsights, mode]);

  const activeQueueCount =
    (data?.extractionSummary?.pending ?? 0) +
    (data?.extractionSummary?.processing ?? 0) +
    (data?.extractionSummary?.retrying ?? 0);

  useEffect(() => {
    if (mode === 'DEMO' || activeQueueCount === 0) {
      return;
    }
    const timer = window.setInterval(() => {
      void loadInsights(true);
    }, 3500);
    return () => window.clearInterval(timer);
  }, [activeQueueCount, loadInsights, mode]);

  const sortedWorkspaceNodes = useMemo(
    () => [...workspaceNodes].sort((a, b) => a.title.localeCompare(b.title)),
    [workspaceNodes],
  );

  if (mode === 'DEMO') {
    return (
      <div className="rounded-xl border border-amber-500/30 bg-[#0D1526] p-8 space-y-4">
        <div className="flex items-center gap-2 text-xs font-semibold text-amber-300">
          <Mail className="h-4 w-4" />
          <span>DEMO MODE · Email Insights Disabled</span>
        </div>
        <h2 className="text-lg font-semibold text-slate-100">
          Personal Gmail ingestion is strictly isolated from DEMO MODE.
        </h2>
        <p className="text-xs text-slate-400 max-w-2xl leading-relaxed">
          To keep every user&apos;s inbox private, Gmail OAuth connections, synchronized messages,
          and extracted Email Insights only operate inside authenticated Personal Workspaces. Switch
          back to your Personal Workspace in the sidebar to connect Gmail and review extracted
          insights.
        </p>
        <button
          type="button"
          onClick={onGoToGraph}
          className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"
        >
          <GitBranch className="h-3.5 w-3.5 text-blue-400" />
          <span>Explore Demo Context Graph</span>
        </button>
      </div>
    );
  }

  const handleSyncNow = async () => {
    setSyncing(true);
    setError(null);
    setNotice(null);
    try {
      const res = await workspaceApi.syncGmail();
      await loadInsights();
      await onRefresh();
      setNotice(
        `Synced ${res.fetchedCount} new message(s) (${res.skippedDuplicates} duplicate(s) skipped). ${res.queuedForExtraction} message(s) queued for rate-limited AI extraction.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to synchronize Gmail');
    } finally {
      setSyncing(false);
    }
  };

  const handleProcessPending = async () => {
    setRetryingQueue(true);
    setError(null);
    setNotice(null);
    try {
      const res = await workspaceApi.processPendingEmails();
      await loadInsights(true);
      setNotice(
        `Extraction queue started (${res.extractionSummary.pending + res.extractionSummary.retrying} message(s) queued at up to ${res.extractionSummary.rateLimitRpm} requests/min).`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to trigger extraction queue');
    } finally {
      setRetryingQueue(false);
    }
  };

  const handleRetryFailed = async (messageId?: string) => {
    setRetryingQueue(true);
    if (messageId) setBusyId(messageId);
    setError(null);
    setNotice(null);
    try {
      const res = await workspaceApi.retryFailedEmails(messageId);
      await loadInsights(true);
      if (res.retriedCount > 0) {
        setNotice(
          `Re-queued ${res.retriedCount} failed/retrying message(s) for batched Gemini extraction.`,
        );
      } else {
        setNotice('No failed or retrying messages needed re-queuing.');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to retry email extraction');
    } finally {
      setRetryingQueue(false);
      if (messageId) setBusyId(null);
    }
  };

  const beginEdit = (item: EmailExtractedItem) => {
    setEditingItemId(item.id);
    setEditTitle(item.title);
    setEditDescription(item.description);
    setEditItemType(item.itemType);
    setEditDate(item.proposedDate ?? '');
    setEditFactStatus(item.factStatus);
    const defaultUpdate =
      Boolean(item.matchedNodeId) &&
      (item.matchClassification === 'UPDATE' || item.matchClassification === 'CONFLICT');
    setEditActionMode(defaultUpdate ? 'UPDATE_MATCHED' : 'CREATE_NEW');
    setEditTargetNodeId(item.matchedNodeId ?? '');
  };

  const handleAcceptItem = async (
    item: EmailExtractedItem,
    useEdits: boolean,
  ) => {
    setBusyId(item.id);
    setError(null);
    setNotice(null);
    try {
      const payload = useEdits
        ? {
            title: editTitle.trim(),
            description: editDescription.trim(),
            itemType: editItemType,
            proposedDate: editDate.trim() || null,
            factStatus: editFactStatus,
            actionMode: editActionMode,
            targetNodeId: editActionMode === 'UPDATE_MATCHED' ? editTargetNodeId || undefined : undefined,
          }
        : undefined;
      const res = await workspaceApi.acceptEmailItem(item.id, payload);
      setEditingItemId(null);
      await loadInsights();
      await onRefresh();
      setNotice(`Accepted "${res.node.title}" into your Living Context Graph.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to accept extracted insight');
    } finally {
      setBusyId(null);
    }
  };

  const handleRejectItem = async (item: EmailExtractedItem) => {
    setBusyId(item.id);
    setError(null);
    setNotice(null);
    try {
      await workspaceApi.rejectEmailItem(item.id);
      if (editingItemId === item.id) setEditingItemId(null);
      await loadInsights();
      await onRefresh();
      setNotice(`Rejected "${item.title}". Zero changes were applied to your Context Graph.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject item');
    } finally {
      setBusyId(null);
    }
  };

  const handleAcceptRelationship = async (rel: EmailSuggestedRelationship) => {
    setBusyId(rel.id);
    setError(null);
    setNotice(null);
    try {
      const override = relOverrides[rel.id];
      await workspaceApi.acceptEmailRelationship(rel.id, override);
      await loadInsights();
      await onRefresh();
      setNotice(
        `Approved ${rel.relationshipType} relationship between "${rel.sourceLabel}" and "${rel.targetLabel}".`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve relationship');
    } finally {
      setBusyId(null);
    }
  };

  const handleRejectRelationship = async (rel: EmailSuggestedRelationship) => {
    setBusyId(rel.id);
    setError(null);
    setNotice(null);
    try {
      await workspaceApi.rejectEmailRelationship(rel.id);
      await loadInsights();
      await onRefresh();
      setNotice(`Rejected relationship "${rel.sourceLabel} -> ${rel.targetLabel}".`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject relationship');
    } finally {
      setBusyId(null);
    }
  };

  const conn = data?.connection;
  const extractionSummary = data?.extractionSummary;
  const messages = data?.messages ?? [];
  const allItems = data?.extractedItems ?? [];
  const allRels = data?.suggestedRelationships ?? [];

  const pendingItems = allItems.filter((i) => i.status === 'PENDING');
  const conflictOrPlanItems = pendingItems.filter(
    (i) =>
      i.matchClassification === 'CONFLICT' ||
      i.matchClassification === 'UPDATE' ||
      i.itemType === 'CONFLICT' ||
      i.itemType === 'PLAN_CHANGE',
  );
  const pendingRels = allRels.filter((r) => r.status === 'PENDING');
  const reviewedItems = allItems.filter((i) => i.status !== 'PENDING');
  const reviewedRels = allRels.filter((r) => r.status !== 'PENDING');

  const renderItemCard = (item: EmailExtractedItem) => {
    const isEditing = editingItemId === item.id;
    const isBusy = busyId === item.id;
    const clsMeta = classificationLabel(item.matchClassification);
    const isPending = item.status === 'PENDING';

    return (
      <article
        key={item.id}
        className="rounded-xl border border-slate-800/90 bg-[#0D1526] p-5 space-y-4"
      >
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div className="space-y-1.5 min-w-0">
            <div className="flex flex-wrap items-center gap-2.5 text-xs">
              <span className="font-mono font-semibold text-blue-300">{item.itemType}</span>
              <span className="text-slate-600" aria-hidden="true">
                /
              </span>
              <span className={`font-mono font-semibold ${clsMeta.className}`}>
                {clsMeta.text}
              </span>
              <span className="text-slate-600" aria-hidden="true">
                /
              </span>
              <FactMarker status={item.factStatus} />
              {!isPending && (
                <>
                  <span className="text-slate-600" aria-hidden="true">
                    /
                  </span>
                  <span
                    className={`font-mono font-semibold ${
                      item.status === 'ACCEPTED' ? 'text-teal-400' : 'text-slate-400'
                    }`}
                  >
                    {item.status}
                  </span>
                </>
              )}
            </div>
            <h3 className="text-base font-semibold text-slate-100">{item.title}</h3>
            {item.description && (
              <p className="text-xs text-slate-300 leading-relaxed max-w-3xl">{item.description}</p>
            )}
          </div>

          {isPending && !isEditing && (
            <div className="flex flex-wrap items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => handleRejectItem(item)}
                disabled={isBusy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-700 bg-slate-900 text-slate-300 hover:text-rose-300 hover:border-rose-500/40 transition-colors disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
                <span>Reject</span>
              </button>
              <button
                type="button"
                onClick={() => beginEdit(item)}
                disabled={isBusy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 transition-colors disabled:opacity-50"
              >
                <Edit3 className="h-3.5 w-3.5 text-blue-400" />
                <span>Edit &amp; Accept</span>
              </button>
              <button
                type="button"
                onClick={() => handleAcceptItem(item, false)}
                disabled={isBusy}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-teal-600 hover:bg-teal-500 text-white transition-colors disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />
                <span>{isBusy ? 'Applying...' : 'Accept'}</span>
              </button>
            </div>
          )}
        </div>

        {/* Structured Details & Match Info */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs">
          <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 space-y-1">
            <div className="text-[11px] text-slate-400">Proposed Date / Timeline</div>
            {item.dateAmbiguous ? (
              <div className="text-amber-300 font-medium">
                Ambiguous date — clarification needed
                {item.dateNote ? (
                  <div className="text-[11px] text-slate-400 mt-0.5 font-normal">
                    {item.dateNote}
                  </div>
                ) : null}
              </div>
            ) : (
              <div className="font-mono tabular-nums text-slate-200">
                {item.proposedDate ? formatDisplayDate(item.proposedDate) : 'No explicit date'}
              </div>
            )}
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 space-y-1">
            <div className="text-[11px] text-slate-400">Workspace Graph Match</div>
            {item.matchedNodeId ? (
              <div className="text-slate-200">
                Matches <span className="font-semibold text-amber-300">{item.matchedNodeTitle}</span>
                {item.affectedNodeIds.length > 0 && (
                  <div className="text-[11px] text-slate-400 mt-0.5 tabular-nums">
                    {item.affectedNodeIds.length} connected node(s) potentially affected
                  </div>
                )}
              </div>
            ) : (
              <div className="text-slate-300">
                No existing match ({item.relatedProjectName ? `Project: ${item.relatedProjectName}` : 'Standalone entity'})
              </div>
            )}
          </div>

          <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 space-y-1">
            <div className="text-[11px] text-slate-400">Source Email</div>
            <div className="text-slate-200 truncate" title={item.messageSubject}>
              {item.messageSubject}
            </div>
            <div className="text-[11px] text-slate-400 truncate">
              {item.messageSender} · {formatTimestamp(item.messageReceivedAt)}
            </div>
          </div>
        </div>

        {/* Verbatim Email Evidence */}
        <blockquote className="rounded-lg border border-slate-800/80 bg-slate-950/60 px-4 py-3 text-xs text-slate-300 space-y-1">
          <div className="text-[11px] font-semibold text-slate-400">
            Email Evidence Quote (Provenance)
          </div>
          <p className="italic text-slate-200">&ldquo;{item.evidenceQuote}&rdquo;</p>
          {item.confidenceNote && (
            <p className="text-[11px] text-slate-400 pt-1">{item.confidenceNote}</p>
          )}
        </blockquote>

        {/* Inline Editor */}
        {isEditing && isPending && (
          <div className="rounded-lg border border-blue-500/40 bg-slate-900/80 p-4 space-y-3 text-xs">
            <div className="font-semibold text-blue-300">Edit Before Accepting into Graph</div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Entity Title</label>
                <input
                  type="text"
                  value={editTitle}
                  onChange={(e) => setEditTitle(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Entity Type</label>
                <select
                  value={editItemType}
                  onChange={(e) => setEditItemType(e.target.value as EmailExtractedItemType)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                >
                  {ITEM_TYPE_OPTIONS.map((t) => (
                    <option key={t} value={t}>
                      {t}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">
                  ISO Date / Time (YYYY-MM-DD or YYYY-MM-DDTHH:mm)
                </label>
                <input
                  type="text"
                  value={editDate}
                  onChange={(e) => setEditDate(e.target.value)}
                  placeholder="Optional ISO date (e.g., 2026-12-03T17:00)"
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs font-mono text-slate-100"
                />
              </div>
              <div>
                <label className="block text-[11px] text-slate-400 mb-1">Certainty Classification</label>
                <select
                  value={editFactStatus}
                  onChange={(e) => setEditFactStatus(e.target.value as FactStatus)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                >
                  <option value="CONFIRMED">CONFIRMED</option>
                  <option value="INFERRED">INFERRED</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-[11px] text-slate-400 mb-1">Description / Subtitle</label>
              <input
                type="text"
                value={editDescription}
                onChange={(e) => setEditDescription(e.target.value)}
                className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
              />
            </div>

            {sortedWorkspaceNodes.length > 0 && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] text-slate-400 mb-1">Apply Action</label>
                  <select
                    value={editActionMode}
                    onChange={(e) =>
                      setEditActionMode(e.target.value as 'CREATE_NEW' | 'UPDATE_MATCHED')
                    }
                    className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                  >
                    <option value="CREATE_NEW">Create New Node in Context Graph</option>
                    <option value="UPDATE_MATCHED">Update Existing Workspace Node</option>
                  </select>
                </div>
                {editActionMode === 'UPDATE_MATCHED' && (
                  <div>
                    <label className="block text-[11px] text-slate-400 mb-1">Target Node</label>
                    <select
                      value={editTargetNodeId}
                      onChange={(e) => setEditTargetNodeId(e.target.value)}
                      className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 text-xs text-slate-100"
                    >
                      <option value="">Select node to update...</option>
                      {sortedWorkspaceNodes.map((n) => (
                        <option key={n.id} value={n.id}>
                          [{n.type}] {n.title}
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setEditingItemId(null)}
                className="px-3 py-1.5 text-slate-400 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={
                  isBusy ||
                  !editTitle.trim() ||
                  (editActionMode === 'UPDATE_MATCHED' && !editTargetNodeId)
                }
                onClick={() => handleAcceptItem(item, true)}
                className="px-4 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-500 text-white font-semibold disabled:opacity-50"
              >
                {isBusy ? 'Saving...' : 'Save & Accept into Graph'}
              </button>
            </div>
          </div>
        )}
      </article>
    );
  };

  const renderRelationshipCard = (rel: EmailSuggestedRelationship) => {
    const isBusy = busyId === rel.id;
    const isPending = rel.status === 'PENDING';
    const override = relOverrides[rel.id] ?? {};

    return (
      <article
        key={rel.id}
        className="rounded-xl border border-slate-800/90 bg-[#0D1526] p-5 space-y-3"
      >
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <Link2 className="h-3.5 w-3.5 text-blue-400" />
              <span className="font-mono font-semibold text-blue-300">{rel.relationshipType}</span>
              <span className="text-slate-600" aria-hidden="true">
                /
              </span>
              <FactMarker status={rel.factStatus} />
              {!isPending && (
                <>
                  <span className="text-slate-600" aria-hidden="true">
                    /
                  </span>
                  <span
                    className={`font-mono font-semibold ${
                      rel.status === 'ACCEPTED' ? 'text-teal-400' : 'text-slate-400'
                    }`}
                  >
                    {rel.status}
                  </span>
                </>
              )}
            </div>
            <div className="text-sm font-semibold text-slate-100 flex flex-wrap items-center gap-2">
              <span>{rel.sourceLabel}</span>
              <ArrowRight className="h-3.5 w-3.5 text-slate-500" />
              <span>{rel.targetLabel}</span>
            </div>
            <p className="text-xs text-slate-400">
              {rel.rationale} · Source: {rel.messageSubject}
            </p>
          </div>

          {isPending && (
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => handleRejectRelationship(rel)}
                disabled={isBusy}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-700 bg-slate-900 text-slate-300 hover:text-rose-300 disabled:opacity-50"
              >
                <X className="h-3.5 w-3.5" />
                <span>Reject</span>
              </button>
              <button
                type="button"
                onClick={() => handleAcceptRelationship(rel)}
                disabled={isBusy}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-semibold rounded-lg bg-teal-600 hover:bg-teal-500 text-white disabled:opacity-50"
              >
                <Check className="h-3.5 w-3.5" />
                <span>Approve Relationship</span>
              </button>
            </div>
          )}
        </div>

        <blockquote className="rounded-lg border border-slate-800/80 bg-slate-950/60 px-4 py-2.5 text-xs text-slate-300 italic">
          &ldquo;{rel.evidenceQuote}&rdquo;
        </blockquote>

        {isPending && sortedWorkspaceNodes.length > 0 && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-xs pt-1">
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                Source Node Mapping {rel.sourceNodeId ? '(Auto-linked)' : '(Optional override)'}
              </label>
              <select
                value={override.sourceNodeId ?? rel.sourceNodeId ?? ''}
                onChange={(e) =>
                  setRelOverrides((prev) => ({
                    ...prev,
                    [rel.id]: { ...prev[rel.id], sourceNodeId: e.target.value || undefined },
                  }))
                }
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-200"
              >
                <option value="">Auto-resolve from accepted items / title...</option>
                {sortedWorkspaceNodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    [{n.type}] {n.title}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[11px] text-slate-400 mb-1">
                Target Node Mapping {rel.targetNodeId ? '(Auto-linked)' : '(Optional override)'}
              </label>
              <select
                value={override.targetNodeId ?? rel.targetNodeId ?? ''}
                onChange={(e) =>
                  setRelOverrides((prev) => ({
                    ...prev,
                    [rel.id]: { ...prev[rel.id], targetNodeId: e.target.value || undefined },
                  }))
                }
                className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs text-slate-200"
              >
                <option value="">Auto-resolve from accepted items / title...</option>
                {sortedWorkspaceNodes.map((n) => (
                  <option key={n.id} value={n.id}>
                    [{n.type}] {n.title}
                  </option>
                ))}
              </select>
            </div>
          </div>
        )}
      </article>
    );
  };

  return (
    <div className="space-y-6">
      {/* Header & Connection Controls */}
      <section className="rounded-xl border border-slate-800/90 bg-[#0D1526] p-6 space-y-4">
        <div className="flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2 text-xs text-teal-400 font-medium">
              <ShieldCheck className="h-3.5 w-3.5" />
              <span>Human-in-the-Loop Inbox Intelligence · Read-Only Gmail</span>
            </div>
            <h2 className="text-lg font-semibold text-slate-100">
              Email Insights &amp; Context Staging Queue
            </h2>
            <p className="text-xs text-slate-400 max-w-2xl leading-relaxed">
              maYa reads relevant emails, extracts structured tasks, deadlines, meetings, conflicts,
              and relationship proposals with verbatim evidence, and holds them here until you
              explicitly accept or reject each change.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            <button
              type="button"
              onClick={onGoToIntegrations}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 transition-colors"
            >
              <Plug className="h-3.5 w-3.5 text-blue-400" />
              <span>Gmail Settings</span>
            </button>
            {(extractionSummary?.failed ?? 0) > 0 && (
              <button
                type="button"
                onClick={() => handleRetryFailed()}
                disabled={retryingQueue || loading}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-amber-500/40 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25 transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${retryingQueue ? 'animate-spin' : ''}`} />
                <span>Retry Failed ({extractionSummary?.failed ?? 0})</span>
              </button>
            )}
            {activeQueueCount > 0 && (
              <button
                type="button"
                onClick={handleProcessPending}
                disabled={retryingQueue || loading}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-blue-500/40 bg-blue-500/15 text-blue-200 hover:bg-blue-500/25 transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${retryingQueue ? 'animate-spin' : ''}`} />
                <span>Process Pending ({activeQueueCount})</span>
              </button>
            )}
            {conn?.status === 'CONNECTED' && (
              <button
                type="button"
                onClick={handleSyncNow}
                disabled={syncing || loading}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50"
              >
                <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
                <span>{syncing ? 'Syncing Inbox...' : 'Sync Now'}</span>
              </button>
            )}
          </div>
        </div>

        {/* Status Summary Strip */}
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3 pt-2 border-t border-slate-800/80 text-xs">
          <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
            <div className="text-[11px] text-slate-400">Gmail Account</div>
            <div className="font-mono text-slate-100 truncate mt-0.5">
              {conn?.status === 'CONNECTED' && conn.googleEmail
                ? conn.googleEmail
                : conn?.status ?? 'DISCONNECTED'}
            </div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
            <div className="text-[11px] text-slate-400">Pending Review Items</div>
            <div className="text-lg font-mono font-semibold tabular-nums text-blue-300">
              {pendingItems.length}
            </div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
            <div className="text-[11px] text-slate-400">Conflicts / Plan Updates</div>
            <div className="text-lg font-mono font-semibold tabular-nums text-amber-300">
              {conflictOrPlanItems.length}
            </div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
            <div className="text-[11px] text-slate-400">Extracted Messages</div>
            <div className="text-lg font-mono font-semibold tabular-nums text-teal-300">
              {extractionSummary?.completed ?? messages.filter((m) => m.extractionStatus === 'COMPLETED').length}
              <span className="text-xs font-normal text-slate-400"> / {messages.length}</span>
            </div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3">
            <div className="text-[11px] text-slate-400">Extraction Queue</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono tabular-nums text-[11px]">
              <span className="text-blue-300">
                {(extractionSummary?.pending ?? 0) + (extractionSummary?.processing ?? 0)} queued
              </span>
              <span className="text-amber-300">{extractionSummary?.retrying ?? 0} retrying</span>
              <span className={(extractionSummary?.failed ?? 0) > 0 ? 'text-rose-400' : 'text-slate-400'}>
                {extractionSummary?.failed ?? 0} failed
              </span>
            </div>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-xs text-rose-200 flex items-center justify-between gap-3">
          <span>{error}</span>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-rose-300 hover:text-white"
          >
            Dismiss
          </button>
        </div>
      )}

      {notice && (
        <div className="rounded-xl border border-teal-500/40 bg-teal-500/10 p-4 text-xs text-teal-100 flex items-center justify-between gap-3">
          <span>{notice}</span>
          <button
            type="button"
            onClick={onGoToGraph}
            className="inline-flex items-center gap-1 text-teal-300 hover:text-white font-semibold shrink-0"
          >
            <span>Inspect Graph</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Disconnected Empty State CTA */}
      {!loading && conn?.status !== 'CONNECTED' && messages.length === 0 && (
        <section className="rounded-xl border border-dashed border-slate-700 bg-[#0D1526] p-8 text-center space-y-3">
          <Mail className="h-8 w-8 text-blue-400 mx-auto" />
          <h3 className="text-base font-semibold text-slate-100">
            No Gmail account connected to this workspace yet
          </h3>
          <p className="text-xs text-slate-400 max-w-lg mx-auto leading-relaxed">
            Connect your personal Gmail account in Integrations using read-only permissions, then
            trigger Sync Now to stage extracted tasks, deadlines, and plan updates here.
          </p>
          <button
            type="button"
            onClick={onGoToIntegrations}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white"
          >
            <Plug className="h-3.5 w-3.5" />
            <span>Configure Gmail Integration</span>
          </button>
        </section>
      )}

      {/* Sub-navigation Tabs */}
      {(messages.length > 0 || allItems.length > 0 || allRels.length > 0 || conn?.status === 'CONNECTED') && (
        <>
          <div className="flex flex-wrap items-center gap-2 border-b border-slate-800/80 pb-3">
            {(
              [
                { id: 'pending', label: `Pending Items (${pendingItems.length})` },
                { id: 'conflicts', label: `Conflicts & Changes (${conflictOrPlanItems.length})` },
                { id: 'relationships', label: `Suggested Relationships (${pendingRels.length})` },
                { id: 'messages', label: `Processed Messages (${messages.length})` },
                {
                  id: 'history',
                  label: `Reviewed History (${reviewedItems.length + reviewedRels.length})`,
                },
              ] as Array<{ id: InsightsTab; label: string }>
            ).map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => setActiveTab(tab.id)}
                className={`px-3.5 py-2 rounded-lg text-xs font-medium transition-colors tabular-nums ${
                  activeTab === tab.id
                    ? 'bg-blue-600/20 text-blue-300 border border-blue-500/40'
                    : 'text-slate-400 hover:text-slate-200 border border-transparent hover:bg-slate-900'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="h-40 rounded-xl border border-slate-800/80 bg-[#0D1526] animate-pulse" />
          ) : (
            <div className="space-y-4">
              {activeTab === 'pending' &&
                (pendingItems.length === 0 ? (
                  <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-8 text-center text-xs text-slate-400">
                    No pending extracted email items waiting for review. Click &ldquo;Sync Now&rdquo;
                    to check for recent emails.
                  </div>
                ) : (
                  pendingItems.map(renderItemCard)
                ))}

              {activeTab === 'conflicts' &&
                (conflictOrPlanItems.length === 0 ? (
                  <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-8 text-center text-xs text-slate-400">
                    No conflicts, plan changes, or updates to existing workspace items detected.
                  </div>
                ) : (
                  conflictOrPlanItems.map(renderItemCard)
                ))}

              {activeTab === 'relationships' &&
                (pendingRels.length === 0 ? (
                  <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-8 text-center text-xs text-slate-400">
                    No pending relationship suggestions waiting for approval.
                  </div>
                ) : (
                  pendingRels.map(renderRelationshipCard)
                ))}

              {activeTab === 'messages' &&
                (messages.length === 0 ? (
                  <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-8 text-center text-xs text-slate-400">
                    No Gmail messages synchronized yet.
                  </div>
                ) : (
                  <div className="space-y-3">
                    {messages.map((msg) => {
                      const isExpanded = expandedMsgId === msg.id;
                      const statusStyle = (status: ExtractionStatus): string => {
                        switch (status) {
                          case 'COMPLETED':
                            return 'text-teal-400';
                          case 'PROCESSING':
                            return 'text-blue-300';
                          case 'RETRYING':
                            return 'text-amber-300';
                          case 'FAILED':
                            return 'text-rose-400';
                          case 'PENDING':
                          case 'SKIPPED':
                          default:
                            return 'text-slate-300';
                        }
                      };
                      const canRetryMsg =
                        msg.extractionStatus === 'FAILED' ||
                        msg.extractionStatus === 'RETRYING' ||
                        msg.extractionStatus === 'SKIPPED';
                      return (
                        <article
                          key={msg.id}
                          className="rounded-xl border border-slate-800/90 bg-[#0D1526] p-5 space-y-3"
                        >
                          <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                            <div className="space-y-1 min-w-0">
                              <div className="flex flex-wrap items-center gap-2 text-xs">
                                <span
                                  className={`font-mono font-semibold ${statusStyle(msg.extractionStatus)}`}
                                >
                                  {msg.extractionStatus}
                                </span>
                                {msg.retryCount > 0 && msg.extractionStatus !== 'COMPLETED' && (
                                  <span className="font-mono text-[11px] text-slate-400">
                                    (attempt {msg.retryCount}/{msg.maxRetries})
                                  </span>
                                )}
                                {msg.extractionStatus === 'RETRYING' && msg.nextRetryAt && (
                                  <span className="font-mono text-[11px] text-amber-300/90">
                                    · next retry {formatTimestamp(msg.nextRetryAt)}
                                  </span>
                                )}
                                <span className="text-slate-600" aria-hidden="true">
                                  ·
                                </span>
                                <span className="font-mono tabular-nums text-slate-400">
                                  {formatTimestamp(msg.receivedAt)}
                                </span>
                              </div>
                              <h3 className="text-sm font-semibold text-slate-100">{msg.subject}</h3>
                              <div className="text-xs text-slate-400">
                                From: <span className="text-slate-200">{msg.sender}</span>
                                {msg.recipients.length > 0 && (
                                  <>
                                    {' '}
                                    · To:{' '}
                                    <span className="text-slate-300">
                                      {msg.recipients.join(', ')}
                                    </span>
                                  </>
                                )}
                              </div>
                            </div>

                            <div className="flex flex-wrap items-center gap-2 shrink-0">
                              {canRetryMsg && (
                                <button
                                  type="button"
                                  onClick={() => handleRetryFailed(msg.id)}
                                  disabled={retryingQueue || busyId === msg.id}
                                  className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg border border-amber-500/40 bg-amber-500/10 text-amber-200 hover:bg-amber-500/20 disabled:opacity-50"
                                >
                                  <RefreshCw
                                    className={`h-3.5 w-3.5 ${busyId === msg.id ? 'animate-spin' : ''}`}
                                  />
                                  <span>Retry</span>
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => setExpandedMsgId(isExpanded ? null : msg.id)}
                                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs rounded-lg border border-slate-700 bg-slate-900 text-slate-300 hover:text-white"
                              >
                                {isExpanded ? (
                                  <>
                                    <ChevronUp className="h-3.5 w-3.5" />
                                    <span>Hide Text</span>
                                  </>
                                ) : (
                                  <>
                                    <ChevronDown className="h-3.5 w-3.5" />
                                    <span>Inspect Sanitized Text</span>
                                  </>
                                )}
                              </button>
                            </div>
                          </div>

                          {msg.snippet && (
                            <p className="text-xs text-slate-400 leading-relaxed">{msg.snippet}</p>
                          )}

                          {msg.extractionError && (
                            <div
                              className={`rounded-lg border px-3 py-2 text-xs flex items-center gap-2 ${
                                msg.extractionStatus === 'RETRYING'
                                  ? 'border-amber-500/30 bg-amber-500/10 text-amber-200'
                                  : 'border-rose-500/30 bg-rose-500/10 text-rose-200'
                              }`}
                            >
                              <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
                              <span>Extraction notice: {msg.extractionError}</span>
                            </div>
                          )}

                          {isExpanded && (
                            <pre className="rounded-lg border border-slate-800 bg-slate-950/70 p-4 text-xs text-slate-300 whitespace-pre-wrap font-sans leading-relaxed max-h-80 overflow-y-auto">
                              {msg.bodyText || '(Empty plain-text body)'}
                            </pre>
                          )}
                        </article>
                      );
                    })}
                  </div>
                ))}

              {activeTab === 'history' &&
                (reviewedItems.length === 0 && reviewedRels.length === 0 ? (
                  <div className="rounded-xl border border-slate-800 bg-[#0D1526] p-8 text-center text-xs text-slate-400">
                    No reviewed email items or relationships yet.
                  </div>
                ) : (
                  <div className="space-y-4">
                    {reviewedItems.map(renderItemCard)}
                    {reviewedRels.map(renderRelationshipCard)}
                  </div>
                ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
