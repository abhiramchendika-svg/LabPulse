// Monaco, bundled locally (no CDN), with only the editor core and Python highlighting.
import 'monaco-editor/esm/vs/editor/edcore.main';
import * as monaco from 'monaco-editor/esm/vs/editor/editor.api';
import 'monaco-editor/esm/vs/basic-languages/python/python.contribution';
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';

(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker: () => new EditorWorker(),
};

monaco.editor.defineTheme('labpulse', {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '7a8296', fontStyle: 'italic' },
    { token: 'keyword', foreground: '6b2fb3' },
    { token: 'string', foreground: '2d7a3e' },
    { token: 'number', foreground: 'b4501b' },
    { token: 'identifier', foreground: '172036' },
    { token: 'type', foreground: '1d6f93' },
    { token: 'delimiter', foreground: '3f4a60' },
  ],
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#172036',
    'editorLineNumber.foreground': '#a6adbb',
    'editorLineNumber.activeForeground': '#172036',
    'editor.lineHighlightBackground': '#f4f6f9',
    'editor.lineHighlightBorder': '#00000000',
    'editor.selectionBackground': '#cfe5f0',
    'editorCursor.foreground': '#1d7fa8',
    'editorIndentGuide.background1': '#eceff3',
    'editorGutter.background': '#ffffff',
    'editorError.foreground': '#c8323c',
  },
});

export { monaco };
