/**
 * @neo/ui — React UI kit shared by web, desktop and mobile.
 *
 * FROZEN PUBLIC API (docs/IMPLEMENTATION_PLAN.md, WP-ui). Implementations may
 * add exports but must not change these signatures. Styling: Tailwind v4
 * utilities + the CSS variables in `@neo/ui/styles.css` (apps add
 * `@source "<path>/packages/ui/src"` so Tailwind sees these classes).
 */

// ───────────────────────────── theme & i18n ─────────────────────────────

export type { ThemeSetting } from './theme.js';
export { ThemeProvider, useTheme } from './theme.js';

export type { Messages, TranslateFn } from './i18n.js';
export { dictionaries, I18nProvider, useT, useLocale, resolveLocale, buildMessages, createTranslator } from './i18n.js';

// ───────────────────────────── primitives ─────────────────────────────

export { Icon, ICON_NAMES, iconPaths } from './icons.js';

export type { ButtonVariant, ButtonProps, Tone, TextFieldProps, SelectOption, SelectGroup, TabItem } from './primitives.js';
export {
  Button,
  IconButton,
  Spinner,
  Badge,
  Switch,
  Modal,
  EmptyState,
  Avatar,
  Chip,
  Field,
  TextField,
  TextArea,
  Select,
  SegmentedControl,
  Tabs,
  tabPanelProps,
  Skeleton,
} from './primitives.js';

export type { ConfirmOptions, ConfirmFn } from './confirm.js';
export { ConfirmProvider, useConfirm } from './confirm.js';

export type { LinkHandler } from './links.js';
export { LinkProvider, useLinkClick, useOpenLink } from './links.js';

export { formatDateTime, formatDate, formatTime, formatRelative, formatCompact, formatNumber, dayKey } from './format.js';
export { copyText } from './clipboard.js';

// ───────────────────────────── generative UI ─────────────────────────────

export type { UIActionContext, OnUIAction, LiveData, BlockRendererProps } from './blocks.js';
export { BlockRenderer, BlockList, formatCell, validateFormField } from './blocks.js';

export { Markdown, CopyButton } from './markdown.js';
export {
  RemoteImageProvider,
  RemoteImagePlaceholder,
  SafeImage,
  useRemoteImages,
  useRemoteImagePolicy,
  classifyImageUrl,
  allowRemoteImageHosts,
  isRemoteImageHostAllowed,
  resetRemoteImageHosts,
} from './remote-image.js';
export type { RemoteImagePolicy, RemoteImageState, ImageSource, SafeImageProps, RemoteImagePlaceholderProps } from './remote-image.js';

// ───────────────────────────── chart ─────────────────────────────────────

export { ChartRenderer, niceTicks, prepareSeries } from './chart.js';

// ───────────────────────────── chat ─────────────────────────────────────

export type { MessageViewProps } from './message.js';
export { MessageView, ConfirmationCard, humanizeToolName, uiActionConfirmOptions, useUiActionConfirm } from './message.js';

export type { ComposerProps, ComposerHandle } from './composer.js';
export { Composer } from './composer.js';

// ───────────────────────────── memory ─────────────────────────────────

export type { MemoryGraphViewProps } from './memory-graph.js';
export { MemoryGraphView, GraphLegend, memoryKindColor, MEMORY_KIND_ORDER } from './memory-graph.js';
export { MemoryNet3D } from './memory-net-3d.js';
export { countMemories } from './memory-net-3d-layout.js';

export type { MemoryNodeCardProps } from './memory-card.js';
export { MemoryNodeCard } from './memory-card.js';

// ───────────────────────────── avatar ─────────────────────────────────

export type {
  AvatarCharacter, AvatarConfig, AvatarState, NeoAvatarProps, AvatarShape, AvatarPickerProps, AvatarPickerSlots, AvatarActivity, NeoFigureProps, NeoFigureVariant,
} from './avatar/index.js';
export {
  NeoAvatar, AvatarStyles, AvatarPicker, useAvatarState, NeoFigure,
  AVATAR_CHARACTERS, AVATAR_STATES, AVATAR_BACKGROUNDS, DEFAULT_AVATAR,
  serializeAvatar, parseAvatar, isAvatarString, normalizeAvatar,
} from './avatar/index.js';
