import { useEffect, useRef } from 'react';
import { monaco } from '../lib/monaco';

export interface CodeEditorHandle {
  revealLine: (line: number) => void;
  focus: () => void;
}

interface Props {
  /** One model per exercise keeps undo history when switching. */
  modelKey: string;
  initialValue: string;
  errorLine: number | null;
  errorMessage: string | null;
  onChange: (value: string) => void;
  onRun: () => void;
  handleRef?: (h: CodeEditorHandle | null) => void;
}

const models = new Map<string, monaco.editor.ITextModel>();

export function resetModel(key: string, value: string) {
  const m = models.get(key);
  if (m) m.setValue(value);
}

export function CodeEditor({ modelKey, initialValue, errorLine, errorMessage, onChange, onRun, handleRef }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const editor = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);
  const onChangeRef = useRef(onChange);
  const onRunRef = useRef(onRun);
  onChangeRef.current = onChange;
  onRunRef.current = onRun;

  useEffect(() => {
    const ed = monaco.editor.create(host.current!, {
      theme: 'labpulse',
      fontFamily: "'JetBrains Mono Variable', Consolas, monospace",
      fontSize: 15,
      lineHeight: 24,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
      automaticLayout: true,
      tabSize: 4,
      insertSpaces: true,
      renderLineHighlight: 'line',
      padding: { top: 16, bottom: 16 },
      fixedOverflowWidgets: true,
      wordWrap: 'off',
      'semanticHighlighting.enabled': false,
      ariaLabel: 'Code editor',
    });
    editor.current = ed;
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => onRunRef.current());
    const sub = ed.onDidChangeModelContent(() => onChangeRef.current(ed.getValue()));
    handleRef?.({
      revealLine: (line) => {
        ed.revealLineInCenter(line);
        ed.setPosition({ lineNumber: line, column: 1 });
        ed.focus();
      },
      focus: () => ed.focus(),
    });
    return () => {
      handleRef?.(null);
      sub.dispose();
      ed.dispose();
      editor.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const ed = editor.current;
    if (!ed) return;
    let model = models.get(modelKey);
    if (!model || model.isDisposed()) {
      model = monaco.editor.createModel(initialValue, 'python', monaco.Uri.parse(`inmemory://lab/${encodeURIComponent(modelKey)}.py`));
      models.set(modelKey, model);
    }
    if (ed.getModel() !== model) ed.setModel(model);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelKey]);

  useEffect(() => {
    const model = models.get(modelKey);
    if (!model) return;
    if (errorLine && errorLine <= model.getLineCount()) {
      monaco.editor.setModelMarkers(model, 'labpulse', [
        {
          severity: monaco.MarkerSeverity.Error,
          message: errorMessage ?? 'Error',
          startLineNumber: errorLine,
          endLineNumber: errorLine,
          startColumn: model.getLineFirstNonWhitespaceColumn(errorLine) || 1,
          endColumn: model.getLineMaxColumn(errorLine),
        },
      ]);
    } else {
      monaco.editor.setModelMarkers(model, 'labpulse', []);
    }
  }, [modelKey, errorLine, errorMessage]);

  return <div className="code-editor" ref={host} />;
}
