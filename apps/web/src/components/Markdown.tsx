import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

export function Markdown({ source, className }: { source: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(source, { async: false, gfm: true, breaks: false }) as string), [source]);
  return <div className={`markdown ${className ?? ''}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
