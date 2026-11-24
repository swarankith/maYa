import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  ArrowLeftRight,
  GitBranch,
  History,
  LayoutDashboard,
  LogIn,
  LogOut,
  Mail,
  Menu,
  Play,
  Plug,
  ShieldCheck,
  SlidersHorizontal,
  User as UserIcon,
  X,
} from 'lucide-react';
import { authApi, createWorkspaceApi } from './api/client.ts';
import type {
  ApprovalItem,
  AuditLogEntry,
  AuthSessionResponse,
  ContextEdge,
  ContextNode,
  DashboardSummary,
  IntegrationConnector,
  SourceRecord,
  UserProfile,
  WorkspaceInfo,
  WorkspaceMode,
} from './types/maya.ts';
import { AuthPage } from './pages/AuthPage.tsx';
import { DashboardPage, type NavTab } from './pages/DashboardPage.tsx';
import { ContextGraphPage } from './pages/ContextGraphPage.tsx';
import { ImpactLensPage } from './pages/ImpactLensPage.tsx';
import { SimulatorPage } from './pages/SimulatorPage.tsx';
import { ApprovalsPage } from './pages/ApprovalsPage.tsx';
import { AuditTrailPage } from './pages/AuditTrailPage.tsx';
import { IntegrationsPage } from './pages/IntegrationsPage.tsx';
import { EmailInsightsPage } from './pages/EmailInsightsPage.tsx';

const NAV_ITEMS: Array<{
  id: NavTab;
  label: string;
  icon: typeof LayoutDashboard;
}> = [
  { id: 'dashboard', label: 'Dashboard', icon: LayoutDashboard },
  { id: 'graph', label: 'Context Graph', icon: GitBranch },
  { id: 'inbox', label: 'Email Insights', icon: Mail },
  { id: 'impact', label: 'Impact Lens', icon: Activity },
  { id: 'simulator', label: 'What-if Simulator', icon: SlidersHorizontal },
  { id: 'approvals', label: 'Approvals', icon: ShieldCheck },
  { id: 'audit', label: 'Audit Trail', icon: History },
  { id: 'integrations', label: 'Integrations', icon: Plug },
];

