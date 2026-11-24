import { useState } from 'react';
import { ArrowRight, GitBranch, Lock, Play, ShieldCheck, Zap } from 'lucide-react';
import { authApi } from '../api/client.ts';
import type { AuthSessionResponse } from '../types/maya.ts';

interface AuthPageProps {
  onAuthenticated: (session: AuthSessionResponse) => void;
  onEnterDemoMode: () => void;
}

export function AuthPage({ onAuthenticated, onEnterDemoMode }: AuthPageProps) {
  const [mode, setMode] = useState<'LOGIN' | 'REGISTER'>('LOGIN');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const session =
        mode === 'REGISTER'
          ? await authApi.register({ email, password, displayName })
          : await authApi.login({ email, password });
      onAuthenticated(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#070D19] text-slate-100 flex items-center justify-center p-4 sm:p-6">
      <div className="w-full max-w-5xl grid grid-cols-1 lg:grid-cols-12 gap-8 items-stretch">
        {/* Left Brand & Value Column */}
        <section className="lg:col-span-6 rounded-2xl border border-slate-800/80 bg-[#0D1526] p-7 sm:p-8 flex flex-col justify-between space-y-8">
          <div className="space-y-4">
            <div className="text-2xl font-bold tracking-tight text-white font-display">
              ma<span className="text-blue-400">Y</span>a
            </div>
            <p className="text-xs font-medium text-teal-400">Your world. Connected. Understood.</p>
            <h1 className="text-2xl sm:text-3xl font-semibold text-slate-100 leading-tight">
              Private Personal Context &amp; Intelligence Platform
            </h1>
            <p className="text-sm text-slate-400 leading-relaxed">
              Every account receives an isolated personal workspace. Build your own Living Context
              Graph across projects, tasks, people, meetings, and documents—and trace what any
              change affects before taking action.
            </p>
          </div>

          <div className="space-y-3 border-t border-slate-800/80 pt-6">
            <div className="flex items-start gap-3 text-xs text-slate-300">
              <Lock className="h-4 w-4 text-teal-400 shrink-0 mt-0.5" />
              <span>
                Strict per-user workspace isolation enforced on every query, graph edge, Gemini
                prompt, approval queue, and audit log.
              </span>
            </div>
            <div className="flex items-start gap-3 text-xs text-slate-300">
              <GitBranch className="h-4 w-4 text-blue-400 shrink-0 mt-0.5" />
              <span>
                Starts empty for new users—no fabricated demo projects or mixed sample tasks in your
                personal space.
              </span>
            </div>
            <div className="flex items-start gap-3 text-xs text-slate-300">
              <Zap className="h-4 w-4 text-violet-400 shrink-0 mt-0.5" />
              <span>
                Need to present the deadline-shift scenario? Launch the isolated DEMO MODE showcase
                anytime without touching personal data.
              </span>
            </div>
          </div>

          <div className="pt-2">
            <button
              type="button"
              onClick={onEnterDemoMode}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-xs font-semibold rounded-lg border border-slate-700 bg-slate-900/80 text-slate-200 hover:bg-slate-800 hover:text-white transition-colors"
            >
              <Play className="h-3.5 w-3.5 text-teal-400" />
              <span>Explore Isolated DEMO MODE Showcase</span>
            </button>
          </div>
        </section>

        {/* Right Auth Form Column */}
        <section className="lg:col-span-6 rounded-2xl border border-slate-800/80 bg-[#0D1526] p-7 sm:p-8 flex flex-col justify-center space-y-6">
          <div className="flex items-center gap-1 p-1 rounded-lg bg-slate-900/90 border border-slate-800">
            <button
              type="button"
              onClick={() => {
                setMode('LOGIN');
                setError(null);
              }}
              className={`flex-1 py-2 text-xs font-semibold rounded-md transition-colors ${
                mode === 'LOGIN' ? 'bg-blue-600 text-white' : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('REGISTER');
                setError(null);
              }}
              className={`flex-1 py-2 text-xs font-semibold rounded-md transition-colors ${
                mode === 'REGISTER'
                  ? 'bg-blue-600 text-white'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Create Account
            </button>
          </div>

          <div className="space-y-1">
            <h2 className="text-lg font-semibold text-slate-100">
              {mode === 'REGISTER'
                ? 'Create your private maYa workspace'
                : 'Sign in to your personal workspace'}
            </h2>
            <p className="text-xs text-slate-400">
              {mode === 'REGISTER'
                ? 'Your account starts with a clean, private SQLite workspace.'
                : 'Your projects, context graph, approvals, and audit trail are restored automatically.'}
            </p>
          </div>

          {error && (
            <div className="rounded-lg border border-rose-500/40 bg-rose-500/10 px-3.5 py-2.5 text-xs text-rose-300">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            {mode === 'REGISTER' && (
              <div>
                <label className="block text-xs font-medium text-slate-300 mb-1.5">
                  Full Name
                </label>
                <input
                  type="text"
                  required
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="e.g., Ananya Rao"
                  className="w-full rounded-lg border border-slate-700/80 bg-slate-900 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
                />
              </div>
            )}

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Email Address
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@domain.com"
                className="w-full rounded-lg border border-slate-700/80 bg-slate-900 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
              />
            </div>

            <div>
              <label className="block text-xs font-medium text-slate-300 mb-1.5">
                Password
              </label>
              <input
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimum 8 characters"
                className="w-full rounded-lg border border-slate-700/80 bg-slate-900 px-3.5 py-2.5 text-sm text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-blue-500"
              />
            </div>

            <button
              type="submit"
              disabled={submitting}
              className="w-full inline-flex items-center justify-center gap-2 px-4 py-2.5 text-sm font-semibold rounded-lg bg-blue-600 hover:bg-blue-500 text-white transition-colors disabled:opacity-60"
            >
              <span>
                {submitting
                  ? mode === 'REGISTER'
                    ? 'Creating Private Workspace...'
                    : 'Signing In...'
                  : mode === 'REGISTER'
                    ? 'Create Private Workspace'
                    : 'Sign In'}
              </span>
              <ArrowRight className="h-4 w-4" />
            </button>
          </form>

          <div className="pt-2 border-t border-slate-800/80 flex items-center gap-2 text-[11px] text-slate-500">
            <ShieldCheck className="h-3.5 w-3.5 text-teal-400 shrink-0" />
            <span>
              Passwords are salted and hashed with scrypt on the server. Session tokens stay in
              memory.
            </span>
          </div>
        </section>
      </div>
    </div>
  );
}
