import { memo, useMemo, useState, type HTMLAttributes, type RefObject } from 'react';
import { Icon } from './Icons';
import './EmojiPicker.css';

type ChatEmojiCategory = 'recent' | 'faces' | 'gestures' | 'hearts' | 'activity' | 'objects';
type ChatEmoji = { value: string; label: string };
type ChatEmojiGroup = { id: Exclude<ChatEmojiCategory, 'recent'>; label: string; icon: string; emojis: ChatEmoji[] };

const CHAT_RECENT_EMOJIS_KEY = 'screenlink-chat-recent-emojis-v1';

const CHAT_EMOJI_GROUPS: ChatEmojiGroup[] = [
  {
    id: 'faces', label: 'Rostos', icon: '😀', emojis: [
      { value: '😀', label: 'feliz sorriso alegria' }, { value: '😂', label: 'rindo lágrimas engraçado' },
      { value: '🥹', label: 'emocionado segurando lágrimas' }, { value: '😍', label: 'apaixonado coração olhos' },
      { value: '🥰', label: 'amor carinho corações' }, { value: '😎', label: 'legal óculos sol' },
      { value: '🤔', label: 'pensando dúvida' }, { value: '😅', label: 'suor alívio nervoso' },
      { value: '😭', label: 'chorando triste lágrimas' }, { value: '😡', label: 'bravo raiva' },
      { value: '🥳', label: 'festa comemoração' }, { value: '🤯', label: 'surpreso cabeça explodindo' },
      { value: '😴', label: 'sono dormindo' }, { value: '🫠', label: 'derretendo calor' },
      { value: '🙄', label: 'revirando olhos' }, { value: '🤭', label: 'riso mão boca' }
    ]
  },
  {
    id: 'gestures', label: 'Gestos', icon: '👋', emojis: [
      { value: '👋', label: 'oi tchau aceno' }, { value: '👍', label: 'positivo gostei sim' },
      { value: '👎', label: 'negativo não gostei' }, { value: '👏', label: 'palmas parabéns' },
      { value: '🙌', label: 'comemoração mãos' }, { value: '🙏', label: 'obrigado por favor oração' },
      { value: '🤝', label: 'acordo aperto mãos' }, { value: '👌', label: 'ok perfeito' },
      { value: '✌️', label: 'paz vitória' }, { value: '🤞', label: 'sorte dedos cruzados' },
      { value: '💪', label: 'força músculo' }, { value: '🫶', label: 'coração mãos carinho' },
      { value: '👀', label: 'olhos olhando' }, { value: '🫡', label: 'saudação respeito' },
      { value: '🤌', label: 'gesto italiano' }, { value: '👊', label: 'soco cumprimento' }
    ]
  },
  {
    id: 'hearts', label: 'Símbolos', icon: '❤️', emojis: [
      { value: '❤️', label: 'coração vermelho amor' }, { value: '💙', label: 'coração azul amor' },
      { value: '💜', label: 'coração roxo amor' }, { value: '🖤', label: 'coração preto' },
      { value: '💔', label: 'coração partido' }, { value: '💕', label: 'dois corações' },
      { value: '✨', label: 'brilho estrelas' }, { value: '🔥', label: 'fogo incrível' },
      { value: '✅', label: 'certo concluído confirmação' }, { value: '❌', label: 'errado cancelar não' },
      { value: '⚠️', label: 'aviso atenção' }, { value: '💯', label: 'cem perfeito' },
      { value: '💬', label: 'mensagem conversa' }, { value: '💤', label: 'sono zzz' },
      { value: '❓', label: 'pergunta dúvida' }, { value: '‼️', label: 'exclamação importante' }
    ]
  },
  {
    id: 'activity', label: 'Atividades', icon: '🎉', emojis: [
      { value: '🎉', label: 'festa confete comemoração' }, { value: '🎮', label: 'jogo controle videogame' },
      { value: '⚽', label: 'futebol bola esporte' }, { value: '🏀', label: 'basquete bola esporte' },
      { value: '🎵', label: 'música nota' }, { value: '🎧', label: 'fone música áudio' },
      { value: '🎬', label: 'filme cinema claquete' }, { value: '🏆', label: 'troféu vitória' },
      { value: '🎯', label: 'alvo objetivo' }, { value: '🚀', label: 'foguete lançamento' },
      { value: '🎁', label: 'presente caixa' }, { value: '🎨', label: 'arte pintura' },
      { value: '📸', label: 'foto câmera' }, { value: '🎤', label: 'microfone cantar' },
      { value: '💻', label: 'computador notebook' }, { value: '📱', label: 'celular telefone' }
    ]
  },
  {
    id: 'objects', label: 'Objetos', icon: '💡', emojis: [
      { value: '💡', label: 'ideia lâmpada' }, { value: '📌', label: 'alfinete marcar' },
      { value: '📎', label: 'clipe anexo' }, { value: '🔗', label: 'link corrente' },
      { value: '🔒', label: 'cadeado seguro privado' }, { value: '🔔', label: 'sino notificação' },
      { value: '⏰', label: 'relógio alarme' }, { value: '📅', label: 'calendário data' },
      { value: '📝', label: 'anotação escrever' }, { value: '🔍', label: 'buscar lupa' },
      { value: '🛠️', label: 'ferramentas ajuste' }, { value: '⚙️', label: 'configuração engrenagem' },
      { value: '🔋', label: 'bateria energia' }, { value: '📶', label: 'sinal conexão' },
      { value: '🎲', label: 'dado jogo sorte' }, { value: '☕', label: 'café bebida' }
    ]
  }
];

