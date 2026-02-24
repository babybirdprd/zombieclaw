import { useEffect, useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from '@/components/layout/Sidebar';
import Header from '@/components/layout/Header';

export default function Layout() {
  const location = useLocation();
  const [isMobileNavOpen, setIsMobileNavOpen] = useState(false);

  useEffect(() => {
    setIsMobileNavOpen(false);
  }, [location.pathname]);

  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="hidden lg:block">
        <Sidebar />
      </div>

      {isMobileNavOpen && (
        <div className="fixed inset-0 z-40 lg:hidden" role="dialog" aria-modal="true">
          <button
            type="button"
            aria-label="Close navigation menu"
            className="absolute inset-0 bg-black/60 backdrop-blur-[1px]"
            onClick={() => setIsMobileNavOpen(false)}
          />
          <div className="relative h-full max-w-[82vw]">
            <Sidebar mobile onClose={() => setIsMobileNavOpen(false)} />
          </div>
        </div>
      )}

      <div className="flex min-h-screen flex-col lg:ml-60">
        <Header onOpenMenu={() => setIsMobileNavOpen(true)} />

        <main className="flex-1 overflow-y-auto">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
