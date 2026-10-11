/**
 * Composer — auto-growing textarea with Enter-to-send (Shift+Enter for a new
 * line, IME-safe), image attachments (picker, paste, drag & drop) and a
 * Send/Stop button. Typing stays possible while a turn runs; only sending waits.
 */
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import type { ImagePart } from '@neo/protocol';
import { Icon } from './icons.js';
import { IconButton } from './primitives.js';
import { useT } from './i18n.js';

/** Imperative handle for keyboard shortcuts (⌘/ focuses the composer). */
export interface ComposerHandle {
  focus(): void;
  /** Replace the draft (e.g. a suggestion chip) and focus. */
  setText(text: string): void;
}

export interface ComposerProps {
  onSend: (text: string, images: ImagePart[]) => void;
  onCancel?: () => void;
  /** A turn is running: the send button becomes Stop. */
  busy?: boolean;
  disabled?: boolean;
  placeholder?: string;
  autoFocus?: boolean;
  /** Extra controls under the input (model picker, incognito toggle…). */
  toolbar?: ReactNode;
  /** Called whenever the draft text changes (drives the avatar's "listening" state). */
  onDraftChange?: (text: string) => void;
  /** Enter sends (default). Pass false on touch keyboards so Enter inserts a line break. */
  enterToSend?: boolean;
  /** Allow image attachments (default true). */
  allowImages?: boolean;
  handleRef?: Ref<ComposerHandle>;
  /** Max image size in bytes (default 5 MB). */
  maxImageBytes?: number;
}

const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_IMAGES = 6;
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp|avif)$/i;

function readImage(file: File): Promise<ImagePart | null> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? '');
      const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
      resolve(data ? { type: 'image', mediaType: file.type, data, alt: file.name } : null);
    };
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(file);
  });
}

interface Attachment {
  part: ImagePart;
  preview: string;
  name: string;
}

export function Composer({
  onSend,
  onCancel,
  busy = false,
  disabled = false,
  placeholder,
  autoFocus = false,
  toolbar,
  onDraftChange,
  enterToSend = true,
  allowImages = true,
  handleRef,
  maxImageBytes = DEFAULT_MAX_IMAGE_BYTES,
}: ComposerProps): ReactElement {
  const t = useT();
  const [text, setTextState] = useState('');
  const [images, setImages] = useState<Attachment[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const composing = useRef(false);
  const draftCb = useRef(onDraftChange);
  draftCb.current = onDraftChange;

  const setText = (value: string) => {
    setTextState(value);
    draftCb.current?.(value);
  };

  useImperativeHandle(handleRef, () => ({
    focus: () => textareaRef.current?.focus(),
    setText: (value: string) => {
      setText(value);
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (!el) return;
        el.focus();
        el.setSelectionRange(value.length, value.length);
      });
    },
  }));

  // Auto-grow up to 240px.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 240)}px`;
  }, [text]);

  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus();
  }, [autoFocus]);

  // Release object URLs when the composer goes away.
  const imagesRef = useRef(images);
  imagesRef.current = images;
  useEffect(() => () => imagesRef.current.forEach((img) => URL.revokeObjectURL(img.preview)), []);

  const canSend = !busy && !disabled && (text.trim().length > 0 || images.length > 0);

  const send = () => {
    if (!canSend) return;
    onSend(text.trim(), images.map((i) => i.part));
    images.forEach((img) => URL.revokeObjectURL(img.preview));
    setText('');
    setImages([]);
    setError(null);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== 'Enter' || e.shiftKey || composing.current || e.nativeEvent.isComposing) return;
    if (!enterToSend && !(e.metaKey || e.ctrlKey)) return;
    e.preventDefault();
    send();
  };

  const addFiles = async (files: File[]) => {
    if (!allowImages) return;
    setError(null);
    const candidates = files.filter((f) => IMAGE_TYPES.test(f.type));
    if (candidates.length < files.length) setError(t('chat.image_unsupported'));
    const room = MAX_IMAGES - images.length;
    if (room <= 0) {
      setError(t('chat.image_limit', { n: MAX_IMAGES }));
      return;
    }
    const tooBig = candidates.filter((f) => f.size > maxImageBytes);
    if (tooBig.length) setError(t('chat.image_too_large', { mb: Math.round(maxImageBytes / 1024 / 1024) }));
    const accepted = candidates.filter((f) => f.size <= maxImageBytes).slice(0, room);
    const parts = await Promise.all(accepted.map(readImage));
    const next: Attachment[] = [];
    parts.forEach((part, i) => {
      const file = accepted[i]!;
      if (part) next.push({ part, preview: URL.createObjectURL(file), name: file.name });
    });
    if (next.length) setImages((prev) => [...prev, ...next]);
  };

  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData.items)
      .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
      .map((item) => item.getAsFile())
      .filter((f): f is File => f !== null);
    if (files.length && allowImages) {
      e.preventDefault();
      void addFiles(files);
    }
  };

  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length) void addFiles(files);
  };

  const removeImage = (index: number) => {
    setImages((prev) => {
      const img = prev[index];
      if (img) URL.revokeObjectURL(img.preview);
      return prev.filter((_, j) => j !== index);
    });
  };

  return (
    <div
      className="neo-composer"
      data-dragging={dragging || undefined}
      onDragOver={(e) => {
        if (!allowImages) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setDragging(false);
      }}
      onDrop={onDrop}
    >
      {images.length > 0 && (
        <div className="neo-composer__thumbs">
          {images.map((img, i) => (
            <div key={img.preview} className="neo-composer__thumb">
              <img src={img.preview} alt={img.name} />
              <button type="button" aria-label={t('chat.remove_image', { name: img.name })} onClick={() => removeImage(i)}>
                <Icon name="x" size={11} />
              </button>
            </div>
          ))}
        </div>
      )}
      {error && (
        <p className="neo-error-text" role="alert" style={{ margin: '0 0.5rem' }}>
          {error}
        </p>
      )}
      <div className="neo-composer__row">
        {allowImages && (
          <>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp,image/avif"
              multiple
              hidden
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
            <IconButton icon="paperclip" label={t('chat.attach_image')} onClick={() => fileRef.current?.click()} disabled={disabled} />
          </>
        )}
        <textarea
          ref={textareaRef}
          className="neo-composer__input"
          rows={1}
          value={text}
          placeholder={placeholder ?? t('chat.placeholder')}
          aria-label={placeholder ?? t('chat.placeholder')}
          disabled={disabled}
          enterKeyHint={enterToSend ? 'send' : 'enter'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onCompositionStart={() => {
            composing.current = true;
          }}
          onCompositionEnd={() => {
            composing.current = false;
          }}
        />
        {busy ? (
          <IconButton icon="stop" label={t('chat.stop')} variant="secondary" className="neo-composer__send" onClick={onCancel} disabled={!onCancel} />
        ) : (
          <IconButton icon="arrow-up" label={t('chat.send')} variant="primary" className="neo-composer__send" onClick={send} disabled={!canSend} />
        )}
      </div>
      {toolbar && <div className="neo-composer__toolbar">{toolbar}</div>}
    </div>
  );
}
