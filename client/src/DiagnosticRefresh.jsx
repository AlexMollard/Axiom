import React, {useCallback, useEffect, useRef, useState} from 'react';

export function useDiagnostic(url) {
  const [data, setData] = useState(null), [error, setError] = useState('');
  const [loading, setLoading] = useState(false), [checked, setChecked] = useState(null), [failedAt, setFailedAt] = useState(null);
  const active = useRef(false), sequence = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++sequence.current;
    if (active.current) { setLoading(true); setError(''); }
    try {
      const response = await fetch(url);
      const body = await response.json();
      if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
      if (active.current && current === sequence.current) { setData(body); setChecked(new Date()); setFailedAt(null); }
      return body;
    } catch (err) {
      if (active.current && current === sequence.current) { setError(err.message); setFailedAt(new Date()); }
      return null;
    } finally {
      if (active.current && current === sequence.current) setLoading(false);
    }
  }, [url]);
  useEffect(() => { active.current = true; refresh(); return () => { active.current = false; sequence.current++; }; }, [refresh]);
  return {data, error, loading, checked, failedAt, refresh};
}

export function DiagnosticRefresh({loading, checked, failedAt, refresh}) {
  return <div><button type="button" className="button" disabled={loading} onClick={refresh}>{loading ? 'Checking…' : 'Refresh status'}</button> <span className="muted" role="status">{checked ? `Data last checked successfully: ${checked.toLocaleString()}` : 'No successful check yet'}{failedAt ? ` · Last check failed: ${failedAt.toLocaleString()}` : ''}</span></div>;
}
