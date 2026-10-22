import { useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { explainError, type LabReport, type RoomInfo } from '@labpulse/shared';
import { Logo } from '../components/Logo';
import { api } from '../lib/api';
import { RequireInstructor } from '../lib/auth';
import { dateTime, formatDuration, percent, plural, timeOfDay } from '../lib/format';
import { useDocumentTitle } from '../lib/hooks';
import { getItem, setItem } from '../lib/storage';
import { errorLine } from '../components/GroupCard';

export function ReportPage() {
  return (
    <RequireInstructor>
      <Report />
    </RequireInstructor>
  );
}

function csvCell(v: string | number) {
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function downloadCsv(filename: string, rows: (string | number)[][]) {
  const blob = new Blob([rows.map((r) => r.map(csvCell).join(',')).join('\n')], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

type SortKey = 'name' | 'finished' | 'stuckMs' | 'runs';

function Report() {
  const { id = '' } = useParams();
  const [data, setData] = useState<{ room: RoomInfo; report: LabReport } | null>(null);
  const [error, setError] = useState('');
  const [hideNames, setHideNames] = useState(() => getItem('lp_projector') === '1');
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 }>({ key: 'stuckMs', dir: -1 });
  useDocumentTitle(data ? `Report: ${data.room.title}` : 'Report');

  useEffect(() => {
    api<{ room: RoomInfo; report: LabReport }>('GET', `/api/rooms/${id}/report`)
      .then(setData)
      .catch((err) => setError((err as Error).message));
  }, [id]);

  const students = useMemo(() => {
    if (!data) return [];
    const order = new Map(data.report.students.map((s, i) => [s.id, i]));
    const list = [...data.report.students];
    list.sort((a, b) => {
      const k = sort.key;
      const cmp = k === 'name' ? a.name.localeCompare(b.name) : (a[k] as number) - (b[k] as number);
      return cmp * sort.dir || order.get(a.id)! - order.get(b.id)!;
    });
    return list;
  }, [data, sort]);

  if (error) {
    return (
      <div className="page-center">
        <div className="empty-card">
          <h1>{error}</h1>
          <Link className="btn" to="/teach">
            Back to your labs
          </Link>
        </div>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="page-center">
        <div className="spinner" aria-label="Loading report" />
      </div>
    );
  }

  const { room, report: r } = data;
  const live = room.status === 'live';
  const label = (sid: string, name: string) => (hideNames ? `Student ${r.students.findIndex((s) => s.id === sid) + 1}` : name);
  const lost = r.lostTheClass;

  const exportCsv = () => {
    const rows: (string | number)[][] = [
      ['Student', 'Exercises finished', 'Test runs', 'Minutes stuck', 'Hints received'],
      ...r.students.map((s) => [label(s.id, s.name), s.finished, s.runs, Math.round(s.stuckMs / 60_000), s.hintsReceived]),
      [],
      ['Exercise', 'Attempted', 'Finished', 'Did not finish (% of attempted)', 'Median minutes to pass', 'Students stuck'],
      ...r.exercises.map((e) => [
        e.title,
        e.attempted,
        e.finished,
        Math.round(e.didNotFinishRate * 100),
        e.medianTimeToPassMs === null ? '' : (e.medianTimeToPassMs / 60_000).toFixed(1),
        e.stuckStudents,
      ]),
    ];
    downloadCsv(`labpulse-${room.code}-${new Date(room.createdAt).toISOString().slice(0, 10)}.csv`, rows);
  };

  const sortBtn = (key: SortKey, text: string) => (
    <button
      className="th-sort"
      aria-sort={sort.key === key ? (sort.dir === 1 ? 'ascending' : 'descending') : undefined}
      onClick={() => setSort((s) => ({ key, dir: s.key === key ? ((-s.dir) as 1 | -1) : key === 'name' ? 1 : -1 }))}
    >
      {text}
      <span aria-hidden="true">{sort.key === key ? (sort.dir === 1 ? ' ↑' : ' ↓') : ''}</span>
    </button>
  );

  return (
    <div className="report">
      <header className="report-top no-print">
        <Logo to="/teach" />
        <nav>
          {live ? (
            <Link className="btn btn-sm" to={`/teach/rooms/${id}`}>
              Back to the live lab
            </Link>
          ) : (
            <Link className="btn btn-sm btn-quiet" to="/teach">
              All labs
            </Link>
          )}
          <label className="switch">
            <input
              type="checkbox"
              checked={hideNames}
              onChange={() => {
                setItem('lp_projector', hideNames ? '0' : '1');
                setHideNames(!hideNames);
              }}
            />
            <span className="switch-track" aria-hidden="true" />
            <span>Hide names</span>
          </label>
          <button className="btn btn-sm" onClick={exportCsv}>
            Download CSV
          </button>
          <button className="btn btn-sm btn-primary" onClick={() => window.print()}>
            Print
          </button>
        </nav>
      </header>

      <main className="report-main">
        <section className="report-hero">
          <p className="report-kicker">
            {room.labTitle}, {dateTime(room.createdAt)}
            {live ? ', still running' : `, ${formatDuration(r.durationMs)}`}
          </p>
          <h1>{room.title}</h1>
          <p className="report-lead">
            {r.studentCount === 0
              ? 'No students joined this lab.'
              : lost
                ? `${lost.title} lost ${lost.lostStudents} of the ${plural(lost.attempted, 'student')} who tried it (${percent(lost.didNotFinishRate)}).`
                : 'Every student who started an exercise finished it.'}
          </p>
        </section>

        <section className="report-stats" aria-label="Summary">
          <div>
            <span className="num">{r.studentCount}</span>
            <p>students joined</p>
          </div>
          <div>
            <span className="num">{r.finishedAll}</span>
            <p>finished every exercise</p>
          </div>
          <div>
            <span className="num">{formatDuration(r.recovery.medianMs)}</span>
            <p>median time from an error to the next passing run</p>
          </div>
          <div>
            <span className="num">{formatDuration(r.stuck.totalMs)}</span>
            <p>
              spent stuck in total, across {plural(r.stuck.studentsEverStuck, 'student')} ({r.stuckMinutes}+ minutes without a passing run)
            </p>
          </div>
        </section>

        <section className="report-section" aria-labelledby="ex-title">
          <h2 id="ex-title">Exercises</h2>
          <div className="funnel-legend">
            <span>
              <i className="status-dot" data-status="passing" /> finished
            </span>
            <span>
              <i className="status-dot" data-status="failing" /> tried, didn't finish
            </span>
            <span>
              <i className="status-dot" data-status="not_started" /> didn't get to it
            </span>
          </div>
          <ol className="funnel">
            {r.exercises.map((e, i) => {
              const total = Math.max(1, r.studentCount);
              const notFinished = e.attempted - e.finished;
              const notReached = r.studentCount - e.attempted;
              return (
                <li key={e.exerciseId} data-lost={lost?.exerciseId === e.exerciseId}>
                  <div className="funnel-label">
                    <span className="progress-step num">{i + 1}</span>
                    <span className="funnel-title">{e.title}</span>
                    <span className="funnel-numbers num">
                      {e.finished} of {r.studentCount} finished
                    </span>
                  </div>
                  <div className="bar bar-lg" role="img" aria-label={`${e.finished} finished, ${notFinished} tried but did not finish, ${notReached} did not get to it`}>
                    {e.finished > 0 && (
                      <span className="bar-seg" data-status="passing" style={{ flexGrow: e.finished / total }} title={`${e.finished} finished`}>
                        {e.finished}
                      </span>
                    )}
                    {notFinished > 0 && (
                      <span className="bar-seg" data-status="failing" style={{ flexGrow: notFinished / total }} title={`${notFinished} tried, didn't finish`}>
                        {notFinished}
                      </span>
                    )}
                    {notReached > 0 && (
                      <span className="bar-seg" data-status="not_started" style={{ flexGrow: notReached / total }} title={`${notReached} didn't get to it`}>
                        {notReached}
                      </span>
                    )}
                  </div>
                  <p className="funnel-meta">
                    Median time to pass {formatDuration(e.medianTimeToPassMs)}. {plural(e.stuckStudents, 'student')} got stuck here
                    {e.stuckMs > 0 ? `, ${formatDuration(e.stuckMs)} in total` : ''}. {plural(e.runs, 'test run')}.
                  </p>
                </li>
              );
            })}
          </ol>
        </section>

        <section className="report-section" aria-labelledby="errors-title">
          <h2 id="errors-title">Top errors</h2>
          {r.topErrors.length === 0 ? (
            <p className="side-empty">No errors were recorded.</p>
          ) : (
            <ol className="top-errors">
              {r.topErrors.map((t) => (
                <li key={t.fingerprint}>
                  <div className="top-error-head">
                    <h3>{explainError(t.errorType, t.result).label}</h3>
                    <span className="num top-error-count">{plural(t.students, 'student')}</span>
                  </div>
                  <p className="top-error-ex">
                    {t.exerciseTitle}. {t.recovered} of {t.students} went on to pass it.
                  </p>
                  <pre className="group-error">{errorLine(t)}</pre>
                </li>
              ))}
            </ol>
          )}
        </section>

        {r.hints.length > 0 && (
          <section className="report-section" aria-labelledby="hints-title">
            <h2 id="hints-title">Hints you sent</h2>
            <ul className="hint-report">
              {r.hints.map((h) => (
                <li key={h.hintId}>
                  <p className="hint-report-text">{h.text}</p>
                  <p className="hint-report-meta num">
                    {timeOfDay(h.sentAt)}, {h.exerciseTitle}. Sent to {plural(h.recipients, 'student')};{' '}
                    {h.passedWithin5m} passed within 5 minutes, {h.passedByEnd} by the end.
                  </p>
                </li>
              ))}
            </ul>
          </section>
        )}

        <section className="report-section" aria-labelledby="students-title">
          <h2 id="students-title">Students</h2>
          {students.length === 0 ? (
            <p className="side-empty">No students joined.</p>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>{sortBtn('name', 'Student')}</th>
                    <th className="num-col">{sortBtn('finished', 'Finished')}</th>
                    <th className="num-col">{sortBtn('runs', 'Test runs')}</th>
                    <th className="num-col">{sortBtn('stuckMs', 'Time stuck')}</th>
                    <th className="num-col">Hints</th>
                  </tr>
                </thead>
                <tbody>
                  {students.map((s) => (
                    <tr key={s.id}>
                      <td>{label(s.id, s.name)}</td>
                      <td className="num-col num">
                        {s.finished}/{r.exercises.length}
                      </td>
                      <td className="num-col num">{s.runs}</td>
                      <td className="num-col num">{s.stuckMs ? formatDuration(s.stuckMs) : '–'}</td>
                      <td className="num-col num">{s.hintsReceived || '–'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <p className="report-foot">
          “Stuck” means {r.stuckMinutes} or more minutes on an exercise without a passing run. Times use the LabPulse server clock.
        </p>
      </main>
    </div>
  );
}
