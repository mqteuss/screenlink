import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, type FormEvent, type RefObject } from 'react';
import { Icon, MotionIcon } from './Icons';

function normalizeChatDraft(value: string) {
  return value.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, 1_000);
}

function resizeChatInput(input: HTMLTextAreaElement | null, bounds: { minHeight: number; maxHeight: number }) {
  if (!input) return;
  const { minHeight, maxHeight } = bounds;
  input.style.height = '0px';
  const scrollHeight = input.scrollHeight;
  const nextHeight = Math.min(maxHeight, Math.max(minHeight, scrollHeight));
  input.style.height = `${nextHeight}px`;
  input.style.overflowY = scrollHeight > maxHeight ? 'auto' : 'hidden';
  input.closest('.chat-composer')?.classList.toggle('is-multiline', nextHeight > minHeight + 8);
}

export interface ChatComposerHandle {
  insertEmoji: (emoji: string, focusAfter: boolean) => void;
  focus: () => void;
  blur: () => void;
  clear: () => void;
  resize: () => void;
}

export interface ChatComposerProps {
  canSend: boolean;
  placeholder: string;
  phone: boolean;
  emojiOpen: boolean;
  emojiPickerRef: RefObject<HTMLDivElement | null>;
  onToggleEmoji: () => void;
  onFocusChange: (focused: boolean) => void;
  onSubmitText: (text: string) => boolean;
}

export const ChatComposer = memo(forwardRef<ChatComposerHandle, ChatComposerProps>(function ChatComposer(
  { canSend, placeholder, phone, emojiOpen, emojiPickerRef, onToggleEmoji, onFocusChange, onSubmitText },
  ref
) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const blurTimerRef = useRef<number | null>(null);
  const boundsRef = useRef({ minHeight: 32, maxHeight: 120 });

  useEffect(() => () => {
    if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current);
  }, []);

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const styles = window.getComputedStyle(input);
    boundsRef.current = {
      minHeight: Number.parseFloat(styles.minHeight) || 32,
      maxHeight: Number.parseFloat(styles.maxHeight) || 120
    };
    resizeChatInput(input, boundsRef.current);
  }, [phone]);

  useImperativeHandle(ref, () => ({
    insertEmoji(emoji: string, focusAfter: boolean) {
      const input = inputRef.current;
      let caretTarget = 0;
      setValue(current => {
        const start = input?.selectionStart ?? current.length;
        const end = input?.selectionEnd ?? current.length;
        const safeStart = Math.min(start, current.length);
        const safeEnd = Math.min(end, current.length);
        caretTarget = safeStart + emoji.length;
        return `${current.slice(0, safeStart)}${emoji}${current.slice(safeEnd)}`.slice(0, 1_000);
      });
      window.requestAnimationFrame(() => {
        const target = inputRef.current;
        if (!target) return;
        const caret = Math.min(caretTarget, target.value.length);
        if (focusAfter) target.focus();
        target.setSelectionRange(caret, caret);
        resizeChatInput(target, boundsRef.current);
      });
    },
    focus() {
      inputRef.current?.focus();
    },
    blur() {
      inputRef.current?.blur();
    },
    clear() {
      setValue('');
      if (inputRef.current) {
        inputRef.current.style.height = '';
        inputRef.current.style.overflowY = 'hidden';
        inputRef.current.closest('.chat-composer')?.classList.remove('is-multiline');
      }
    },
    resize() {
      resizeChatInput(inputRef.current, boundsRef.current);
    }
  }), []);

  const handleSubmit = useCallback((event: FormEvent) => {
    event.preventDefault();
    const cleaned = normalizeChatDraft(value);
    if (!cleaned || !canSend) return;
    if (onSubmitText(cleaned)) {
      setValue('');
      window.requestAnimationFrame(() => {
        const input = inputRef.current;
        if (!input) return;
        input.style.height = '';
        input.style.overflowY = 'hidden';
        input.closest('.chat-composer')?.classList.remove('is-multiline');
      });
    }
  }, [canSend, onSubmitText, value]);

  const hasText = Boolean(normalizeChatDraft(value));

  return (
    <form className="chat-composer" onSubmit={handleSubmit}>
      <div className="emoji-picker-anchor" ref={emojiPickerRef}>
        <button
          className={emojiOpen ? 'is-open' : ''}
          type="button"
          onClick={onToggleEmoji}
          disabled={!canSend}
          aria-expanded={emojiOpen}
          aria-controls="chat-emoji-picker"
          aria-label={emojiOpen ? 'Voltar ao teclado' : 'Escolher emoji'}
        >
          <MotionIcon active={emojiOpen && phone} activeIcon="keyboard" inactiveIcon="smile" />
        </button>
      </div>
      <textarea
        ref={inputRef}
        aria-label="Escrever mensagem"
        title={phone ? 'Enter quebra a linha' : 'Enter envia · Shift+Enter quebra a linha'}
        enterKeyHint={phone ? 'enter' : 'send'}
        rows={1}
        value={value}
        onFocus={() => {
          if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current);
          onFocusChange(true);
        }}
        onBlur={() => {
          if (blurTimerRef.current !== null) window.clearTimeout(blurTimerRef.current);
          blurTimerRef.current = window.setTimeout(() => {
            blurTimerRef.current = null;
            onFocusChange(document.activeElement === inputRef.current);
          }, 0);
        }}
        onChange={event => {
          setValue(event.target.value);
          resizeChatInput(event.currentTarget, boundsRef.current);
        }}
        onKeyDown={event => {
          if (!phone && event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            event.currentTarget.form?.requestSubmit();
          }
        }}
        placeholder={placeholder}
        maxLength={1000}
        disabled={!canSend}
      />
      <button
        type="submit"
        onPointerDown={event => {
          if (phone) event.preventDefault();
        }}
        disabled={!hasText || !canSend}
        aria-label="Enviar mensagem"
      >
        <Icon name="send" />
      </button>
    </form>
  );
}));
