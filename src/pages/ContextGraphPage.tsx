import { useEffect, useMemo, useState } from 'react';
import {
  Calendar,
  CheckSquare,
  Clock,
  Database,
  Edit3,
  FileText,
  FolderKanban,
  Link2,
  Mail,
  Maximize2,
  Plus,
  Search,
  Trash2,
  User,
  X,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import type { WorkspaceApi } from '../api/client.ts';
import type {
  ContextEdge,
  ContextNode,
  FactStatus,
  ImpactAnalysisResult,
  NodeType,
  RelationshipType,
  SourceRecord,
  WorkspaceMode,
} from '../types/maya.ts';
import { formatDisplayDate } from '../utils/format.ts';
import { FactMarker } from '../components/FactMarker.tsx';

interface ContextGraphPageProps {
  mode: WorkspaceMode;
  workspaceApi: WorkspaceApi;
  nodes: ContextNode[];
  edges: ContextEdge[];
  sourceRecords: SourceRecord[];
  latestAnalysis: ImpactAnalysisResult | null;
  onRefresh: () => Promise<void>;
}

const NODE_COLORS: Record<NodeType, { fill: string; stroke: string; text: string; label: string }> = {
  PROJECT: { fill: '#172554', stroke: '#3B82F6', text: '#93C5FD', label: 'Project' },
  DEADLINE: { fill: '#451A03', stroke: '#F59E0B', text: '#FCD34D', label: 'Deadline' },
  TASK: { fill: '#042F2E', stroke: '#14B8A6', text: '#5EEAD4', label: 'Task' },
  MEETING: { fill: '#2E1065', stroke: '#8B5CF6', text: '#C4B5FD', label: 'Meeting' },
  PERSON: { fill: '#0F172A', stroke: '#38BDF8', text: '#BAE6FD', label: 'Person' },
  DOCUMENT: { fill: '#1E1B4B', stroke: '#6366F1', text: '#A5B4FC', label: 'Document' },
  EMAIL: { fill: '#083344', stroke: '#06B6D4', text: '#67E8F9', label: 'Email' },
  SOURCE_RECORD: { fill: '#0F172A', stroke: '#64748B', text: '#CBD5E1', label: 'Source Record' },
};

function getNodeIcon(type: NodeType) {
  switch (type) {
    case 'PROJECT':
      return FolderKanban;
    case 'DEADLINE':
      return Clock;
    case 'TASK':
      return CheckSquare;
    case 'MEETING':
      return Calendar;
    case 'PERSON':
      return User;
    case 'DOCUMENT':
      return FileText;
    case 'EMAIL':
      return Mail;
    default:
      return Database;
  }
}

export function ContextGraphPage({
  mode,
  workspaceApi,
  nodes,
  edges,
  sourceRecords,
  latestAnalysis,
  onRefresh,
}: ContextGraphPageProps) {
  const [search, setSearch] = useState('');
  const [typeFilter, setTypeFilter] = useState<NodeType | 'ALL'>('ALL');
  const [factFilter, setFactFilter] = useState<'ALL' | FactStatus>('ALL');
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [positions, setPositions] = useState<Record<string, { x: number; y: number }>>({});
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [panning, setPanning] = useState<{ startX: number; startY: number } | null>(null);

  // Modals & edit states
  const [showAddNode, setShowAddNode] = useState(false);
  const [showAddEdge, setShowAddEdge] = useState(false);
  const [showAddSource, setShowAddSource] = useState(false);
  const [editingNode, setEditingNode] = useState(false);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Add Node form
  const [newNodeType, setNewNodeType] = useState<NodeType>('PROJECT');
  const [newNodeTitle, setNewNodeTitle] = useState('');
  const [newNodeSubtitle, setNewNodeSubtitle] = useState('');
  const [newNodeDate, setNewNodeDate] = useState('2026-12-01T15:00');
  const [newNodeFactStatus, setNewNodeFactStatus] = useState<FactStatus>('CONFIRMED');
  const [newNodeProjectId, setNewNodeProjectId] = useState('');

  // Add Edge form
  const [edgeSourceId, setEdgeSourceId] = useState('');
  const [edgeTargetId, setEdgeTargetId] = useState('');
  const [edgeRelType, setEdgeRelType] = useState<RelationshipType>('DEPENDS_ON');
  const [edgeEvidence, setEdgeEvidence] = useState('');
  const [edgeFactStatus, setEdgeFactStatus] = useState<FactStatus>('CONFIRMED');

  // Add Source form
  const [srcType, setSrcType] = useState<SourceRecord['sourceType']>('DOCUMENT');
  const [srcSender, setSrcSender] = useState('');
  const [srcTitle, setSrcTitle] = useState('');
  const [srcContent, setSrcContent] = useState('');
  const [srcProjectId, setSrcProjectId] = useState('');

  // Edit Node form
  const [editTitle, setEditTitle] = useState('');
  const [editSubtitle, setEditSubtitle] = useState('');
  const [editStatus, setEditStatus] = useState('');
  const [editDate, setEditDate] = useState('');
  const [editFactStatus, setEditFactStatus] = useState<FactStatus>('CONFIRMED');

  // Reset layout & selection cleanly when workspace mode or node set changes significantly
  useEffect(() => {
    setSelectedNodeId((prev) => (prev && nodes.some((n) => n.id === prev) ? prev : nodes[0]?.id ?? null));
    setEditingNode(false);
    setConfirmDeleteId(null);
  }, [mode, nodes]);

  // Deterministic radial/tiered layout by node type
  useEffect(() => {
    setPositions((prev) => {
      const next: Record<string, { x: number; y: number }> = {};
      const columnByType: Record<NodeType, number> = {
        EMAIL: 110,
        SOURCE_RECORD: 110,
        PERSON: 310,
        PROJECT: 560,
        DEADLINE: 560,
        TASK: 830,
        MEETING: 1080,
        DOCUMENT: 1080,
      };

      const buckets: Record<number, ContextNode[]> = {};
      for (const n of nodes) {
        const col = columnByType[n.type] ?? 560;
        if (!buckets[col]) buckets[col] = [];
        buckets[col].push(n);
      }

      for (const [colStr, list] of Object.entries(buckets)) {
        const colX = Number(colStr);
        const totalHeight = Math.max(460, list.length * 92);
        const startY = Math.max(70, (660 - totalHeight) / 2 + 40);

        list.forEach((n, idx) => {
          if (prev[n.id]) {
            next[n.id] = prev[n.id];
          } else {
            const xOffset =
              n.type === 'DEADLINE' ? 95 : n.type === 'DOCUMENT' ? 50 : idx % 2 === 1 ? 26 : -20;
            next[n.id] = {
              x: colX + xOffset,
              y: startY + idx * 92,
            };
          }
        });
      }
      return next;
    });
  }, [nodes]);

  const impactedNodeSet = useMemo(() => {
    const map = new Map<string, 'DIRECT' | 'DOWNSTREAM'>();
    if (!latestAnalysis) return map;
    for (const d of latestAnalysis.directImpacts) map.set(d.nodeId, 'DIRECT');
    for (const d of latestAnalysis.downstreamImpacts) {
      if (!map.has(d.nodeId)) map.set(d.nodeId, 'DOWNSTREAM');
    }
    return map;
  }, [latestAnalysis]);

  const filteredNodes = useMemo(() => {
    const q = search.trim().toLowerCase();
    return nodes.filter((n) => {
      if (typeFilter !== 'ALL' && n.type !== typeFilter) return false;
      if (factFilter !== 'ALL' && n.factStatus !== factFilter) return false;
      if (
        q &&
        !n.title.toLowerCase().includes(q) &&
        !n.subtitle.toLowerCase().includes(q) &&
        !n.provenance.toLowerCase().includes(q)
      ) {
        return false;
      }
      return true;
    });
  }, [nodes, search, typeFilter, factFilter]);

  const filteredNodeIds = useMemo(() => new Set(filteredNodes.map((n) => n.id)), [filteredNodes]);

  const visibleEdges = useMemo(
    () => edges.filter((e) => filteredNodeIds.has(e.sourceId) && filteredNodeIds.has(e.targetId)),
    [edges, filteredNodeIds],
  );

  const selectedNode = useMemo(
    () => nodes.find((n) => n.id === selectedNodeId) ?? filteredNodes[0] ?? null,
    [nodes, selectedNodeId, filteredNodes],
  );

  const connectedEdges = useMemo(() => {
    if (!selectedNode) return [];
    return edges.filter((e) => e.sourceId === selectedNode.id || e.targetId === selectedNode.id);
  }, [edges, selectedNode]);

  const nodesById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const sourcesById = useMemo(
    () => new Map(sourceRecords.map((s) => [s.id, s])),
    [sourceRecords],
  );

  const startEditNode = () => {
    if (!selectedNode) return;
    setEditTitle(selectedNode.title);
    setEditSubtitle(selectedNode.subtitle);
    setEditStatus(selectedNode.status);
    setEditDate(selectedNode.date ?? '');
    setEditFactStatus(selectedNode.factStatus);
    setEditingNode(true);
    setActionError(null);
  };

  const handleSaveNodeEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedNode) return;
    setSaving(true);
    setActionError(null);
    try {
      await workspaceApi.updateNode(selectedNode.id, {
        title: editTitle,
        subtitle: editSubtitle,
        status: editStatus,
        date: editDate.trim() ? editDate.trim() : null,
        factStatus: editFactStatus,
      });
      setEditingNode(false);
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to update node');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteNode = async (id: string) => {
    setSaving(true);
    setActionError(null);
    try {
      await workspaceApi.deleteNode(id);
      setConfirmDeleteId(null);
      setSelectedNodeId(null);
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete node');
    } finally {
      setSaving(false);
    }
  };

  const handleDeleteEdge = async (edgeId: string) => {
    setSaving(true);
    setActionError(null);
    try {
      await workspaceApi.deleteEdge(edgeId);
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to delete relationship');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateNode = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newNodeTitle.trim()) return;
    setSaving(true);
    setActionError(null);
    try {
      const created = await workspaceApi.createNode({
        type: newNodeType,
        title: newNodeTitle,
        subtitle: newNodeSubtitle,
        date: newNodeDate.trim() ? newNodeDate.trim() : null,
        projectId: newNodeProjectId || null,
        factStatus: newNodeFactStatus,
      });
      if (newNodeProjectId && newNodeType !== 'PROJECT' && newNodeType !== 'PERSON') {
        const relType: RelationshipType =
          newNodeType === 'TASK' || newNodeType === 'DEADLINE' ? 'BELONGS_TO' : 'RELATES_TO';
        await workspaceApi.createEdge({
          sourceId: created.id,
          targetId: newNodeProjectId,
          relationshipType: relType,
          evidenceText: `Linked "${created.title}" to project.`,
        });
      }
      setShowAddNode(false);
      setNewNodeTitle('');
      setNewNodeSubtitle('');
      setSelectedNodeId(created.id);
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create node');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateEdge = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!edgeSourceId || !edgeTargetId) return;
    setSaving(true);
    setActionError(null);
    try {
      await workspaceApi.createEdge({
        sourceId: edgeSourceId,
        targetId: edgeTargetId,
        relationshipType: edgeRelType,
        evidenceText: edgeEvidence,
        factStatus: edgeFactStatus,
      });
      setShowAddEdge(false);
      setEdgeEvidence('');
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to create edge');
    } finally {
      setSaving(false);
    }
  };

  const handleCreateSource = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!srcTitle.trim() || !srcContent.trim()) return;
    setSaving(true);
    setActionError(null);
    try {
      await workspaceApi.createSourceRecord({
        sourceType: srcType,
        sender: srcSender || 'Workspace User',
        title: srcTitle,
        content: srcContent,
        projectId: srcProjectId || null,
      });
      setShowAddSource(false);
      setSrcTitle('');
      setSrcContent('');
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Failed to add source record');
    } finally {
      setSaving(false);
    }
  };

  const projectNodes = nodes.filter((n) => n.type === 'PROJECT');

  return (
    <div className="space-y-4">
      {/* Filter & Action Toolbar */}
      <div className="rounded-xl border border-slate-800/80 bg-[#0D1526] p-4 flex flex-col xl:flex-row xl:items-center xl:justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-[220px] flex-1 sm:flex-initial">
            <Search className="h-4 w-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search entities or provenance..."
              className="w-full rounded-lg border border-slate-700/80 bg-slate-900/80 pl-9 pr-3 py-1.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
            />
          </div>

          <div className="flex flex-wrap items-center gap-1 p-1 rounded-lg bg-slate-900/80 border border-slate-800">
            {(
              ['ALL', 'PROJECT', 'DEADLINE', 'TASK', 'MEETING', 'PERSON', 'DOCUMENT', 'EMAIL'] as const
            ).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTypeFilter(t)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  typeFilter === t
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {t === 'ALL' ? 'All Types' : NODE_COLORS[t].label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-900/80 border border-slate-800">
            {(['ALL', 'CONFIRMED', 'INFERRED'] as const).map((f) => (
              <button
                key={f}
                type="button"
                onClick={() => setFactFilter(f)}
                className={`px-2.5 py-1 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
                  factFilter === f
                    ? 'bg-teal-600/30 text-teal-200 border border-teal-500/40'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {f === 'ALL' ? 'All Facts' : f === 'CONFIRMED' ? 'Confirmed' : 'Inferred'}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={() => {
              setActionError(null);
              setNewNodeProjectId(projectNodes[0]?.id ?? '');
              setShowAddNode(true);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="h-3.5 w-3.5" />
            <span>Add Node</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setActionError(null);
              setEdgeSourceId(selectedNode?.id ?? nodes[0]?.id ?? '');
              setEdgeTargetId(nodes[1]?.id ?? nodes[0]?.id ?? '');
              setShowAddEdge(true);
            }}
            disabled={nodes.length < 2}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0 disabled:opacity-40"
          >
            <Link2 className="h-3.5 w-3.5" />
            <span>Link Relationship</span>
          </button>
          <button
            type="button"
            onClick={() => {
              setActionError(null);
              setSrcProjectId(projectNodes[0]?.id ?? '');
              setShowAddSource(true);
            }}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <FileText className="h-3.5 w-3.5" />
            <span>Add Source Record</span>
          </button>
        </div>
      </div>

      {/* Empty Workspace State vs Interactive Canvas */}
      {nodes.length === 0 ? (
        <div className="rounded-xl border border-slate-800/80 bg-[#0D1526] p-12 text-center space-y-4">
          <h3 className="text-base font-semibold text-slate-100">
            Your Living Context Graph is Empty
          </h3>
          <p className="text-sm text-slate-400 max-w-lg mx-auto">
            Start by adding your first project, tasks, people, deadlines, or source documents. Then
            link relationships between them to unlock deterministic Ripple Impact Analysis.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3 pt-1">
            <button
              type="button"
              onClick={() => {
                setNewNodeType('PROJECT');
                setShowAddNode(true);
              }}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white"
            >
              <Plus className="h-3.5 w-3.5" />
              <span>Create First Project</span>
            </button>
            <button
              type="button"
              onClick={() => setShowAddSource(true)}
              className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-lg border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800"
            >
              <FileText className="h-3.5 w-3.5" />
              <span>Add Source Record</span>
            </button>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-12 gap-5 items-stretch">
          {/* Interactive SVG Canvas */}
          <div className="lg:col-span-8 rounded-xl border border-slate-800/80 bg-[#080F1E] relative overflow-hidden min-h-[560px]">
            <div className="absolute top-3 left-3 z-10 flex flex-wrap items-center gap-3 rounded-lg border border-slate-800/90 bg-[#0D1526]/90 px-3 py-1.5 text-xs text-slate-300 backdrop-blur-sm">
              <span className="font-mono tabular-nums text-slate-400">
                {filteredNodes.length} nodes · {visibleEdges.length} links
              </span>
              <span aria-hidden="true" className="text-slate-700">
                |
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-4 h-0.5 bg-slate-400 inline-block" />
                <span>Confirmed</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span className="w-4 h-0.5 border-t border-dashed border-violet-400 inline-block" />
                <span>Inferred</span>
              </span>
              {latestAnalysis && (
                <span className="inline-flex items-center gap-1.5 text-amber-300">
                  <span className="w-2.5 h-2.5 rounded-sm border border-amber-400 bg-amber-500/20 inline-block" />
                  <span>Impacted</span>
                </span>
              )}
            </div>

            <div className="absolute top-3 right-3 z-10 flex items-center gap-1 rounded-lg border border-slate-800/90 bg-[#0D1526]/90 p-1">
              <button
                type="button"
                onClick={() => setZoom((z) => Math.min(1.6, +(z + 0.15).toFixed(2)))}
                className="p-1.5 rounded text-slate-300 hover:bg-slate-800"
                aria-label="Zoom in"
              >
                <ZoomIn className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setZoom((z) => Math.max(0.55, +(z - 0.15).toFixed(2)))}
                className="p-1.5 rounded text-slate-300 hover:bg-slate-800"
                aria-label="Zoom out"
              >
                <ZoomOut className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => {
                  setZoom(1);
                  setPan({ x: 0, y: 0 });
                }}
                className="p-1.5 rounded text-slate-300 hover:bg-slate-800"
                aria-label="Reset view"
              >
                <Maximize2 className="h-4 w-4" />
              </button>
            </div>

            <svg
              className="w-full h-[580px] cursor-grab active:cursor-grabbing select-none"
              viewBox="0 0 1240 680"
              onMouseDown={(e) => {
                if ((e.target as HTMLElement).tagName.toLowerCase() === 'svg') {
                  setPanning({ startX: e.clientX - pan.x, startY: e.clientY - pan.y });
                }
              }}
              onMouseMove={(e) => {
                if (draggingId) {
                  const svgEl = e.currentTarget;
                  const rect = svgEl.getBoundingClientRect();
                  const scaleX = 1240 / rect.width;
                  const scaleY = 680 / rect.height;
                  const rawX = (e.clientX - rect.left) * scaleX;
                  const rawY = (e.clientY - rect.top) * scaleY;
                  setPositions((prev) => ({
                    ...prev,
                    [draggingId]: {
                      x: (rawX - pan.x) / zoom,
                      y: (rawY - pan.y) / zoom,
                    },
                  }));
                } else if (panning) {
                  setPan({
                    x: e.clientX - panning.startX,
                    y: e.clientY - panning.startY,
                  });
                }
              }}
              onMouseUp={() => {
                setDraggingId(null);
                setPanning(null);
              }}
              onMouseLeave={() => {
                setDraggingId(null);
                setPanning(null);
              }}
            >
              <defs>
                <pattern id="maya-grid" width="40" height="40" patternUnits="userSpaceOnUse">
                  <path
                    d="M 40 0 L 0 0 0 40"
                    fill="none"
                    stroke="#1E293B"
                    strokeWidth="0.6"
                    strokeOpacity="0.45"
                  />
                </pattern>
                <marker
                  id="arrow-confirmed"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 10 5 L 0 9 z" fill="#475569" />
                </marker>
                <marker
                  id="arrow-inferred"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 10 5 L 0 9 z" fill="#8B5CF6" />
                </marker>
                <marker
                  id="arrow-impact"
                  viewBox="0 0 10 10"
                  refX="9"
                  refY="5"
                  markerWidth="6"
                  markerHeight="6"
                  orient="auto-start-reverse"
                >
                  <path d="M 0 1 L 10 5 L 0 9 z" fill="#F59E0B" />
                </marker>
              </defs>

              <rect width="1240" height="680" fill="url(#maya-grid)" />

              <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
                {visibleEdges.map((edge) => {
                  const sPos = positions[edge.sourceId];
                  const tPos = positions[edge.targetId];
                  if (!sPos || !tPos) return null;

                  const isHighlighted =
                    selectedNode &&
                    (edge.sourceId === selectedNode.id || edge.targetId === selectedNode.id);
                  const isImpactEdge =
                    impactedNodeSet.has(edge.sourceId) && impactedNodeSet.has(edge.targetId);

                  const strokeColor = isImpactEdge
                    ? '#F59E0B'
                    : isHighlighted
                      ? '#38BDF8'
                      : edge.factStatus === 'INFERRED'
                        ? '#8B5CF6'
                        : '#475569';

                  const midX = (sPos.x + tPos.x) / 2;
                  const midY = (sPos.y + tPos.y) / 2 - 10;

                  return (
                    <g key={edge.id}>
                      <line
                        x1={sPos.x}
                        y1={sPos.y}
                        x2={tPos.x}
                        y2={tPos.y}
                        stroke={strokeColor}
                        strokeWidth={isHighlighted || isImpactEdge ? 2 : 1.25}
                        strokeOpacity={isHighlighted || isImpactEdge ? 0.95 : 0.55}
                        strokeDasharray={edge.factStatus === 'INFERRED' ? '5 4' : undefined}
                        markerEnd={
                          isImpactEdge
                            ? 'url(#arrow-impact)'
                            : edge.factStatus === 'INFERRED'
                              ? 'url(#arrow-inferred)'
                              : 'url(#arrow-confirmed)'
                        }
                      />
                      {isHighlighted && (
                        <text
                          x={midX}
                          y={midY}
                          textAnchor="middle"
                          fill="#CBD5E1"
                          fontSize="10"
                          fontFamily="JetBrains Mono, monospace"
                        >
                          {edge.relationshipType}
                        </text>
                      )}
                    </g>
                  );
                })}

                {filteredNodes.map((node) => {
                  const pos = positions[node.id];
                  if (!pos) return null;
                  const style = NODE_COLORS[node.type];
                  const isSelected = selectedNode?.id === node.id;
                  const impactKind = impactedNodeSet.get(node.id);

                  const boxW = node.type === 'PERSON' ? 142 : 168;
                  const boxH = 52;

                  return (
                    <g
                      key={node.id}
                      transform={`translate(${pos.x - boxW / 2}, ${pos.y - boxH / 2})`}
                      onMouseDown={(e) => {
                        e.stopPropagation();
                        setSelectedNodeId(node.id);
                        setEditingNode(false);
                        setConfirmDeleteId(null);
                        setDraggingId(node.id);
                      }}
                      className="cursor-pointer"
                    >
                      {impactKind && (
                        <rect
                          x={-4}
                          y={-4}
                          width={boxW + 8}
                          height={boxH + 8}
                          rx={node.type === 'PERSON' ? 28 : 11}
                          fill="none"
                          stroke={impactKind === 'DIRECT' ? '#F59E0B' : '#38BDF8'}
                          strokeWidth={1.5}
                          strokeDasharray={impactKind === 'DOWNSTREAM' ? '4 3' : undefined}
                        />
                      )}
                      <rect
                        width={boxW}
                        height={boxH}
                        rx={node.type === 'PERSON' ? 26 : 8}
                        fill={style.fill}
                        stroke={isSelected ? '#FFFFFF' : style.stroke}
                        strokeWidth={isSelected ? 2 : 1.2}
                        strokeDasharray={node.factStatus === 'INFERRED' ? '4 3' : undefined}
                      />
                      <text
                        x={12}
                        y={18}
                        fill={style.text}
                        fontSize="9.5"
                        fontWeight="600"
                        fontFamily="JetBrains Mono, monospace"
                      >
                        {style.label.toUpperCase()}
                        {node.factStatus === 'INFERRED' ? ' · INFERRED' : ''}
                      </text>
                      <text
                        x={12}
                        y={36}
                        fill="#F1F5F9"
                        fontSize="11.5"
                        fontWeight="500"
                        fontFamily="DM Sans, sans-serif"
                      >
                        {node.title.length > 22 ? `${node.title.slice(0, 21)}…` : node.title}
                      </text>
                    </g>
                  );
                })}
              </g>
            </svg>
          </div>

          {/* Right Node Inspector */}
          <aside className="lg:col-span-4 rounded-xl border border-slate-800/80 bg-[#0D1526] p-5 flex flex-col justify-between space-y-5 max-h-[580px] overflow-y-auto">
            {selectedNode ? (
              <div className="space-y-5">
                <div className="flex items-start justify-between gap-3">
                  <div className="space-y-1 min-w-0">
                    <div className="flex items-center gap-2 text-xs text-slate-400">
                      {(() => {
                        const Icon = getNodeIcon(selectedNode.type);
                        return <Icon className="h-3.5 w-3.5 text-blue-400" />;
                      })()}
                      <span>{NODE_COLORS[selectedNode.type].label}</span>
                      <span aria-hidden="true">·</span>
                      <span>{selectedNode.status}</span>
                    </div>
                    <h3 className="text-base font-semibold text-slate-100 break-words">
                      {selectedNode.title}
                    </h3>
                    {selectedNode.subtitle && (
                      <p className="text-xs text-slate-400 break-words">{selectedNode.subtitle}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      type="button"
                      onClick={startEditNode}
                      className="p-2 rounded-lg border border-slate-700/80 text-slate-300 hover:text-white hover:bg-slate-800 transition-colors"
                      aria-label="Edit node"
                    >
                      <Edit3 className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDeleteId(selectedNode.id)}
                      className="p-2 rounded-lg border border-rose-500/30 text-rose-300 hover:bg-rose-500/15 transition-colors"
                      aria-label="Delete node"
                    >
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>

                {confirmDeleteId === selectedNode.id && (
                  <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 space-y-2 text-xs">
                    <p className="text-rose-200">
                      Delete &ldquo;{selectedNode.title}&rdquo; and its connected links from this
                      workspace?
                    </p>
                    <div className="flex justify-end gap-2">
                      <button
                        type="button"
                        onClick={() => setConfirmDeleteId(null)}
                        className="px-2.5 py-1 text-slate-300 hover:text-white"
                      >
                        Cancel
                      </button>
                      <button
                        type="button"
                        disabled={saving}
                        onClick={() => handleDeleteNode(selectedNode.id)}
                        className="px-3 py-1 rounded bg-rose-600 text-white font-medium hover:bg-rose-500"
                      >
                        {saving ? 'Deleting...' : 'Confirm Delete'}
                      </button>
                    </div>
                  </div>
                )}

                {editingNode ? (
                  <form
                    onSubmit={handleSaveNodeEdit}
                    className="space-y-3 rounded-lg border border-slate-700/80 bg-slate-900/70 p-3.5"
                  >
                    <div className="text-xs font-semibold text-slate-200">Edit Context Node</div>
                    {actionError && <p className="text-xs text-rose-400">{actionError}</p>}
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Title</label>
                      <input
                        type="text"
                        value={editTitle}
                        onChange={(e) => setEditTitle(e.target.value)}
                        required
                        className="w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Subtitle</label>
                      <input
                        type="text"
                        value={editSubtitle}
                        onChange={(e) => setEditSubtitle(e.target.value)}
                        className="w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Date (ISO)</label>
                        <input
                          type="text"
                          value={editDate}
                          onChange={(e) => setEditDate(e.target.value)}
                          placeholder="2026-12-01T14:00"
                          className="w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100 font-mono"
                        />
                      </div>
                      <div>
                        <label className="block text-xs text-slate-400 mb-1">Status</label>
                        <input
                          type="text"
                          value={editStatus}
                          onChange={(e) => setEditStatus(e.target.value)}
                          className="w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100"
                        />
                      </div>
                    </div>
                    <div>
                      <label className="block text-xs text-slate-400 mb-1">Epistemic Status</label>
                      <select
                        value={editFactStatus}
                        onChange={(e) => setEditFactStatus(e.target.value as FactStatus)}
                        className="w-full rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-xs text-slate-100"
                      >
                        <option value="CONFIRMED">Confirmed Fact</option>
                        <option value="INFERRED">Inferred Relationship</option>
                      </select>
                    </div>
                    <div className="flex items-center justify-end gap-2 pt-1">
                      <button
                        type="button"
                        onClick={() => setEditingNode(false)}
                        className="px-3 py-1.5 text-xs text-slate-400 hover:text-slate-200"
                      >
                        Cancel
                      </button>
                      <button
                        type="submit"
                        disabled={saving}
                        className="px-3 py-1.5 text-xs font-medium rounded-md bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
                      >
                        {saving ? 'Saving...' : 'Save Changes'}
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="space-y-2.5 text-xs border-y border-slate-800/80 py-3.5">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">Epistemic Status</span>
                      <FactMarker status={selectedNode.factStatus} />
                    </div>
                    <div className="flex items-center justify-between">
                      <span className="text-slate-400">Scheduled Date</span>
                      <span className="font-mono tabular-nums text-slate-200">
                        {formatDisplayDate(selectedNode.date)}
                      </span>
                    </div>
                    <div className="flex items-start justify-between gap-4">
                      <span className="text-slate-400 shrink-0">Provenance</span>
                      <span className="text-slate-200 text-right">{selectedNode.provenance}</span>
                    </div>
                    {impactedNodeSet.has(selectedNode.id) && (
                      <div className="flex items-center justify-between pt-1">
                        <span className="text-slate-400">Ripple Impact</span>
                        <span className="font-medium text-amber-300">
                          {impactedNodeSet.get(selectedNode.id) === 'DIRECT'
                            ? 'Direct Impact'
                            : 'Downstream Impact'}
                        </span>
                      </div>
                    )}
                  </div>
                )}

                <div className="space-y-2.5">
                  <div className="text-xs font-semibold text-slate-300">
                    Connected Relationships ({connectedEdges.length})
                  </div>
                  {connectedEdges.length === 0 ? (
                    <p className="text-xs text-slate-500">
                      No relationships linked yet. Use &ldquo;Link Relationship&rdquo; above to
                      connect entities.
                    </p>
                  ) : (
                    <div className="space-y-2">
                      {connectedEdges.map((edge) => {
                        const isOutgoing = edge.sourceId === selectedNode.id;
                        const peerNode = nodesById.get(
                          isOutgoing ? edge.targetId : edge.sourceId,
                        );
                        const srcRecord = edge.sourceRecordId
                          ? sourcesById.get(edge.sourceRecordId)
                          : undefined;
                        return (
                          <div
                            key={edge.id}
                            className="rounded-lg border border-slate-800 bg-slate-900/50 p-3 space-y-1.5"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <button
                                type="button"
                                onClick={() => peerNode && setSelectedNodeId(peerNode.id)}
                                className="text-xs font-medium text-blue-300 hover:underline text-left"
                              >
                                {isOutgoing
                                  ? `-> ${edge.relationshipType} -> ${peerNode?.title ?? edge.targetId}`
                                  : `<- ${edge.relationshipType} <- ${peerNode?.title ?? edge.sourceId}`}
                              </button>
                              <button
                                type="button"
                                onClick={() => handleDeleteEdge(edge.id)}
                                className="text-slate-500 hover:text-rose-400 shrink-0"
                                aria-label="Remove relationship"
                              >
                                <X className="h-3.5 w-3.5" />
                              </button>
                            </div>
                            <div className="flex items-center justify-between">
                              <FactMarker status={edge.factStatus} />
                            </div>
                            {edge.evidenceText && (
                              <p className="text-xs text-slate-400 leading-relaxed">
                                {edge.evidenceText}
                              </p>
                            )}
                            <div className="text-[11px] text-slate-500">
                              Source: {srcRecord?.title ?? edge.provenance}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </div>
            ) : (
              <div className="text-center py-12 text-xs text-slate-400">
                Select any node on the canvas to inspect details, relationships, and evidence.
              </div>
            )}
          </aside>
        </div>
      )}

      {/* Add Node Modal */}
      {showAddNode && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-700 bg-[#0D1526] p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-100">Add Context Node</h3>
              <button
                type="button"
                onClick={() => setShowAddNode(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleCreateNode} className="space-y-3">
              {actionError && <p className="text-xs text-rose-400">{actionError}</p>}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Entity Type</label>
                  <select
                    value={newNodeType}
                    onChange={(e) => setNewNodeType(e.target.value as NodeType)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                  >
                    <option value="PROJECT">Project</option>
                    <option value="TASK">Task</option>
                    <option value="DEADLINE">Deadline</option>
                    <option value="MEETING">Meeting</option>
                    <option value="PERSON">Person</option>
                    <option value="DOCUMENT">Document</option>
                    <option value="EMAIL">Email</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Epistemic Status</label>
                  <select
                    value={newNodeFactStatus}
                    onChange={(e) => setNewNodeFactStatus(e.target.value as FactStatus)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                  >
                    <option value="CONFIRMED">Confirmed Fact</option>
                    <option value="INFERRED">Inferred</option>
                  </select>
                </div>
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Title</label>
                <input
                  type="text"
                  required
                  value={newNodeTitle}
                  onChange={(e) => setNewNodeTitle(e.target.value)}
                  placeholder="e.g., Launch Readiness Review"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                />
              </div>

              <div>
                <label className="block text-xs text-slate-400 mb-1">Description / Subtitle</label>
                <input
                  type="text"
                  value={newNodeSubtitle}
                  onChange={(e) => setNewNodeSubtitle(e.target.value)}
                  placeholder="Optional context summary"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">ISO Date (Optional)</label>
                  <input
                    type="text"
                    value={newNodeDate}
                    onChange={(e) => setNewNodeDate(e.target.value)}
                    placeholder="2026-12-01T15:00"
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100 font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Parent Project</label>
                  <select
                    value={newNodeProjectId}
                    onChange={(e) => setNewNodeProjectId(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                  >
                    <option value="">None</option>
                    {projectNodes.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddNode(false)}
                  className="px-4 py-2 text-xs text-slate-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  {saving ? 'Creating...' : 'Create Node'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Relationship Modal */}
      {showAddEdge && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-700 bg-[#0D1526] p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-100">Link Relationship</h3>
              <button
                type="button"
                onClick={() => setShowAddEdge(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleCreateEdge} className="space-y-3">
              {actionError && <p className="text-xs text-rose-400">{actionError}</p>}
              <div>
                <label className="block text-xs text-slate-400 mb-1">Source Node</label>
                <select
                  value={edgeSourceId}
                  onChange={(e) => setEdgeSourceId(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                >
                  {nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.type}: {n.title}
                    </option>
                  ))}
                </select>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Relationship</label>
                  <select
                    value={edgeRelType}
                    onChange={(e) => setEdgeRelType(e.target.value as RelationshipType)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                  >
                    <option value="DEPENDS_ON">DEPENDS_ON</option>
                    <option value="BELONGS_TO">BELONGS_TO</option>
                    <option value="ASSIGNED_TO">ASSIGNED_TO</option>
                    <option value="WORKS_ON">WORKS_ON</option>
                    <option value="RELATES_TO">RELATES_TO</option>
                    <option value="MENTIONS">MENTIONS</option>
                    <option value="ATTENDS">ATTENDS</option>
                    <option value="SUPPORTS">SUPPORTS</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Epistemic Status</label>
                  <select
                    value={edgeFactStatus}
                    onChange={(e) => setEdgeFactStatus(e.target.value as FactStatus)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                  >
                    <option value="CONFIRMED">Confirmed Fact</option>
                    <option value="INFERRED">Inferred</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Target Node</label>
                <select
                  value={edgeTargetId}
                  onChange={(e) => setEdgeTargetId(e.target.value)}
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                >
                  {nodes.map((n) => (
                    <option key={n.id} value={n.id}>
                      {n.type}: {n.title}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Supporting Evidence</label>
                <input
                  type="text"
                  value={edgeEvidence}
                  onChange={(e) => setEdgeEvidence(e.target.value)}
                  placeholder="Why does this relationship exist?"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddEdge(false)}
                  className="px-4 py-2 text-xs text-slate-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  {saving ? 'Linking...' : 'Create Link'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Add Source Record Modal */}
      {showAddSource && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-md rounded-xl border border-slate-700 bg-[#0D1526] p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-semibold text-slate-100">Add Source Record</h3>
              <button
                type="button"
                onClick={() => setShowAddSource(false)}
                className="text-slate-400 hover:text-white"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <form onSubmit={handleCreateSource} className="space-y-3">
              {actionError && <p className="text-xs text-rose-400">{actionError}</p>}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Source Type</label>
                  <select
                    value={srcType}
                    onChange={(e) => setSrcType(e.target.value as SourceRecord['sourceType'])}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                  >
                    <option value="DOCUMENT">Document</option>
                    <option value="EMAIL">Email</option>
                    <option value="CALENDAR">Calendar Note</option>
                    <option value="TASKS">Task Note</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Related Project</label>
                  <select
                    value={srcProjectId}
                    onChange={(e) => setSrcProjectId(e.target.value)}
                    className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                  >
                    <option value="">None</option>
                    {projectNodes.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Sender / Origin</label>
                <input
                  type="text"
                  value={srcSender}
                  onChange={(e) => setSrcSender(e.target.value)}
                  placeholder="e.g., Faculty Advisor"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Title</label>
                <input
                  type="text"
                  required
                  value={srcTitle}
                  onChange={(e) => setSrcTitle(e.target.value)}
                  placeholder="e.g., Milestone Specification v1"
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-sm text-slate-100"
                />
              </div>
              <div>
                <label className="block text-xs text-slate-400 mb-1">Content</label>
                <textarea
                  rows={3}
                  required
                  value={srcContent}
                  onChange={(e) => setSrcContent(e.target.value)}
                  placeholder="Evidence text, schedule commitments, or project details..."
                  className="w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-100"
                />
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddSource(false)}
                  className="px-4 py-2 text-xs text-slate-400 hover:text-white"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 text-white hover:bg-blue-500 disabled:opacity-50"
                >
                  {saving ? 'Saving...' : 'Save Source Record'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
