import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  MessageSquare,
  Wrench,
  Clock,
  Puzzle,
  Brain,
  Settings,
  DollarSign,
  Activity,
  Stethoscope,
  X,
} from 'lucide-react';
import { t } from '@/lib/i18n';

const navItems = [
  { to: '/', icon: LayoutDashboard, labelKey: 'nav.dashboard' },
  { to: '/agent', icon: MessageSquare, labelKey: 'nav.agent' },
  { to: '/tools', icon: Wrench, labelKey: 'nav.tools' },
  { to: '/cron', icon: Clock, labelKey: 'nav.cron' },
  { to: '/integrations', icon: Puzzle, labelKey: 'nav.integrations' },
  { to: '/memory', icon: Brain, labelKey: 'nav.memory' },
  { to: '/config', icon: Settings, labelKey: 'nav.config' },
  { to: '/cost', icon: DollarSign, labelKey: 'nav.cost' },
  { to: '/logs', icon: Activity, labelKey: 'nav.logs' },
  { to: '/doctor', icon: Stethoscope, labelKey: 'nav.doctor' },
];

type SidebarProps = {
  mobile?: boolean;
  onClose?: () => void;
};

export default function Sidebar({ mobile = false, onClose }: SidebarProps) {
  const containerClass = mobile
    ? 'fixed inset-y-0 left-0 z-50 h-screen w-72 bg-gray-900 flex flex-col border-r border-gray-800 shadow-2xl'
    : 'fixed top-0 left-0 h-screen w-60 bg-gray-900 flex flex-col border-r border-gray-800';

  return (
    <aside className={containerClass}>
      <div className="flex items-center justify-between gap-2 px-4 py-4 border-b border-gray-800">
        <div className="h-8 w-8 rounded-lg bg-blue-600 flex items-center justify-center text-white font-bold text-sm">
          ZC
        </div>
        <span className="flex-1 text-lg font-semibold text-white tracking-wide">
          ZombieClaw
        </span>
        {mobile && onClose && (
          <button
            type="button"
            aria-label="Close menu"
            onClick={onClose}
            className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-gray-700 text-gray-300 hover:bg-gray-800 hover:text-white"
          >
            <X className="h-5 w-5" />
          </button>
        )}
      </div>

      <nav className="flex-1 overflow-y-auto py-4 px-3 space-y-1">
        {navItems.map(({ to, icon: Icon, labelKey }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            onClick={onClose}
            className={({ isActive }) =>
              [
                'flex min-h-11 items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors',
                isActive
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-300 hover:bg-gray-800 hover:text-white',
              ].join(' ')
            }
          >
            <Icon className="h-5 w-5 flex-shrink-0" />
            <span>{t(labelKey)}</span>
          </NavLink>
        ))}
      </nav>

      <section className="border-t border-gray-800 px-3 py-3">
        <p className="px-3 pb-2 text-[11px] uppercase tracking-[0.14em] text-gray-500">App Drawer</p>
        <div className="space-y-2">
          <a
            href="/apps/zeroclaw"
            className="flex min-h-11 items-center rounded-lg bg-blue-600 px-3 text-sm font-medium text-white"
          >
            ZombieClaw UI
          </a>
          <a
            href="/apps/codex"
            className="flex min-h-11 items-center rounded-lg border border-gray-700 px-3 text-sm font-medium text-gray-300 hover:bg-gray-800 hover:text-white"
          >
            Codex UI
          </a>
        </div>
      </section>
    </aside>
  );
}