export default function App() {
  const [mode, setMode] = useState<WorkspaceMode>('PERSONAL');
  const [authToken, setAuthToken] = useState<string | null>(null);
  const [user, setUser] = useState<UserProfile | null>(null);
  const [workspace, setWorkspace] = useState<WorkspaceInfo | null>(null);

  const [activeTab, setActiveTab] = useState<NavTab>('dashboard');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [demoRunning, setDemoRunning] = useState(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [nodes, setNodes] = useState<ContextNode[]>([]);
  const [edges, setEdges] = useState<ContextEdge[]>([]);
  const [sourceRecords, setSourceRecords] = useState<SourceRecord[]>([]);
  const [approvals, setApprovals] = useState<ApprovalItem[]>([]);
  const [auditLogs, setAuditLogs] = useState<AuditLogEntry[]>([]);
  const [integrations, setIntegrations] = useState<IntegrationConnector[]>([]);

  const clearWorkspaceCache = useCallback(() => {
    setSummary(null);
    setNodes([]);
    setEdges([]);
    setSourceRecords([]);
    setApprovals([]);
    setAuditLogs([]);
    setIntegrations([]);
    setErrorBanner(null);
  }, []);

  const workspaceApi = useMemo(
    () => createWorkspaceApi(mode, authToken),
    [mode, authToken],
  );

  const isActiveSession = mode === 'DEMO' || Boolean(authToken);

  const refreshAll = useCallback(async () => {
    if (!isActiveSession) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      setErrorBanner(null);
      const [dashData, graphData, aprData, auditData, intData] = await Promise.all([
        workspaceApi.getDashboard(),
        workspaceApi.getGraph(),
        workspaceApi.getApprovals(),
        workspaceApi.getAuditLogs(),
        workspaceApi.getIntegrations(),
      ]);
      setSummary(dashData);
      setNodes(graphData.nodes);
      setEdges(graphData.edges);
      setSourceRecords(graphData.sourceRecords);
      setApprovals(aprData);
      setAuditLogs(auditData);
      setIntegrations(intData);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Failed to synchronize context state';
      if (mode === 'PERSONAL' && /authentication|session|expired|401/i.test(msg)) {
        setAuthToken(null);
        setUser(null);
        setWorkspace(null);
        clearWorkspaceCache();
      } else {
        setErrorBanner(msg);
      }
    } finally {
      setLoading(false);
    }
  }, [isActiveSession, workspaceApi, mode, clearWorkspaceCache]);

  useEffect(() => {
    if (isActiveSession) {
      void refreshAll();
    } else {
      clearWorkspaceCache();
      setLoading(false);
    }
  }, [isActiveSession, refreshAll, clearWorkspaceCache]);

  const handleAuthenticated = (session: AuthSessionResponse) => {
    clearWorkspaceCache();
    setAuthToken(session.token);
    setUser(session.user);
    setWorkspace(session.workspace);
    setMode('PERSONAL');
    setActiveTab('dashboard');
    setMobileMenuOpen(false);
  };

  const handleEnterDemoMode = () => {
    clearWorkspaceCache();
    setMode('DEMO');
    setActiveTab('dashboard');
    setMobileMenuOpen(false);
  };

  const handleSwitchMode = (target: WorkspaceMode) => {
    if (target === mode) return;
    clearWorkspaceCache();
    setMode(target);
    setActiveTab('dashboard');
    setMobileMenuOpen(false);
  };

  const handleLogout = async () => {
    const tokenToRevoke = authToken;
    setAuthToken(null);
    setUser(null);
    setWorkspace(null);
    setMode('PERSONAL');
    setActiveTab('dashboard');
    setMobileMenuOpen(false);
    clearWorkspaceCache();
    if (tokenToRevoke) {
      try {
        await authApi.logout(tokenToRevoke);
      } catch {
        // Ignore network errors during logout cleanup
      }
    }
  };

  const handleRunDemo = async () => {
    if (mode !== 'DEMO') return;
    setDemoRunning(true);
    setErrorBanner(null);
    try {
      await workspaceApi.runDemo();
      await refreshAll();
      setActiveTab('impact');
      setMobileMenuOpen(false);
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to run maYa demo scenario');
    } finally {
      setDemoRunning(false);
    }
  };

  const handleResetDemo = async () => {
    if (mode !== 'DEMO') return;
    setDemoRunning(true);
    setErrorBanner(null);
    try {
      await workspaceApi.resetDemo();
      await refreshAll();
      setActiveTab('dashboard');
    } catch (err) {
      setErrorBanner(err instanceof Error ? err.message : 'Failed to reset demo baseline');
    } finally {
      setDemoRunning(false);
    }
  };

  if (mode === 'PERSONAL' && !authToken) {
    return (
      <AuthPage onAuthenticated={handleAuthenticated} onEnterDemoMode={handleEnterDemoMode} />
    );
  }

  const activeNavMeta = NAV_ITEMS.find((n) => n.id === activeTab) ?? NAV_ITEMS[0];
  const pendingApprovalCount = approvals.filter((a) => a.status === 'PENDING').length;
  const projectNodes = nodes.filter((n) => n.type === 'PROJECT');

  const navigateTo = (tab: NavTab) => {
    setActiveTab(tab);
    setMobileMenuOpen(false);
  };

  const SidebarContent = () => (
    <div className="flex flex-col h-full justify-between p-4 gap-4">
      <div className="space-y-6">
        {/* Brand Block */}
        <div className="px-2 pt-1 space-y-1">
          <div className="flex items-center justify-between">
            <span className="text-xl font-bold tracking-tight text-white font-display">
              ma<span className="text-blue-400">Y</span>a
            </span>
            <button
              type="button"
              onClick={() => setMobileMenuOpen(false)}
              className="lg:hidden p-1 text-slate-400 hover:text-white"
              aria-label="Close navigation"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
          <p className="text-xs text-slate-400">Your world. Connected. Understood.</p>
        </div>

        {/* Navigation Links */}
        <nav className="space-y-1" aria-label="Primary navigation">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const isActive = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => navigateTo(item.id)}
                className={`w-full flex items-center justify-between px-3 py-2.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                  isActive
                    ? 'bg-blue-600/15 text-blue-300 border border-blue-500/30'
                    : 'text-slate-400 hover:text-slate-100 hover:bg-slate-800/50 border border-transparent'
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <Icon
                    className={`h-4 w-4 shrink-0 ${isActive ? 'text-blue-400' : 'text-slate-500'}`}
                  />
                  <span>{item.label}</span>
                </span>
                {item.id === 'approvals' && pendingApprovalCount > 0 && (
                  <span className="text-xs font-mono tabular-nums text-amber-300">
                    {pendingApprovalCount}
                  </span>
                )}
                {item.id === 'inbox' &&
                  mode === 'PERSONAL' &&
                  (summary?.counts.pendingEmailInsights ?? 0) > 0 && (
                    <span className="text-xs font-mono tabular-nums text-blue-300">
                      {summary?.counts.pendingEmailInsights}
                    </span>
                  )}
              </button>
            );
          })}
        </nav>
      </div>

      {/* Workspace Mode & Account Isolation Footer */}
      <div className="space-y-2.5">
        <div
          className={`rounded-lg border p-3 space-y-2 ${
            mode === 'DEMO'
              ? 'border-amber-500/30 bg-amber-500/10'
              : 'border-slate-800/80 bg-slate-900/60'
          }`}
        >
          <div className="flex items-center justify-between gap-2">
            <span
              className={`text-xs font-semibold ${
                mode === 'DEMO' ? 'text-amber-300' : 'text-teal-400'
              }`}
            >
              {mode === 'DEMO' ? 'DEMO MODE' : 'Personal Workspace'}
            </span>
          </div>
          <p className="text-[11px] text-slate-400 leading-relaxed">
            {mode === 'DEMO'
              ? 'Isolated seeded showcase. Separate from personal accounts.'
              : workspace?.name ?? 'Private isolated SQLite context.'}
          </p>

          {authToken ? (
            <button
              type="button"
              onClick={() => handleSwitchMode(mode === 'DEMO' ? 'PERSONAL' : 'DEMO')}
              className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md border border-slate-700/80 bg-slate-900/90 text-[11px] font-medium text-slate-200 hover:bg-slate-800 transition-colors"
            >
              <ArrowLeftRight className="h-3 w-3 text-blue-400" />
              <span>
                {mode === 'DEMO' ? 'Return to Personal Workspace' : 'Open Isolated DEMO MODE'}
              </span>
            </button>
          ) : (
            <button
              type="button"
              onClick={() => handleSwitchMode('PERSONAL')}
              className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded-md bg-blue-600 hover:bg-blue-500 text-[11px] font-semibold text-white transition-colors"
            >
              <LogIn className="h-3 w-3" />
              <span>Sign In / Create Account</span>
            </button>
          )}
        </div>

        {user && (
          <div className="rounded-lg border border-slate-800/80 bg-slate-900/40 p-3 flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <UserIcon className="h-3.5 w-3.5 text-slate-400 shrink-0" />
              <div className="min-w-0">
                <div className="text-xs font-medium text-slate-200 truncate">
                  {user.displayName}
                </div>
                <div className="text-[11px] text-slate-500 truncate">{user.email}</div>
              </div>
            </div>
            <button
              type="button"
              onClick={handleLogout}
              className="p-1.5 rounded-md text-slate-400 hover:text-rose-300 hover:bg-slate-800 transition-colors shrink-0"
              aria-label="Sign out"
              title="Sign out"
            >
              <LogOut className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </div>
  );

  return (
    <div className="min-h-screen bg-[#070D19] text-slate-100 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:block w-[264px] shrink-0 border-r border-slate-800/80 bg-[#0A1120]">
        <div className="sticky top-0 h-screen overflow-y-auto">
          <SidebarContent />
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div
            className="fixed inset-0 bg-black/70"
            onClick={() => setMobileMenuOpen(false)}
          />
          <aside className="relative z-10 w-[272px] bg-[#0A1120] border-r border-slate-800 h-full overflow-y-auto">
            <SidebarContent />
          </aside>
        </div>
      )}

      {/* Main Workspace */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar */}
        <header className="sticky top-0 z-30 border-b border-slate-800/80 bg-[#070D19]/95 backdrop-blur-sm px-4 sm:px-6 py-3.5 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 rounded-lg border border-slate-800 text-slate-300 hover:bg-slate-800"
              aria-label="Open navigation"
            >
              <Menu className="h-4 w-4" />
            </button>
            <div className="flex items-center gap-2 text-sm min-w-0">
              <span className="text-slate-400 hidden sm:inline whitespace-nowrap">
                maYa · {mode === 'DEMO' ? 'DEMO MODE' : user?.displayName ?? 'Personal'}
              </span>
              <span className="text-slate-600 hidden sm:inline" aria-hidden="true">
                /
              </span>
              <h1 className="font-semibold text-slate-100 truncate">{activeNavMeta.label}</h1>
            </div>
          </div>

          <div className="shrink-0">
            {mode === 'DEMO' ? (
              <button
                type="button"
                onClick={handleRunDemo}
                disabled={demoRunning}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors whitespace-nowrap shrink-0 disabled:opacity-60"
              >
                <Play className="h-3.5 w-3.5" />
                <span>{demoRunning ? 'Running...' : 'Run maYa Demo'}</span>
              </button>
            ) : (
              <button
                type="button"
                onClick={() => navigateTo(projectNodes.length > 0 ? 'impact' : 'graph')}
                className="inline-flex items-center gap-2 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors whitespace-nowrap shrink-0"
              >
                {projectNodes.length > 0 ? (
                  <>
                    <Activity className="h-3.5 w-3.5" />
                    <span>Analyze Impact</span>
                  </>
                ) : (
                  <>
                    <GitBranch className="h-3.5 w-3.5" />
                    <span>Open Context Graph</span>
                  </>
                )}
              </button>
            )}
          </div>
        </header>

        {/* Main Viewport */}
        <main className="flex-1 p-4 sm:p-6 max-w-[1400px] w-full mx-auto space-y-5">
          {errorBanner && (
            <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 px-4 py-3 flex items-center justify-between gap-4 text-xs text-rose-200">
              <span>{errorBanner}</span>
              <button
                type="button"
                onClick={() => setErrorBanner(null)}
                className="text-rose-300 hover:text-white"
              >
                Dismiss
              </button>
            </div>
          )}

          {activeTab === 'dashboard' && (
            <DashboardPage
              mode={mode}
              workspaceApi={workspaceApi}
              summary={summary}
              loading={loading}
              demoRunning={demoRunning}
              onRunDemo={handleRunDemo}
              onResetDemo={handleResetDemo}
              onRefresh={refreshAll}
              onNavigate={navigateTo}
            />
          )}

          {activeTab === 'graph' && (
            <ContextGraphPage
              mode={mode}
              workspaceApi={workspaceApi}
              nodes={nodes}
              edges={edges}
              sourceRecords={sourceRecords}
              latestAnalysis={summary?.latestAnalysis ?? null}
              onRefresh={refreshAll}
            />
          )}

          {activeTab === 'impact' && (
            <ImpactLensPage
              mode={mode}
              workspaceApi={workspaceApi}
              analysis={summary?.latestAnalysis ?? null}
              sourceRecords={sourceRecords}
              projects={projectNodes}
              demoRunning={demoRunning}
              onRunDemo={handleRunDemo}
              onAnalysisCreated={refreshAll}
              onGoToSimulator={() => navigateTo('simulator')}
              onGoToGraph={() => navigateTo('graph')}
            />
          )}

          {activeTab === 'simulator' && (
            <SimulatorPage
              mode={mode}
              workspaceApi={workspaceApi}
              analysis={summary?.latestAnalysis ?? null}
              plans={summary?.latestPlans ?? []}
              demoRunning={demoRunning}
              onRunDemo={handleRunDemo}
              onPlanSelected={refreshAll}
              onGoToApprovals={() => navigateTo('approvals')}
              onGoToImpact={() => navigateTo('impact')}
            />
          )}

          {activeTab === 'approvals' && (
            <ApprovalsPage
              mode={mode}
              workspaceApi={workspaceApi}
              approvals={approvals}
              onRefresh={refreshAll}
              onGoToSimulator={() => navigateTo('simulator')}
              onGoToAudit={() => navigateTo('audit')}
            />
          )}

          {activeTab === 'inbox' && (
            <EmailInsightsPage
              mode={mode}
              workspaceApi={workspaceApi}
              workspaceNodes={nodes}
              onRefresh={refreshAll}
              onGoToIntegrations={() => navigateTo('integrations')}
              onGoToGraph={() => navigateTo('graph')}
            />
          )}

          {activeTab === 'audit' && <AuditTrailPage logs={auditLogs} />}

          {activeTab === 'integrations' && (
            <IntegrationsPage
              mode={mode}
              workspaceApi={workspaceApi}
              integrations={integrations}
              onRefresh={refreshAll}
              onGoToEmailInsights={() => navigateTo('inbox')}
            />
          )}
        </main>
      </div>
    </div>
  );
}

