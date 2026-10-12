/**
 * Internationalisation: locale resolution, string lookup with {var}
 * interpolation and plural forms.
 *
 * - Built-in locales: 'en' and 'zh-CN'. 'auto' follows navigator.language.
 *   Unknown locales fall back to English.
 * - Plurals: when `vars.n` is a number, `key_one` / `key_other` (CLDR rules via
 *   Intl.PluralRules) are tried before `key`.
 * - Apps pass their own dictionaries via <I18nProvider messages>; they are
 *   merged over the built-ins (English first, then the active locale).
 */
import { createContext, useContext, useMemo, type ReactElement, type ReactNode } from 'react';

export type Messages = Record<string, string>;

// ── built-in dictionaries ─────────────────────────────────────────────────

const en: Messages = {
  // common
  'common.close': 'Close',
  'common.cancel': 'Cancel',
  'common.confirm': 'Confirm',
  'common.are_you_sure': 'Are you sure?',
  'common.save': 'Save',
  'common.edit': 'Edit',
  'common.delete': 'Delete',
  'common.remove': 'Remove',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.submit': 'Submit',
  'common.approve': 'Allow',
  'common.deny': 'Deny',
  'common.always_allow': 'Always allow',
  'common.loading': 'Loading…',
  'common.empty': 'Nothing here yet',
  'common.error': 'Something went wrong',
  'common.retry': 'Retry',
  'common.search': 'Search',
  'common.filter': 'Filter',
  'common.more': 'More',
  'common.back': 'Back',
  'common.next': 'Next',
  'common.open': 'Open',
  'common.pin': 'Pin',
  'common.unpin': 'Unpin',
  'common.archive': 'Archive',
  'common.done': 'Done',
  'common.required': 'required',
  'common.yes': 'Yes',
  'common.no': 'No',

  // chat
  'chat.send': 'Send',
  'chat.stop': 'Stop generating',
  'chat.placeholder': 'Message NEO…',
  'chat.attach_image': 'Attach images',
  'chat.image_too_large': 'Images must be {mb} MB or smaller.',
  'chat.image_unsupported': 'Only PNG, JPEG, GIF, WebP and AVIF images can be attached.',
  'chat.image_limit': 'You can attach up to {n} images.',
  'chat.remove_image': 'Remove {name}',
  'chat.image_attachment': 'Attached image',
  'chat.thought_process': 'Thought process',
  'chat.thinking': 'Thinking…',
  'chat.reasoning_hidden': 'Reasoning hidden by the provider',
  'chat.recalled': 'Recalled {n} memories',
  'chat.recalled_one': 'Recalled {n} memory',
  'chat.recalled_other': 'Recalled {n} memories',
  'chat.recalled_plural': 'Recalled {n} memories',
  'chat.tool_running': 'Running…',
  'chat.tool_waiting': 'Waiting for your OK',
  'chat.tool_done': 'Done',
  'chat.tool_error': 'Failed',
  'chat.tool_incomplete': "Didn't finish",
  'chat.tool_input': 'Input',
  'chat.tool_output': 'Result',
  'chat.confirm_title': '{name} wants to do this',
  'chat.confirm_expires': 'Expires in {time}',
  'chat.show_details': 'Show details',
  'chat.hide_details': 'Hide details',
  'chat.risk.read': 'Reads data',
  'chat.risk.write': 'Changes data',
  'chat.risk.external': 'Goes online',
  'chat.risk.dangerous': 'Irreversible',
  'chat.risk_low': 'Low risk',
  'chat.risk_medium': 'Medium risk',
  'chat.risk_high': 'High risk',
  'chat.ui_event': 'Chose an option',
  'chat.ui_event_values_one': '{n} field',
  'chat.ui_event_values_other': '{n} fields',
  'chat.ui_event_values': '{n} fields',
  'chat.error_title': "NEO couldn't finish this reply",
  'chat.stopped': 'Stopped',
  'chat.copy_message': 'Copy message',
  'chat.sources': 'Sources',

  // blocks
  'block.copy_code': 'Copy code',
  'image.load_from': 'Load image from {host}',
  'image.load_many': 'Load {count} images from {host}',
  'image.remote_hint': 'Images from other sites can tell them you viewed this.',
  'block.copy_done': 'Copied',
  'block.show_all': 'Show all',
  'block.show_less': 'Show less',
  'block.show_all_rows': 'Show all {n} rows',
  'block.table_rows': '{n} rows',
  'block.invalid': "Can't display this content",
  'block.invalid_detail': 'Show as text',
  'block.form_error_required': 'This field is required',
  'block.form_error_email': 'Enter a valid email address',
  'block.form_error_url': 'Enter a valid web address (https://…)',
  'block.form_error_number': 'Enter a number',
  'block.form_error_min': 'Must be at least {min}',
  'block.form_error_max': 'Must be at most {max}',
  'block.form_choose': 'Choose…',
  'block.form_sent': 'Sent',
  'block.form_failed': "Couldn't send. Try again.",
  'block.previous': 'Previous',
  'block.next': 'Next',
  'block.tasks_title': 'Tasks',
  'block.tasks_progress': '{done} of {total} done',
  'block.tasks_empty': 'No tasks here.',
  'block.memory_title': 'Memory',

  // chart
  'chart.caption': '{kind} chart',
  'chart.category': 'Category',
  'chart.total': 'Total',

  // reminders
  'reminder.snooze_10': 'Snooze 10 min',
  'reminder.snooze_60': 'Snooze 1 h',
  'reminder.done': 'Done',
  'reminder.widget_label': 'Reminder: {title}',
  'reminder.status.scheduled': 'Scheduled',
  'reminder.status.fired': 'Due now',
  'reminder.status.completed': 'Done',
  'reminder.status.cancelled': 'Cancelled',

  // tasks
  'task.priority_1': 'Low priority',
  'task.priority_2': 'Medium priority',
  'task.priority_3': 'High priority',

  // memory
  'memory.forget': 'Forget',
  'memory.forget_title': 'Forget this memory?',
  'memory.forget_confirm': 'NEO will forget this for good. This cannot be undone.',
  'memory.restore': 'Restore',
  'memory.resolved_forgotten': 'Forgotten',
  'memory.kind.episode': 'Episode',
  'memory.kind.fact': 'Fact',
  'memory.kind.entity': 'Entity',
  'memory.kind.preference': 'Preference',
  'memory.kind.skill': 'Skill',
  'memory.kind.goal': 'Goal',
  'memory.kind.summary': 'Summary',
  'memory.status.active': 'Active',
  'memory.status.archived': 'Archived',
  'memory.status.superseded': 'Superseded',
  'memory.retention': 'Strength {pct}%',
  'memory.retention_hint': 'How strongly NEO remembers this. Unused memories fade; recalling them makes them stronger.',
  'memory.pinned': 'Pinned',
  'memory.pin': 'Pin (never fades)',
  'memory.unpin': 'Unpin',
  'memory.toggle_pin': 'Toggle pin',
  'memory.sensitive': 'Sensitive',
  'memory.sensitive_hint': 'Only shared with models running on your own devices (unless you allow cloud models).',
  'memory.graph_legend': 'Memory kinds',
  'memory.graph_legend_faded': 'Archived',
  'memory.graph_fallback': 'Memories in the net',
  'memory.graph_aria': 'Memory net with {nodes} memories and {edges} links. Use the arrow keys to move between memories and Enter to open one.',
  'memory.graph_empty': 'Nothing in the net yet. Memories appear here as you chat.',
  'memory.graph_zoom_in': 'Zoom in',
  'memory.graph_zoom_out': 'Zoom out',
  'memory.graph_fit': 'Fit to view',

  // countdown
  'countdown.days': '{n}d',
  'countdown.hours': '{n}h',
  'countdown.minutes': '{n}m',
  'countdown.seconds': '{n}s',
  'countdown.unit_days': 'days',
  'countdown.unit_hours': 'hours',
  'countdown.unit_minutes': 'min',
  'countdown.unit_seconds': 'sec',
  'countdown.done': "Time's up!",
};

