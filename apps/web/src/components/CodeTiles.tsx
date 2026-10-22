import { useRef, type ClipboardEvent, type KeyboardEvent } from 'react';
import { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH } from '@labpulse/shared';

/** Large, read-only room code: one tile per character, readable from the back of a lab. */
export function CodeDisplay({ code, size = 'lg' }: { code: string; size?: 'md' | 'lg' | 'xl' }) {
  return (
    <div className={`code-tiles code-tiles-${size}`} aria-label={`Room code ${code.split('').join(' ')}`}>
      {code.split('').map((ch, i) => (
        <span key={i} className="code-tile" aria-hidden="true">
          {ch}
        </span>
      ))}
    </div>
  );
}

const VALID = new RegExp(`[^${ROOM_CODE_ALPHABET}]`, 'g');

/** Room codes never contain 0, 1, I or O, so anything outside the alphabet is dropped. */
export function clean(raw: string) {
  return raw.toUpperCase().replace(VALID, '');
}

/** Six-box code entry with paste support. */
export function CodeInput({ value, onChange, autoFocus }: { value: string; onChange: (v: string) => void; autoFocus?: boolean }) {
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const chars = Array.from({ length: ROOM_CODE_LENGTH }, (_, i) => value[i] ?? '');

  const setAt = (i: number, raw: string) => {
    const incoming = clean(raw);
    if (!incoming) return;
    const next = (value.slice(0, i) + incoming).slice(0, ROOM_CODE_LENGTH);
    onChange(next);
    refs.current[Math.min(next.length, ROOM_CODE_LENGTH - 1)]?.focus();
  };

  const onKey = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace') {
      e.preventDefault();
      const cut = chars[i] ? i : Math.max(0, i - 1);
      onChange(value.slice(0, cut));
      refs.current[cut]?.focus();
    } else if (e.key === 'ArrowLeft') {
      refs.current[Math.max(0, i - 1)]?.focus();
    } else if (e.key === 'ArrowRight') {
      refs.current[Math.min(ROOM_CODE_LENGTH - 1, i + 1)]?.focus();
    }
  };

  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault();
    const next = clean(e.clipboardData.getData('text')).slice(0, ROOM_CODE_LENGTH);
    onChange(next);
    refs.current[Math.min(next.length, ROOM_CODE_LENGTH - 1)]?.focus();
  };

  return (
    <div className="code-tiles code-tiles-input" role="group" aria-label="Room code">
      {chars.map((ch, i) => (
        <input
          key={i}
          ref={(el) => {
            refs.current[i] = el;
          }}
          className="code-tile"
          value={ch}
          inputMode="text"
          autoCapitalize="characters"
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus && i === 0}
          aria-label={`Character ${i + 1}`}
          maxLength={ROOM_CODE_LENGTH}
          onChange={(e) => setAt(i, e.target.value.replace(ch, '') || e.target.value)}
          onKeyDown={(e) => onKey(i, e)}
          onPaste={onPaste}
          onFocus={(e) => {
            // Always type into the first empty box.
            if (i > value.length) refs.current[value.length]?.focus();
            else e.target.select();
          }}
        />
      ))}
    </div>
  );
}
