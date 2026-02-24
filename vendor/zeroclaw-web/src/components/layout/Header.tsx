import { useLocation } from 'react-router-dom';
import { LogOut, Menu } from 'lucide-react';
import { t } from '@/lib/i18n';
import { useLocaleContext } from '@/App';
import { useAuth } from '@/hooks/useAuth';

const routeTitles: Record<string, string> = {
  '/': 'nav.dashboard',
  '/agent': 'nav.agent',
  '/tools': 'nav.tools',
  '/cron': 'nav.cron',
  '/integrations': 'nav.integrations',
  '/memory': 'nav.memory',
  '/config': 'nav.config',
  '/cost': 'nav.cost',
  '/logs': 'nav.logs',
  '/doctor': 'nav.doctor',
};

type HeaderProps = {
  onOpenMenu?: () => void;
};

export default function Header({ onOpenMenu }: HeaderProps) {
  const location = useLocation();
  const { logout } = useAuth();
  const { locale, setAppLocale } = useLocaleContext();

  const titleKey = routeTitles[location.pathname] ?? 'nav.dashboard';
  const pageTitle = t(titleKey);

  const toggleLanguage = () => {
    setAppLocale(locale === 'en' ? 'tr' : 'en');
  };

  return (
    <header
      className="sticky top-0 z-30 flex min-h-14 items-center justify-between border-b border-gray-700 bg-gray-800 px-3 sm:px-4 md:px-6"
      style={{ paddingTop: 'max(env(safe-area-inset-top), 0px)' }}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          aria-label="Open navigation menu"
          onClick={onOpenMenu}
          className="inline-flex h-11 w-11 items-center justify-center rounded-lg border border-gray-700 text-gray-300 hover:bg-gray-700 hover:text-white lg:hidden"
        >
          <Menu className="h-5 w-5" />
        </button>
        <h1 className="text-base font-semibold text-white sm:text-lg">{pageTitle}</h1>
      </div>

      <div className="flex items-center gap-2 sm:gap-3 md:gap-4">
        <a
          href="/apps/codex"
          className="hidden min-h-10 items-center rounded-md border border-gray-600 px-3 text-sm font-medium text-gray-300 transition-colors hover:bg-gray-700 hover:text-white sm:inline-flex"
        >
          Codex
        </a>
        <button
          type="button"
          onClick={toggleLanguage}
          className="min-h-10 rounded-md border border-gray-600 px-3 py-1 text-sm font-medium text-gray-300 transition-colors hover:bg-gray-700 hover:text-white"
        >
          {locale === 'en' ? 'EN' : 'TR'}
        </button>

        <button
          type="button"
          onClick={logout}
          className="flex min-h-10 items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-gray-300 transition-colors hover:bg-gray-700 hover:text-white"
        >
          <LogOut className="h-4 w-4" />
          <span className="hidden sm:inline">{t('auth.logout')}</span>
        </button>
      </div>
    </header>
  );
}
