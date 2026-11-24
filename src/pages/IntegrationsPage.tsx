import { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArrowRight,
  Calendar,
  CheckSquare,
  ExternalLink,
  Lock,
  Mail,
  RefreshCw,
  ShieldCheck,
  TerminalSquare,
  Unplug,
} from 'lucide-react';
import type { WorkspaceApi } from '../api/client.ts';
import type {
  GmailConnectionStatus,
  GmailSyncResult,
  IntegrationConnector,
  WorkspaceMode,
} from '../types/maya.ts';
import { formatTimestamp } from '../utils/format.ts';

interface IntegrationsPageProps {
  mode: WorkspaceMode;
  workspaceApi: WorkspaceApi;
  integrations: IntegrationConnector[];
  onRefresh: () => Promise<void>;
  onGoToEmailInsights: () => void;
}

interface GoogleCodeResponse {
  code?: string;
  scope?: string;
  state?: string;
  error?: string;
  error_description?: string;
}

interface GoogleCodeClientError {
  type?: string;
  message?: string;
}

interface GoogleAccountsWindow extends Window {
  google?: {
    accounts?: {
      oauth2?: {
        initCodeClient: (config: {
          client_id: string;
          scope: string;
          ux_mode?: 'popup' | 'redirect';
          select_account?: boolean;
          include_granted_scopes?: boolean;
          state?: string;
          callback: (response: GoogleCodeResponse) => void;
          error_callback?: (error: GoogleCodeClientError) => void;
        }) => { requestCode: () => void };
      };
    };
  };
}

const GMAIL_READONLY_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

function waitForGoogleIdentity(): Promise<NonNullable<NonNullable<GoogleAccountsWindow['google']>['accounts']>['oauth2']> {
  const gWindow = window as GoogleAccountsWindow;
  const existing = gWindow.google?.accounts?.oauth2;
  if (existing) {
    return Promise.resolve(existing);
  }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let scriptEl = document.querySelector<HTMLScriptElement>(
      'script[src="https://accounts.google.com/gsi/client"]',
    );
    if (!scriptEl) {
      scriptEl = document.createElement('script');
      scriptEl.src = 'https://accounts.google.com/gsi/client';
      scriptEl.async = true;
      scriptEl.defer = true;
      document.head.appendChild(scriptEl);
    }

    const checkInterval = window.setInterval(() => {
      const oauth2 = (window as GoogleAccountsWindow).google?.accounts?.oauth2;
      if (oauth2) {
        window.clearInterval(checkInterval);
        resolve(oauth2);
      } else if (Date.now() - startedAt > 5000) {
        window.clearInterval(checkInterval);
        reject(new Error('Google Identity Services could not be loaded.'));
      }
    }, 50);

    scriptEl.addEventListener(
      'error',
      () => {
        window.clearInterval(checkInterval);
        reject(new Error('Failed to load Google Identity Services script.'));
      },
      { once: true },
    );
  });
}

