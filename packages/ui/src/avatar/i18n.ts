/**
 * Avatar strings. Apps can override any key through I18nProvider messages;
 * otherwise these built-ins are used.
 */
import { useLocale, useT } from '../i18n.js';
import type { Messages } from '../i18n.js';

const en: Messages = {
  'avatar.character': 'Character',
  'avatar.kind.robot': 'Robot',
  'avatar.kind.cat': 'Cat',
  'avatar.kind.dog': 'Dog',
  'avatar.kind.boy': 'Boy',
  'avatar.kind.girl': 'Girl',
  'avatar.background': 'Background',
  'avatar.custom': 'Custom color',
  'avatar.preview': 'Preview',
  'avatar.state.idle': 'Idle',
  'avatar.state.listening': 'Listening',
  'avatar.state.thinking': 'Thinking',
  'avatar.state.speaking': 'Speaking',
};

const zhCN: Messages = {
  'avatar.character': '角色',
  'avatar.kind.robot': '机器人',
  'avatar.kind.cat': '猫咪',
  'avatar.kind.dog': '小狗',
  'avatar.kind.boy': '男孩',
  'avatar.kind.girl': '女孩',
  'avatar.background': '背景',
  'avatar.custom': '自定义颜色',
  'avatar.preview': '预览',
  'avatar.state.idle': '待机',
  'avatar.state.listening': '倾听',
  'avatar.state.thinking': '思考',
  'avatar.state.speaking': '说话',
};

export function useAvatarT(): (key: string) => string {
  const t = useT();
  const dict = useLocale().toLowerCase().startsWith('zh') ? zhCN : en;
  return (key) => {
    const fromApp = t(key);
    return fromApp !== key ? fromApp : dict[key] ?? en[key] ?? key;
  };
}