const zhCN: Messages = {
  'common.close': '关闭',
  'common.cancel': '取消',
  'common.confirm': '确定',
  'common.are_you_sure': '确定吗？',
  'common.save': '保存',
  'common.edit': '编辑',
  'common.delete': '删除',
  'common.remove': '移除',
  'common.copy': '复制',
  'common.copied': '已复制',
  'common.submit': '提交',
  'common.approve': '允许',
  'common.deny': '拒绝',
  'common.always_allow': '始终允许',
  'common.loading': '加载中…',
  'common.empty': '这里还什么都没有',
  'common.error': '出了点问题',
  'common.retry': '重试',
  'common.search': '搜索',
  'common.filter': '筛选',
  'common.more': '更多',
  'common.back': '返回',
  'common.next': '下一步',
  'common.open': '打开',
  'common.pin': '置顶',
  'common.unpin': '取消置顶',
  'common.archive': '归档',
  'common.done': '完成',
  'common.required': '必填',
  'common.yes': '是',
  'common.no': '否',

  'chat.send': '发送',
  'chat.stop': '停止生成',
  'chat.placeholder': '给 NEO 发消息…',
  'chat.attach_image': '添加图片',
  'chat.image_too_large': '图片不能超过 {mb} MB。',
  'chat.image_unsupported': '仅支持 PNG、JPEG、GIF、WebP 和 AVIF 图片。',
  'chat.image_limit': '最多可以添加 {n} 张图片。',
  'chat.remove_image': '移除 {name}',
  'chat.image_attachment': '附带的图片',
  'chat.thought_process': '思考过程',
  'chat.thinking': '正在思考…',
  'chat.reasoning_hidden': '模型提供方隐藏了推理内容',
  'chat.recalled': '想起了 {n} 条记忆',
  'chat.recalled_one': '想起了 {n} 条记忆',
  'chat.recalled_other': '想起了 {n} 条记忆',
  'chat.recalled_plural': '想起了 {n} 条记忆',
  'chat.tool_running': '进行中…',
  'chat.tool_waiting': '等你确认',
  'chat.tool_done': '已完成',
  'chat.tool_error': '失败',
  'chat.tool_incomplete': '未完成',
  'chat.tool_input': '输入',
  'chat.tool_output': '结果',
  'chat.confirm_title': '{name} 想执行这个操作',
  'chat.confirm_expires': '{time} 后失效',
  'chat.show_details': '查看详情',
  'chat.hide_details': '收起详情',
  'chat.risk.read': '读取数据',
  'chat.risk.write': '修改数据',
  'chat.risk.external': '访问网络',
  'chat.risk.dangerous': '不可撤销',
  'chat.risk_low': '低风险',
  'chat.risk_medium': '中风险',
  'chat.risk_high': '高风险',
  'chat.ui_event': '做出了选择',
  'chat.ui_event_values_other': '{n} 项内容',
  'chat.ui_event_values': '{n} 项内容',
  'chat.error_title': 'NEO 没能完成这条回复',
  'chat.stopped': '已停止',
  'chat.copy_message': '复制消息',
  'chat.sources': '来源',

  'block.copy_code': '复制代码',
  'image.load_from': '从 {host} 加载图片',
  'image.load_many': '从 {host} 加载 {count} 张图片',
  'image.remote_hint': '外部图片可能让对方网站知道你查看了这条内容。',
  'block.copy_done': '已复制',
  'block.show_all': '显示全部',
  'block.show_less': '收起',
  'block.show_all_rows': '显示全部 {n} 行',
  'block.table_rows': '{n} 行',
  'block.invalid': '无法显示这部分内容',
  'block.invalid_detail': '以文本查看',
  'block.form_error_required': '此项为必填',
  'block.form_error_email': '请输入有效的邮箱地址',
  'block.form_error_url': '请输入有效的网址（https://…）',
  'block.form_error_number': '请输入数字',
  'block.form_error_min': '不能小于 {min}',
  'block.form_error_max': '不能大于 {max}',
  'block.form_choose': '请选择…',
  'block.form_sent': '已发送',
  'block.form_failed': '发送失败，请重试。',
  'block.previous': '上一张',
  'block.next': '下一张',
  'block.tasks_title': '任务',
  'block.tasks_progress': '已完成 {done}/{total}',
  'block.tasks_empty': '这里没有任务。',
  'block.memory_title': '记忆',

  'chart.caption': '{kind} 图表',
  'chart.category': '类别',
  'chart.total': '合计',

  'reminder.snooze_10': '10 分钟后提醒',
  'reminder.snooze_60': '1 小时后提醒',
  'reminder.done': '完成',
  'reminder.widget_label': '提醒：{title}',
  'reminder.status.scheduled': '已安排',
  'reminder.status.fired': '到时间了',
  'reminder.status.completed': '已完成',
  'reminder.status.cancelled': '已取消',

  'task.priority_1': '低优先级',
  'task.priority_2': '中优先级',
  'task.priority_3': '高优先级',

  'memory.forget': '忘掉',
  'memory.forget_title': '忘掉这条记忆？',
  'memory.forget_confirm': 'NEO 会永久忘掉这条记忆，无法恢复。',
  'memory.restore': '恢复',
  'memory.resolved_forgotten': '已忘掉',
  'memory.kind.episode': '经历',
  'memory.kind.fact': '事实',
  'memory.kind.entity': '人与物',
  'memory.kind.preference': '偏好',
  'memory.kind.skill': '技能',
  'memory.kind.goal': '目标',
  'memory.kind.summary': '总结',
  'memory.status.active': '有效',
  'memory.status.archived': '已归档',
  'memory.status.superseded': '已被更新',
  'memory.retention': '记忆强度 {pct}%',
  'memory.retention_hint': 'NEO 对这件事记得有多牢。不常用的记忆会慢慢淡去，每次想起都会让它更牢固。',
  'memory.pinned': '已固定',
  'memory.pin': '固定（永不淡忘）',
  'memory.unpin': '取消固定',
  'memory.toggle_pin': '切换固定',
  'memory.sensitive': '敏感',
  'memory.sensitive_hint': '只会提供给运行在你自己设备上的模型（除非你允许云端模型使用）。',
  'memory.graph_legend': '记忆类型',
  'memory.graph_legend_faded': '已归档',
  'memory.graph_fallback': '记忆网络中的内容',
  'memory.graph_aria': '记忆网络，共 {nodes} 条记忆、{edges} 条关联。用方向键在记忆之间移动，按回车打开。',
  'memory.graph_empty': '网络里还没有记忆。随着聊天，记忆会出现在这里。',
  'memory.graph_zoom_in': '放大',
  'memory.graph_zoom_out': '缩小',
  'memory.graph_fit': '适应窗口',

  'countdown.days': '{n}天',
  'countdown.hours': '{n}小时',
  'countdown.minutes': '{n}分',
  'countdown.seconds': '{n}秒',
  'countdown.unit_days': '天',
  'countdown.unit_hours': '时',
  'countdown.unit_minutes': '分',
  'countdown.unit_seconds': '秒',
  'countdown.done': '时间到！',
};

