import { CheckCircle2, HelpCircle, AlertTriangle, ShieldCheck, ShieldAlert } from 'lucide-react';
import type { FactStatus } from '../types/maya.ts';

export function FactMarker({ status }: { status: FactStatus }) {
  if (status === 'CONFIRMED') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-teal-400">
        <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
        <span>Confirmed fact</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-violet-300">
      <HelpCircle className="h-3.5 w-3.5 shrink-0" />
      <span>Inferred relationship</span>
    </span>
  );
}

export function SeverityMarker({ severity }: { severity: 'HIGH' | 'MEDIUM' | 'LOW' | 'NONE' }) {
  if (severity === 'HIGH') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-400">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span>High impact</span>
      </span>
    );
  }
  if (severity === 'MEDIUM') {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400">
        <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
        <span>Moderate impact</span>
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400">
      <CheckCircle2 className="h-3.5 w-3.5 shrink-0" />
      <span>No conflict</span>
    </span>
  );
}

export function PermissionMarker({
  valid,
  executionMode,
}: {
  valid: boolean;
  executionMode: 'SIMULATED_DEMO' | 'LOCAL_WORKSPACE' | 'LIVE_OAUTH';
}) {
  if (!valid) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-rose-400">
        <ShieldAlert className="h-3.5 w-3.5 shrink-0" />
        <span>Permission denied</span>
      </span>
    );
  }
  const label =
    executionMode === 'SIMULATED_DEMO'
      ? 'Permitted (Simulated Demo)'
      : executionMode === 'LOCAL_WORKSPACE'
        ? 'Permitted (Local Workspace)'
        : 'Permitted (Live OAuth)';
  return (
    <span className="inline-flex items-center gap-1.5 text-xs font-medium text-teal-400">
      <ShieldCheck className="h-3.5 w-3.5 shrink-0" />
      <span>{label}</span>
    </span>
  );
}
