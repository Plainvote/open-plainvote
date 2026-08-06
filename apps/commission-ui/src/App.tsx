import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import { loadSettings, missingSettings, saveSettings } from './lib/settings';
import type { CommissionSettings } from './lib/settings';
import { SetupTab } from './tabs/SetupTab';
import { ElectionsTab } from './tabs/ElectionsTab';
import { CodesTab } from './tabs/CodesTab';

export type TabId = 'setup' | 'elections' | 'codes';

interface AppContextValue {
  settings: CommissionSettings;
  updateSettings: (patch: Partial<CommissionSettings>) => void;
  goTo: (tab: TabId) => void;
}

const AppContext = createContext<AppContextValue | null>(null);

/** Settings + navigation context shared by the tabs. */
export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <App />');
  return ctx;
}

/** Standard "finish Setup first" notice used by the non-Setup tabs. */
export function SettingsRequiredNotice({ missing }: { missing: string[] }) {
  const { goTo } = useApp();
  return (
    <div className="notice warn">
      <strong>Setup needed.</strong> Missing: {missing.join(', ')}.{' '}
      <a
        href="#setup"
        onClick={(event) => {
          event.preventDefault();
          goTo('setup');
        }}
      >
        Open the Setup tab
      </a>{' '}
      to fill these in.
    </div>
  );
}

const TABS: ReadonlyArray<{ id: TabId; label: string }> = [
  { id: 'setup', label: 'Setup' },
  { id: 'elections', label: 'Elections' },
  { id: 'codes', label: 'Voter Codes' },
];

export function App() {
  const [settings, setSettings] = useState<CommissionSettings>(() => loadSettings());
  const [tab, setTab] = useState<TabId>(() =>
    missingSettings(loadSettings()).length > 0 ? 'setup' : 'elections',
  );

  const updateSettings = useCallback((patch: Partial<CommissionSettings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      saveSettings(next);
      return next;
    });
  }, []);

  const goTo = useCallback((next: TabId) => setTab(next), []);

  const ctxValue = useMemo<AppContextValue>(
    () => ({ settings, updateSettings, goTo }),
    [settings, updateSettings, goTo],
  );

  return (
    <AppContext.Provider value={ctxValue}>
      <header className="app-header">
        <div className="container">
          <h1>
            <svg width="19" height="19" viewBox="0 0 32 32" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" aria-hidden="true">
              <line x1="5" y1="5" x2="5" y2="27" />
              <line x1="12" y1="5" x2="12" y2="27" />
              <line x1="19" y1="5" x2="19" y2="27" />
              <line x1="26" y1="5" x2="26" y2="27" />
              <line x1="2" y1="25" x2="30" y2="7" />
            </svg>
            Plainvote Commission
          </h1>
          <span className="tagline">create and manage verifiable elections</span>
        </div>
      </header>
      <main className="container">
        <nav className="tab-nav" aria-label="Commission sections">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              className={tab === t.id ? 'active' : undefined}
              aria-current={tab === t.id ? 'page' : undefined}
              onClick={() => setTab(t.id)}
            >
              {t.label}
            </button>
          ))}
        </nav>
        {tab === 'setup' && <SetupTab />}
        {tab === 'elections' && <ElectionsTab />}
        {tab === 'codes' && <CodesTab />}
      </main>
      <footer className="app-footer">
        <div className="container">
          Plainvote demo. Commission keys are held in this browser's localStorage; a production deployment
          would use an HSM.
        </div>
      </footer>
    </AppContext.Provider>
  );
}
