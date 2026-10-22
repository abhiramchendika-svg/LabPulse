import { useEffect, useState } from 'react';

/** Current time, ticking every `ms`, corrected by a server clock offset. */
export function useNow(ms = 1000, offset = 0): number {
  const [now, setNow] = useState(() => Date.now() + offset);
  useEffect(() => {
    setNow(Date.now() + offset);
    const id = window.setInterval(() => setNow(Date.now() + offset), ms);
    return () => window.clearInterval(id);
  }, [ms, offset]);
  return now;
}

export function useDocumentTitle(title: string) {
  useEffect(() => {
    document.title = title ? `${title} – LabPulse` : 'LabPulse';
  }, [title]);
}
