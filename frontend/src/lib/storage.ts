// Web storage that never throws: private windows, blocked site data and quota errors must not take
// the UI down for a mere preference (theme, persona, collapsed sidebar).

type Area = 'local' | 'session';

function area(kind: Area): Storage {
  return kind === 'session' ? sessionStorage : localStorage;
}

export function readStorage(key: string, kind: Area = 'local'): string | null {
  try {
    return area(kind).getItem(key);
  } catch {
    return null;
  }
}

export function writeStorage(key: string, value: string | null, kind: Area = 'local'): void {
  try {
    if (value === null) area(kind).removeItem(key);
    else area(kind).setItem(key, value);
  } catch {
    /* preference not persisted — acceptable */
  }
}

/** Storage keys, in one place so two components never fight over the same name. */
export const STORAGE_KEYS = {
  theme: 'factory.theme',            // also read by the pre-paint script in index.html
  persona: 'factory.persona',
  sidebarCollapsed: 'factory.sidebar.collapsed',
  onboardingDismissed: 'factory.onboarding.dismissed',   // sessionStorage: asks again next visit
} as const;