export function IntegrationsPage({
  mode,
  workspaceApi,
  integrations,
  onRefresh,
  onGoToEmailInsights,
}: IntegrationsPageProps) {
  const [selectedService, setSelectedService] = useState<string | null>(null);
  const [gmailStatus, setGmailStatus] = useState<GmailConnectionStatus | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [connecting, setConnecting] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const [fallbackAuthUrl, setFallbackAuthUrl] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [lastSyncResult, setLastSyncResult] = useState<GmailSyncResult | null>(null);

  const loadGmailStatus = useCallback(async () => {
    setLoadingStatus(true);
    try {
      const status = await workspaceApi.getGmailStatus();
      setGmailStatus(status);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Unable to check Gmail status');
    } finally {
      setLoadingStatus(false);
    }
  }, [workspaceApi]);

  useEffect(() => {
    void loadGmailStatus();
    setLastSyncResult(null);
    setFallbackAuthUrl(null);
    setConfirmDisconnect(false);
    setActionMessage(null);
    setErrorMessage(null);
  }, [loadGmailStatus, mode]);

  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      try {
        const parsed = new URL(event.origin);
        const isAllowedLocal =
          (parsed.protocol === 'http:' || parsed.protocol === 'https:') &&
          (parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1');
        const isAllowedRunApp =
          parsed.protocol === 'https:' && parsed.hostname.endsWith('.run.app');
        if (event.origin !== window.location.origin && !isAllowedLocal && !isAllowedRunApp) {
          return;
        }
      } catch {
        return;
      }
      const data = event.data as { type?: string; email?: string | null; error?: string } | undefined;
      if (!data?.type) return;

      if (data.type === 'MAYA_GMAIL_OAUTH_SUCCESS') {
        setConnecting(false);
        setFallbackAuthUrl(null);
        setErrorMessage(null);
        setActionMessage(
          `Connected read-only Gmail access for ${data.email ?? 'your Google account'}. Click "Sync Now" to ingest recent messages for review.`,
        );
        void loadGmailStatus();
        void onRefresh();
      } else if (data.type === 'MAYA_GMAIL_OAUTH_ERROR') {
        setConnecting(false);
        setErrorMessage(data.error || 'Google authorization was cancelled or failed.');
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [loadGmailStatus, onRefresh]);

  const handleConnectGmail = async () => {
    if (mode === 'DEMO') return;
    setConnecting(true);
    setErrorMessage(null);
    setActionMessage(null);
    setFallbackAuthUrl(null);

    try {
      const [{ authUrl, clientId, state }, oauth2] = await Promise.all([
        workspaceApi.connectGmail(),
        waitForGoogleIdentity().catch(() => null),
      ]);

      if (!oauth2) {
        const inIframe = window.self !== window.top;
        if (!inIframe) {
          const popup = window.open(authUrl, 'maya_gmail_oauth', 'width=560,height=700');
          if (!popup) {
            setFallbackAuthUrl(authUrl);
            setConnecting(false);
            setErrorMessage(
              'Browser blocked the authorization popup. Use the direct authorization link below to continue.',
            );
          }
          return;
        }

        setConnecting(false);
        setErrorMessage(
          'Unable to load Google Identity Services inside this browser view. Please allow scripts and popups for accounts.google.com and try again.',
        );
        return;
      }

      const codeClient = oauth2.initCodeClient({
        client_id: clientId,
        scope: GMAIL_READONLY_SCOPE,
        ux_mode: 'popup',
        select_account: true,
        include_granted_scopes: true,
        state,
        callback: async (response) => {
          if (response.error) {
            setConnecting(false);
            setErrorMessage(
              response.error_description || `Google authorization failed: ${response.error}`,
            );
            return;
          }

          if (!response.code) {
            setConnecting(false);
            setErrorMessage('Google did not return an authorization code. Please try again.');
            return;
          }

          if (response.state && response.state !== state) {
            setConnecting(false);
            setErrorMessage('OAuth state verification failed. Please retry connecting Gmail.');
            return;
          }

          try {
            const exchanged = await workspaceApi.exchangeGmailCode({
              code: response.code,
              state,
            });
            setConnecting(false);
            setFallbackAuthUrl(null);
            setErrorMessage(null);
            setActionMessage(
              `Connected read-only Gmail access for ${exchanged.email ?? 'your Google account'}. Click "Sync Now" to ingest recent messages for review.`,
            );
            await loadGmailStatus();
            await onRefresh();
          } catch (err) {
            setConnecting(false);
            setErrorMessage(
              err instanceof Error ? err.message : 'Failed to complete Gmail connection.',
            );
          }
        },
        error_callback: (err) => {
          setConnecting(false);
          if (err?.type === 'popup_closed') {
            setErrorMessage('Google sign-in popup was closed before authorization completed.');
          } else if (err?.type === 'popup_failed_to_open') {
            setErrorMessage(
              'Browser blocked the Google sign-in popup. Please allow popups for this site and try again.',
            );
          } else {
            setErrorMessage(err?.message || 'Google authorization popup encountered an error.');
          }
        },
      });

      codeClient.requestCode();
    } catch (err) {
      setConnecting(false);
      setErrorMessage(err instanceof Error ? err.message : 'Unable to initialize Gmail OAuth');
    }
  };

  const handleSyncNow = async () => {
    if (mode === 'DEMO') return;
    setSyncing(true);
    setErrorMessage(null);
    setActionMessage(null);

    try {
      const result = await workspaceApi.syncGmail();
      setLastSyncResult(result);
      await loadGmailStatus();
      await onRefresh();
      setActionMessage(
        `Synced ${result.fetchedCount} new email(s) (${result.skippedDuplicates} duplicate(s) skipped). ${result.queuedForExtraction} message(s) queued for rate-limited AI extraction in Email Insights.`,
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Gmail synchronization failed');
      await loadGmailStatus();
    } finally {
      setSyncing(false);
    }
  };

  const handleDisconnect = async () => {
    if (mode === 'DEMO') return;
    setDisconnecting(true);
    setErrorMessage(null);
    setActionMessage(null);

    try {
      await workspaceApi.disconnectGmail();
      setConfirmDisconnect(false);
      setLastSyncResult(null);
      await loadGmailStatus();
      await onRefresh();
      setActionMessage(
        'Gmail disconnected and encrypted OAuth tokens removed from this workspace.',
      );
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Failed to disconnect Gmail');
    } finally {
      setDisconnecting(false);
    }
  };

  const isDemo = mode === 'DEMO';
  const isConnected = gmailStatus?.status === 'CONNECTED';
  const isRevoked = gmailStatus?.status === 'REVOKED';
  const otherConnectors = integrations.filter((i) => i.serviceKey !== 'gmail');

  const iconFor = (key: IntegrationConnector['serviceKey']) => {
    switch (key) {
      case 'gmail':
        return Mail;
      case 'google_calendar':
        return Calendar;
      case 'google_tasks':
        return CheckSquare;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-slate-100">
            Service Integrations &amp; Read-Only Policy Boundaries
          </h2>
          <p className="text-xs text-slate-400">
            Connect your own Google account per private workspace. Milestone 1 grants strictly
            read-only Gmail ingestion; all extracted items wait for human review before entering
            your Context Graph.
          </p>
        </div>
        {!isDemo && (
          <button
            type="button"
            onClick={onGoToEmailInsights}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg border border-slate-700 bg-slate-900 text-slate-200 hover:bg-slate-800 transition-colors whitespace-nowrap shrink-0"
          >
            <span>Open Email Insights</span>
            <ArrowRight className="h-3.5 w-3.5" />
          </button>
        )}
      </div>

      {errorMessage && (
        <div className="rounded-xl border border-rose-500/40 bg-rose-500/10 p-4 text-xs text-rose-200 flex items-start justify-between gap-3">
          <span>{errorMessage}</span>
          <button
            type="button"
            onClick={() => setErrorMessage(null)}
            className="text-rose-300 hover:text-white shrink-0"
          >
            Dismiss
          </button>
        </div>
      )}

      {actionMessage && (
        <div className="rounded-xl border border-teal-500/40 bg-teal-500/10 p-4 text-xs text-teal-100 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <span>{actionMessage}</span>
          {lastSyncResult && (
            <button
              type="button"
              onClick={onGoToEmailInsights}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-teal-600 hover:bg-teal-500 text-white font-semibold shrink-0"
            >
              <span>Review Insights</span>
              <ArrowRight className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      )}

      {fallbackAuthUrl && (
        <div className="rounded-xl border border-blue-500/40 bg-blue-500/10 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs text-blue-100">
          <span>Authorize Google in a new tab, then return here after completion.</span>
          <a
            href={fallbackAuthUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white font-semibold shrink-0"
          >
            <span>Open Google Consent Screen</span>
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </div>
      )}

      {/* Primary Milestone 1 Gmail Integration Card */}
      <section className="rounded-xl border border-slate-800/90 bg-[#0D1526] p-6 space-y-5">
        <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
          <div className="flex items-start gap-3.5">
            <div className="h-11 w-11 rounded-lg border border-blue-500/30 bg-blue-500/10 flex items-center justify-center text-blue-400 shrink-0">
              <Mail className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <div className="flex flex-wrap items-center gap-2.5">
                <h3 className="text-base font-semibold text-slate-100">
                  Gmail Integration (Milestone 1)
                </h3>
                <span
                  className={`text-xs font-mono font-semibold ${
                    isConnected
                      ? 'text-teal-400'
                      : isRevoked
                        ? 'text-rose-400'
                        : 'text-amber-300'
                  }`}
                >
                  {loadingStatus ? 'CHECKING...' : gmailStatus?.status ?? 'DISCONNECTED'}
                </span>
              </div>
              <p className="text-xs text-slate-300 max-w-2xl leading-relaxed">
                Connects your personal Gmail inbox using strictly{' '}
                <span className="font-mono text-teal-300">read-only</span> permissions (
                <span className="font-mono">gmail.readonly</span>). maYa never sends, deletes,
                archives, or modifies messages, and tokens remain encrypted on the server.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            {isDemo ? (
              <span className="text-xs text-amber-300 font-medium">
                Disabled in DEMO MODE (Personal workspaces only)
              </span>
            ) : isConnected ? (
              <>
                <button
                  type="button"
                  onClick={handleSyncNow}
                  disabled={syncing || disconnecting}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${syncing ? 'animate-spin' : ''}`} />
                  <span>{syncing ? 'Syncing Inbox...' : 'Sync Now'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDisconnect(true)}
                  disabled={syncing || disconnecting}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-lg border border-rose-500/40 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 transition-colors disabled:opacity-50"
                >
                  <Unplug className="h-3.5 w-3.5" />
                  <span>Disconnect</span>
                </button>
              </>
            ) : (
              <button
                type="button"
                onClick={handleConnectGmail}
                disabled={connecting || loadingStatus || !gmailStatus?.serviceAvailable}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-50"
              >
                <Mail className="h-3.5 w-3.5" />
                <span>
                  {connecting
                    ? 'Awaiting Google Consent...'
                    : isRevoked
                      ? 'Reconnect Gmail'
                      : 'Connect Gmail'}
                </span>
              </button>
            )}
          </div>
        </div>

        {!isDemo && !loadingStatus && gmailStatus && !gmailStatus.serviceAvailable && (
          <div className="rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 flex items-start gap-3 text-xs text-amber-100">
            <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <div className="font-semibold text-amber-300">
                Administrator Configuration Required
              </div>
              <p className="text-amber-100/90 leading-relaxed">
                {gmailStatus.unavailableReason ??
                  'Gmail integration is currently unavailable because the application administrator has not completed server-side Google OAuth configuration.'}
              </p>
            </div>
          </div>
        )}

        {confirmDisconnect && (
          <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-4 flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
            <div className="text-rose-100">
              Disconnect Gmail and wipe stored encrypted OAuth tokens from this workspace?
              Previously accepted nodes in your Context Graph will remain intact.
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                type="button"
                onClick={() => setConfirmDisconnect(false)}
                className="px-3 py-1.5 text-slate-300 hover:text-white"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleDisconnect}
                disabled={disconnecting}
                className="px-3.5 py-1.5 rounded-md bg-rose-600 hover:bg-rose-500 text-white font-semibold"
              >
                {disconnecting ? 'Disconnecting...' : 'Confirm Disconnect'}
              </button>
            </div>
          </div>
        )}

        {/* Real Connection Telemetry Row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 pt-2 border-t border-slate-800/80 text-xs">
          <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3.5 space-y-1">
            <div className="text-[11px] text-slate-400">Connected Google Account</div>
            <div className="font-mono text-slate-100 truncate">
              {isConnected && gmailStatus?.googleEmail
                ? gmailStatus.googleEmail
                : 'Not connected'}
            </div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3.5 space-y-1">
            <div className="text-[11px] text-slate-400">Last Successful Sync</div>
            <div className="font-mono tabular-nums text-slate-100">
              {gmailStatus?.lastSyncAt ? formatTimestamp(gmailStatus.lastSyncAt) : 'Never synced'}
            </div>
          </div>
          <div className="rounded-lg border border-slate-800 bg-slate-900/50 p-3.5 space-y-1">
            <div className="text-[11px] text-slate-400">Permissions Scope</div>
            <div className="font-mono text-teal-300 truncate">
              gmail.readonly · Read-only
            </div>
          </div>
        </div>

        {/* Permissions & Privacy Guarantees */}
        <div className="rounded-lg border border-slate-800/80 bg-slate-900/40 p-4 space-y-2 text-xs">
          <div className="font-semibold text-slate-200 flex items-center gap-1.5">
            <ShieldCheck className="h-4 w-4 text-teal-400" />
            <span>Permissions &amp; Safety Guarantees</span>
          </div>
          <ul className="space-y-1.5 text-slate-400 list-disc list-inside leading-relaxed">
            <li>
              Minimum scope: <span className="font-mono text-slate-300">https://www.googleapis.com/auth/gmail.readonly</span>
            </li>
            <li>
              No sending, replying, deleting, archiving, or label modification is permitted.
            </li>
            <li>
              Your Google authorization is bound strictly to your personal workspace; email
              insights wait for your explicit approval before modifying your Context Graph.
            </li>
          </ul>
        </div>

        {gmailStatus?.lastError && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-3.5 py-2.5 text-xs text-amber-200">
            Last notice: {gmailStatus.lastError}
          </div>
        )}
      </section>

      {/* Secondary Planned Connectors (Calendar & Tasks remain disconnected in Milestone 1) */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 items-stretch">
        {otherConnectors.map((conn) => {
          const Icon = iconFor(conn.serviceKey);
          const showSetup = selectedService === conn.id;
          return (
            <section
              key={conn.id}
              className="rounded-xl border border-slate-800/80 bg-[#0D1526] p-5 flex flex-col justify-between space-y-4"
            >
              <div className="space-y-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex items-center gap-3">
                    <div className="h-10 w-10 rounded-lg border border-slate-700/80 bg-slate-900 flex items-center justify-center text-slate-400">
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <h3 className="text-sm font-semibold text-slate-100">{conn.name}</h3>
                      <div className="text-xs text-slate-400 font-mono">
                        {conn.status} · FUTURE MILESTONE
                      </div>
                    </div>
                  </div>
                </div>

                <p className="text-xs text-slate-400 leading-relaxed">{conn.description}</p>

                <div className="space-y-1">
                  <div className="text-[11px] font-semibold text-slate-400 flex items-center gap-1.5">
                    <Lock className="h-3 w-3 text-teal-400" />
                    <span>Permission Policy</span>
                  </div>
                  <p className="text-xs text-slate-400 leading-relaxed">{conn.executionPolicy}</p>
                </div>

                {showSetup && (
                  <div className="rounded-lg border border-slate-700 bg-slate-900/80 p-3 space-y-1.5 text-xs text-slate-300">
                    {conn.setupInstructions.map((step, idx) => (
                      <div key={idx}>
                        {idx + 1}. {step}
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className="pt-2 border-t border-slate-800/80">
                <button
                  type="button"
                  onClick={() => setSelectedService(showSetup ? null : conn.id)}
                  className="w-full py-2 px-3 rounded-lg border border-slate-700 bg-slate-900 hover:bg-slate-800 text-xs font-medium text-slate-300 transition-colors"
                >
                  {showSetup ? 'Hide Scope Notes' : 'View Planned Scope Policy'}
                </button>
              </div>
            </section>
          );
        })}
      </div>

      <section className="rounded-xl border border-slate-800/80 bg-[#0D1526] p-5 space-y-2">
        <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
          <TerminalSquare className="h-4 w-4 text-teal-400" />
          <span>Per-Workspace Token Isolation</span>
        </div>
        <p className="text-xs text-slate-400 leading-relaxed max-w-4xl">
          Every Gmail OAuth connection, refresh token, synchronized message, and extracted insight
          is strictly bound to your authenticated workspace ID. Other users and DEMO MODE have zero
          access to your Gmail connection or inbox records.
        </p>
      </section>
    </div>
  );
}
