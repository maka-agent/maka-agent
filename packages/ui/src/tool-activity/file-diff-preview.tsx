import { previewVariants } from '../primitives/chat.js';
import { redactSecrets } from '../redact.js';
import { cn } from '../ui.js';
import { capLines } from './preview-utils.js';

/**
 * Line-level diff coloring. Splits the unified-diff text on newlines and
 * tags each line with `data-line="add" | "del" | "hunk" | "meta" | "ctx"`
 * for CSS to color. Doesn't try to parse the hunk semantics — we leave
 * that to a future inline editor view; this is just a readable preview.
 */
export function FileDiffPreview(props: { diff: string; paths: string[] }) {
  // Apply UI-level redaction then cap the displayed lines. Both are
  // @kenji's PR76 review items: never echo a token a tool happened to dump
  // into a diff (commit body, .env file diff, etc.), and never let a
  // 10k-line diff create 10k React elements.
  const { body, capped } = capLines(redactSecrets(props.diff));
  const lines = body.split('\n');
  return (
    <div className={cn(previewVariants({ part: 'overlay' }), previewVariants({ part: 'diff' }))} data-kind="file_diff">
      {props.paths.length > 0 && (
        <div className={previewVariants({ part: 'diff-paths' })}>
          {props.paths.map((path) => (
            <code key={path}>{path}</code>
          ))}
        </div>
      )}
      <pre className={previewVariants({ part: 'diff-body' })}>
        {lines.map((line, index) => (
          <span
            key={`${index}:${line.slice(0, 16)}`}
            className={previewVariants({ part: 'diff-line' })}
            data-line={diffLineKind(line)}
          >
            {line || ' '}
            {'\n'}
          </span>
        ))}
        {capped > 0 && (
          <span className={previewVariants({ part: 'diff-line' })} data-line="meta">
            {`\n… 已隐藏 ${capped} 行\n`}
          </span>
        )}
      </pre>
    </div>
  );
}

function diffLineKind(line: string): 'add' | 'del' | 'hunk' | 'meta' | 'ctx' {
  if (line.startsWith('+++') || line.startsWith('---')) return 'meta';
  if (line.startsWith('@@')) return 'hunk';
  if (line.startsWith('+')) return 'add';
  if (line.startsWith('-')) return 'del';
  return 'ctx';
}
