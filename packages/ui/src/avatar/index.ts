export type { AvatarCharacter, AvatarConfig, AvatarState } from './config.js';
export {
  AVATAR_CHARACTERS, AVATAR_STATES, AVATAR_BACKGROUNDS, DEFAULT_AVATAR,
  serializeAvatar, parseAvatar, isAvatarString, normalizeAvatar,
} from './config.js';

export type { NeoAvatarProps, AvatarShape } from './neo-avatar.js';
export { NeoAvatar, AvatarStyles } from './neo-avatar.js';

export type { NeoFigureProps, NeoFigureVariant } from './neo-figure.js';
export { NeoFigure } from './neo-figure.js';

export type { AvatarPickerProps, AvatarPickerSlots } from './avatar-picker.js';
export { AvatarPicker } from './avatar-picker.js';

export type { AvatarActivity } from './use-avatar-state.js';
export { useAvatarState } from './use-avatar-state.js';
