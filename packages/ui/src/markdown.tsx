/**
 * Safe Markdown renderer (GFM via remark-gfm).
 *
 * - Raw HTML is dropped (`skipHtml`; rehype-raw is never used).
 * - Links must pass `isSafeLinkUrl` (http(s), mailto:, tel:, neo://); the app's
 *   LinkProvider decides what they do. Web links open in a new tab.
 * - Images must be http(s) or data:image/*; remote ones go through the
 *   remote image gate (click to load, see remote-image.tsx).
 * - Fenced code gets a header with the language and a copy button.
 */
import { memo, useState, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { isSafeLinkUrl } from '@neo/protocol';
import { Icon } from './icons.js';
import { useT } from './i18n.js';
import { useLinkClick } from './links.js';
import { copyText } from './clipboard.js';
import { SafeImage } from './remote-image.js';

const IMAGE_URL = /^(https?:\/\/\S+|data:image\/[a-z0-9.+-]+[;,]\S*)$/i;

/** Keep only URLs we are willing to render; everything else becomes empty. */
function urlTransform(url: string, key: string): string {
  if (key === 'src') return IMAGE_URL.test(url.trim()) ? url : '';
  return isSafeLinkUrl(url) ? url : '';
}

interface HastNode {
  type: string;
  value?: string;
  tagName?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
}

function hastText(node: HastNode | undefined): string {
  if (!node) return '';
  if (node.type === 'text') return node.value ?? '';
  return (node.children ?? []).map(hastText).join('');
}

export function CopyButton({ text, className, label }: { text: string; className?: string; label?: string }): ReactElement {
  const t = useT();
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className={['neo-copy-btn', className].filter(Boolean).join(' ')}
      aria-label={copied ? t('common.copied') : label ?? t('block.copy_code')}
      onClick={() => {
        void copyText(text).then((ok) => {
          if (!ok) return;
          setCopied(true);
          setTimeout(() => setCopied(false), 1500);
        });
      }}
    >
      <Icon name={copied ? 'check' : 'copy'} size={13} />
      <span aria-hidden="true">{copied ? t('common.copied') : t('common.copy')}</span>
    </button>
  );
}

function SafeLink({ href, children }: { href?: string; children?: ReactNode }): ReactElement {
  const url = href ?? '';
  const onClick = useLinkClick(url);
  if (!url || !isSafeLinkUrl(url)) return <span>{children}</span>;
  const external = /^https?:/i.test(url);
  return (
    <a href={url} onClick={onClick} target={external ? '_blank' : undefined} rel={external ? 'noopener noreferrer' : undefined}>
      {children}
    </a>
  );
}

function CodeFence({ node }: { node?: HastNode }): ReactElement {
  const code = node?.children?.find((c) => c.tagName === 'code');
  const text = hastText(code).replace(/\n$/, '');
  const cls = code?.properties?.className;
  const language = Array.isArray(cls) ? String(cls.find((c) => String(c).startsWith('language-')) ?? '').replace('language-', '') : '';
  return (
    <div className="neo-code">
      <div className="neo-code__head">
        <span>{language || 'text'}</span>
        <CopyButton text={text} />
      </div>
      <pre>
        <code>{text}</code>
      </pre>
    </div>
  );
}

const components: Components = {
  a: ({ href, children }) => <SafeLink href={href}>{children}</SafeLink>,
  img: ({ src, alt }) => {
    if (typeof src !== 'string' || !IMAGE_URL.test(src.trim())) return null;
    // Markdown images can sit inside links, so the placeholder must not be a <button>.
    return <SafeImage src={src} alt={alt ?? ''} nested />;
  },
  pre: ({ node }) => <CodeFence node={node as HastNode | undefined} />,
  table: ({ children }) => <table>{children}</table>,
};

function MarkdownImpl(props: { text: string; className?: string; streaming?: boolean }): ReactElement {
  const { text, className, streaming } = props;
  const cls = ['neo-prose', streaming ? 'neo-caret' : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components} skipHtml urlTransform={urlTransform}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Memoized: long conversations re-render often while streaming. */
export const Markdown = memo(MarkdownImpl);
