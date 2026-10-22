import { useEffect, useRef, useState } from 'react';
import { explainError, type ErrorGroup, type HintState } from '@labpulse/shared';
import { minutes } from '../lib/format';

export interface GroupCardProps {
  group: ErrorGroup;
  exerciseTitle: string;
  now: number;
  nameOf: (id: string) => string;
  hideNames: boolean;
  suggestion: string;
  live: boolean;
  /** Latest status of a student on this group's exercise. */
  statusOf: (studentId: string) => 'not_started' | 'failing' | 'passing';
  onSendHint: (text: string) => Promise<boolean>;
}

/** Normalized messages use placeholders like <name>; show them in a friendlier form. */
export function prettyMessage(msg: string | null): string {
  return (msg ?? '')
    .replace(/<name>|<value>/g, '…')
    .replace(/<n>/g, '#')
    .replace(/<path>/g, 'file')
    .replace(/<addr>/g, '0x…');
}

export function errorLine(g: Pick<ErrorGroup, 'result' | 'errorType' | 'errorMessage' | 'failingTest'>): string {
  if (g.result === 'fail') return `${g.failingTest ?? 'A test'} failed: ${prettyMessage(g.errorMessage)}`.trim();
  return `${g.errorType ?? 'Error'}: ${prettyMessage(g.errorMessage)}`.trim();
}

/** The number animates when it changes, so a shrinking group is noticed. */
function Count({ value }: { value: number }) {
  const [bump, setBump] = useState(0);
  const prev = useRef(value);
  useEffect(() => {
    if (prev.current !== value) setBump((b) => b + 1);
    prev.current = value;
  }, [value]);
  return (
    <span key={bump} className="group-count num" data-bump={bump > 0}>
      {value}
    </span>
  );
}

function HintEffect({
  hint,
  now,
  members,
  nameOf,
  hideNames,
  statusOf,
}: {
  hint: HintState;
  now: number;
  members: Set<string>;
  nameOf: (id: string) => string;
  hideNames: boolean;
  statusOf: (id: string) => 'not_started' | 'failing' | 'passing';
}) {
  const seatState = (r: string) => (members.has(r) ? 'stuck' : statusOf(r) === 'passing' ? 'passed' : 'other');
  const passed = hint.recipients.filter((r) => seatState(r) === 'passed').length;
  const other = hint.recipients.filter((r) => seatState(r) === 'other').length;
  const words: Record<string, string> = { stuck: 'still on this error', passed: 'now passing', other: 'now on a different error' };
  return (
    <div className="hint-effect">
      <div className="hint-effect-head">
        <span>Hint sent {minutes(now - hint.sentAt)} ago</span>
        <span className="hint-effect-numbers num" aria-label={`${hint.recipients.length} students got the hint, ${hint.stillInGroup} still on this error`}>
          {hint.recipients.length} <span aria-hidden="true">→</span> {hint.stillInGroup}
        </span>
      </div>
      <div className="seat-row" role="list" aria-label="Students who got the hint">
        {hint.recipients.map((r) => {
          const st = seatState(r);
          return <span key={r} role="listitem" className="seat" data-state={st} title={`${hideNames ? 'A student' : nameOf(r)}: ${words[st]}`} />;
        })}
      </div>
      <p className="hint-effect-text">{hint.text}</p>
      {(passed > 0 || other > 0) && (
        <p className="hint-effect-note">
          {[passed > 0 && `${passed} now passing`, other > 0 && `${other} on a different error`].filter(Boolean).join(', ')}.
        </p>
      )}
    </div>
  );
}

export function GroupCard({ group, exerciseTitle, now, nameOf, hideNames, suggestion, live, statusOf, onSendHint }: GroupCardProps) {
  const [composing, setComposing] = useState(false);
  const [text, setText] = useState(suggestion);
  const [sending, setSending] = useState(false);
  const label = explainError(group.errorType, group.result).label;
  const members = new Set(group.studentIds);
  const size = group.studentIds.length;
  const lastHint = group.hints[group.hints.length - 1];
  const oldest = group.studentIds[0] ? group.memberSince[group.studentIds[0]] : undefined;
  const resolved = size === 0;

  useEffect(() => {
    if (!composing) setText(suggestion);
  }, [suggestion, composing]);

  const send = async () => {
    setSending(true);
    const ok = await onSendHint(text);
    setSending(false);
    if (ok) setComposing(false);
  };

  return (
    <article className="group-card" data-resolved={resolved} aria-label={`${size} students: ${label} in ${exerciseTitle}`}>
      <header className="group-head">
        <div className="group-title">
          <p className="group-exercise">{exerciseTitle}</p>
          <h3>{label}</h3>
        </div>
        <div className="group-size">
          <Count value={size} />
          <span className="group-size-label">{resolved ? 'all moved on' : size === 1 ? 'student' : 'students'}</span>
        </div>
      </header>

      <pre className="group-error">{errorLine(group)}</pre>

      {!resolved && (
        <div className="group-people">
          {hideNames ? (
            <div className="seat-row" aria-label={`${size} students`}>
              {group.studentIds.map((id) => (
                <span key={id} className="seat" data-state="stuck" />
              ))}
            </div>
          ) : (
            <ul className="name-chips">
              {group.studentIds.slice(0, 18).map((id) => (
                <li key={id}>{nameOf(id)}</li>
              ))}
              {size > 18 && <li className="name-chips-more">+{size - 18} more</li>}
            </ul>
          )}
          <p className="group-meta">
            {oldest !== undefined && <>Longest wait {minutes(now - oldest)}. </>}
            {group.everAffected > size && <>{group.everAffected} hit this so far.</>}
          </p>
        </div>
      )}

      {lastHint && <HintEffect hint={lastHint} now={now} members={members} nameOf={nameOf} hideNames={hideNames} statusOf={statusOf} />}

      {live && !resolved && (
        <div className="group-actions">
          {composing ? (
            <div className="hint-composer">
              <label className="field">
                <span>Hint for these {size === 1 ? 'one student' : `${size} students`}</span>
                <textarea className="textarea" value={text} onChange={(e) => setText(e.target.value)} maxLength={600} data-autofocus autoFocus />
              </label>
              <div className="hint-composer-actions">
                <button className="btn btn-quiet" onClick={() => setComposing(false)} disabled={sending}>
                  Cancel
                </button>
                <button className="btn btn-primary" onClick={() => void send()} disabled={sending || !text.trim()}>
                  {sending ? 'Sending…' : `Send to ${size === 1 ? '1 student' : `${size} students`}`}
                </button>
              </div>
            </div>
          ) : (
            <button className="btn btn-primary" onClick={() => setComposing(true)}>
              {lastHint ? 'Send another hint' : `Send a hint to ${size === 1 ? '1 student' : `all ${size}`}`}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
