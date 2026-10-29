import { DiagnosticRefresh, useDiagnostic } from './DiagnosticRefresh.jsx';
import './HarnessPage.css';

const date = value => value ? new Date(value).toLocaleString() : 'Not recorded';

export default function HarnessPage() {
  const {data, error, loading, checked, failedAt, refresh} = useDiagnostic('/api/harnesses');
  return <section className="harness-page">
    <header><h1>Harnesses</h1><p>Configuration, historical qualification and observed policy hooks are separate signals. Hooks are rule-level protection, not an isolation boundary.</p></header>
    <DiagnosticRefresh loading={loading} checked={checked} failedAt={failedAt} refresh={refresh} />
    {error && <p role="alert">{error}</p>}
    {!data && !error && <p>Loading harness status…</p>}
    <div className="harness-grid">{data?.harnesses.map(harness => <article className="harness-card" key={harness.id}>
      <h2>{harness.name}</h2>
      <dl>
        <div><dt>Configured</dt><dd><strong>{harness.installation.configured ? 'Yes' : 'Not confirmed'}</strong><p>{harness.installation.detail}</p>{harness.installation.source && <small>{harness.installation.source}</small>}</dd></div>
        <div><dt>Last qualified evidence</dt><dd>{harness.qualification ? <><strong>{date(harness.qualification.at)}</strong><p>{harness.qualification.timestampBasis}. {harness.qualification.coverage}</p><ul>{harness.qualification.sources.map(source => <li key={source.path}><code>{source.path}</code> ({date(source.at)})</li>)}</ul>{harness.qualification.missing.length > 0 && <p>Missing evidence: {harness.qualification.missing.join(', ')}</p>}</> : 'No qualifying artifacts available for this vault.'}</dd></div>
        <div><dt>Last observed policy hook</dt><dd>{harness.observation.last ? <><strong>{date(harness.observation.last.at)}</strong><p>{harness.observation.last.event} — {harness.observation.last.outcome === 'success' ? 'policy loaded' : 'legacy event; outcome unknown'}</p></> : harness.observation.reason || 'No successful hook recorded.'}<p>Observation is historical, not proof a process is currently connected. A direct hook invocation is indistinguishable from a native invocation. Journal read access does not guarantee every hook could record an event.</p></dd></div>
      </dl>
    </article>)}</div>
  </section>;
}