export const dictionaries: Record<'en' | 'zh-CN', Messages> = { en, 'zh-CN': zhCN };

// ── resolution ────────────────────────────────────────────────────────────

export type TranslateFn = (key: string, vars?: Record<string, string | number>) => string;

interface I18nCtx {
  locale: string;
  t: TranslateFn;
}

/** Resolve 'auto' to the browser language. */
export function resolveLocale(locale: string | undefined | null): string {
  if (!locale || locale === 'auto' || locale === 'system') {
    if (typeof navigator !== 'undefined' && navigator.language) return navigator.language;
    return 'en';
  }
  return locale;
}

function matches(dictKey: string, locale: string): boolean {
  const a = dictKey.toLowerCase();
  const b = locale.toLowerCase();
  return a === b || a.split('-')[0] === b.split('-')[0];
}

/** Merge built-ins and app messages for a locale (English is always the base). */
export function buildMessages(locale: string, extra?: Partial<Record<string, Messages>>): Messages {
  const out: Messages = { ...en };
  if (matches('zh-CN', locale)) Object.assign(out, zhCN);
  if (extra) {
    const enExtra = extra.en ?? extra['en-US'];
    if (enExtra) Object.assign(out, enExtra);
    if (!matches('en', locale)) {
      for (const [k, m] of Object.entries(extra)) if (m && matches(k, locale)) Object.assign(out, m);
    }
  }
  return out;
}