const ALL_CHAT_EMOJIS = CHAT_EMOJI_GROUPS.flatMap(group => group.emojis);
const EMOJI_BY_VALUE = new Map(ALL_CHAT_EMOJIS.map(item => [item.value, item]));
const DEFAULT_RECENT_EMOJIS = ['😂', '❤️', '👍', '😭', '🔥', '👏', '🥹', '✨'];
const CHAT_EMOJI_CATEGORIES: Array<{ id: ChatEmojiCategory; label: string; icon: string }> = [
  { id: 'recent', label: 'Recentes', icon: '◷' },
  ...CHAT_EMOJI_GROUPS.map(({ id, label, icon }) => ({ id, label, icon }))
];

function normalizeEmojiSearch(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
}

function loadRecentChatEmojis() {
  try {
    const raw = window.localStorage.getItem(CHAT_RECENT_EMOJIS_KEY);
    const parsed = JSON.parse(raw || '[]') as unknown;
    if (!Array.isArray(parsed)) return DEFAULT_RECENT_EMOJIS;
    const valid = parsed.filter((value): value is string => typeof value === 'string' && EMOJI_BY_VALUE.has(value));
    const unique = [...new Set([...valid, ...DEFAULT_RECENT_EMOJIS])].slice(0, 16);
    return unique.length ? unique : DEFAULT_RECENT_EMOJIS;
  } catch {
    return DEFAULT_RECENT_EMOJIS;
  }
}

export interface EmojiPickerProps {
  panelRef: RefObject<HTMLElement | null>;
  phone: boolean;
  sheetProps: HTMLAttributes<HTMLElement>;
  onSelect: (emoji: string) => void;
}

const EmojiPicker = memo(function EmojiPicker({ panelRef, phone, sheetProps, onSelect }: EmojiPickerProps) {
  const [emojiCategory, setEmojiCategory] = useState<ChatEmojiCategory>('recent');
  const [emojiSearch, setEmojiSearch] = useState('');
  const [recentEmojis, setRecentEmojis] = useState(loadRecentChatEmojis);

  const emojiSearchTerm = useMemo(() => normalizeEmojiSearch(emojiSearch), [emojiSearch]);

  const emojiOptions = useMemo<ChatEmoji[]>(() => {
    if (emojiSearchTerm) {
      return ALL_CHAT_EMOJIS.filter(emoji => normalizeEmojiSearch(emoji.label).includes(emojiSearchTerm));
    }
    if (emojiCategory === 'recent') {
      return recentEmojis
        .map(value => EMOJI_BY_VALUE.get(value))
        .filter((emoji): emoji is ChatEmoji => Boolean(emoji));
    }
    return CHAT_EMOJI_GROUPS.find(group => group.id === emojiCategory)?.emojis || [];
  }, [emojiCategory, emojiSearchTerm, recentEmojis]);

  const activeEmojiCategoryIndex = Math.max(0, CHAT_EMOJI_CATEGORIES.findIndex(category => category.id === emojiCategory));

  const handleSelect = (emoji: string) => {
    setRecentEmojis(current => {
      const next = [emoji, ...current.filter(item => item !== emoji)].slice(0, 16);
      try {
        window.localStorage.setItem(CHAT_RECENT_EMOJIS_KEY, JSON.stringify(next));
      } catch {
        // ignore storage restrictions
      }
      return next;
    });
    onSelect(emoji);
  };

  return (
    <section
      ref={panelRef}
      id="chat-emoji-picker"
      className="emoji-picker"
      role={phone ? 'dialog' : undefined}
      aria-modal={phone || undefined}
      aria-label="Seletor de emojis"
      {...sheetProps}
    >
      <div className="emoji-picker-handle" aria-hidden="true" />
      <label className="emoji-picker-search">
        <Icon name="search" />
        <input
          type="search"
          value={emojiSearch}
          onChange={event => setEmojiSearch(event.currentTarget.value)}
          placeholder="Buscar emoji"
          aria-label="Buscar emoji"
        />
      </label>
      <nav className={`emoji-picker-categories ${emojiSearchTerm ? 'is-searching' : ''}`} role="tablist" aria-label="Categorias de emojis">
        <span
          className="emoji-category-indicator"
          style={{ transform: `translate3d(calc(${activeEmojiCategoryIndex * 100}% + ${activeEmojiCategoryIndex * 3}px), 0, 0)` }}
          aria-hidden="true"
        />
        {CHAT_EMOJI_CATEGORIES.map(category => (
          <button
            className={!emojiSearchTerm && emojiCategory === category.id ? 'is-active' : ''}
            key={category.id}
            type="button"
            role="tab"
            aria-selected={!emojiSearchTerm && emojiCategory === category.id}
            aria-label={category.label}
            title={category.label}
            onClick={() => {
              setEmojiSearch('');
              setEmojiCategory(category.id);
            }}
          >
            {category.icon}
          </button>
        ))}
      </nav>
      <div className="emoji-picker-heading">
        <strong>{emojiSearchTerm ? 'Resultados' : CHAT_EMOJI_CATEGORIES.find(category => category.id === emojiCategory)?.label}</strong>
        <small>{emojiOptions.length}</small>
      </div>
      <div className="emoji-picker-grid" role="listbox" aria-label={emojiSearchTerm ? 'Resultados da busca' : 'Emojis disponíveis'}>
        {emojiOptions.map(emoji => (
          <button
            key={emoji.value}
            type="button"
            role="option"
            aria-label={emoji.label}
            title={emoji.label}
            onClick={() => handleSelect(emoji.value)}
          >
            {emoji.value}
          </button>
        ))}
        {!emojiOptions.length && <p className="emoji-picker-empty">Nenhum emoji encontrado.</p>}
      </div>
    </section>
  );
});

export default EmojiPicker;