function interpolate(msg: string, vars?: Record<string, string | number>): string {
  if (!vars) return msg;
  return msg.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = vars[key];
    return v !== undefined ? String(v) : `{${key}}`;
  });
}

export function createTranslator(locale: string, messages: Messages): TranslateFn {
  let rules: Intl.PluralRules | null = null;
  try {
    rules = new Intl.PluralRules(locale);
  } catch {
    rules = null;
  }
  return (key, vars) => {
    let msg: string | undefined;
    if (vars && typeof vars.n === 'number') {
      const form = rules?.select(vars.n) ?? (vars.n === 1 ? 'one' : 'other');
      msg = messages[`${key}_${form}`] ?? messages[`${key}_other`];
    }
    msg ??= messages[key];
    return msg === undefined ? key : interpolate(msg, vars);
  };
}

const I18nContext = createContext<I18nCtx>({ locale: 'en', t: createTranslator('en', en) });

export function I18nProvider(props: { locale: string; messages?: Partial<Record<string, Messages>>; children: ReactNode }): ReactElement {
  const { locale: rawLocale, messages: extra, children } = props;
  const locale = resolveLocale(rawLocale);
  const ctx = useMemo<I18nCtx>(() => ({ locale, t: createTranslator(locale, buildMessages(locale, extra)) }), [locale, extra]);
  return <I18nContext.Provider value={ctx}>{children}</I18nContext.Provider>;
}

export function useT(): TranslateFn {
  return useContext(I18nContext).t;
}

export function useLocale(): string {
  return useContext(I18nContext).locale;
}
