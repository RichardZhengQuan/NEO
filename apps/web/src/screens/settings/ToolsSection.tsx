/**
 * Settings → Tools: what NEO may do, per tool — run automatically, ask first,
 * or never — grouped by risk.
 */
import type { ReactElement } from 'react';
import type { PermissionLevel, ToolInfo, ToolRisk } from '@neo/protocol';
import { Badge, EmptyState, SegmentedControl, Skeleton, useT, type Tone } from '@neo/ui';
import { useLoader } from '../../hooks/useLoader.js';
import { errorMessage } from '../../lib/errors.js';
import { pushToast } from '../../state/notifications.js';
import { requireClient } from '../../state/session.js';
import { Section } from './common.js';

const RISKS: ToolRisk[] = ['read', 'write', 'external', 'dangerous'];

/**
 * Tool descriptions are written for the model (long, with argument names in
 * backticks). People get the first sentence, without code formatting.
 */
export function summarizeToolDescription(description: string, max = 140): string {
  const plain = description.replace(/`([^`]*)`/g, '$1').replace(/\s+/g, ' ').trim();
  let sentence = plain;
  for (const m of plain.matchAll(/[.!?](?=\s|$)|[。！？]/g)) {
    const candidate = plain.slice(0, m.index + 1);
    if (/\b(e\.g|i\.e|etc|vs|approx)\.$/i.test(candidate)) continue;
    sentence = candidate;
    break;
  }
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

const RISK_TONE: Record<ToolRisk, Tone> = { read: 'info', write: 'accent', external: 'warning', dangerous: 'danger' };

export function ToolsSection(): ReactElement {
  const t = useT();
  const loader = useLoader(async () => (await requireClient().tools.list()).items, []);
  const tools = loader.data;

  const setPermission = async (tool: ToolInfo, permission: PermissionLevel) => {
    loader.setData((prev) => prev?.map((x) => (x.name === tool.name ? { ...x, permission, enabled: permission !== 'deny' } : x)));
    try {
      const updated = await requireClient().tools.setPermission(tool.name, permission);
      loader.setData((prev) => prev?.map((x) => (x.name === tool.name ? updated : x)));
    } catch (err) {
      loader.setData((prev) => prev?.map((x) => (x.name === tool.name ? tool : x)));
      pushToast({ tone: 'error', title: errorMessage(err, t) });
    }
  };

  return (
    <Section title={t('toolsSettings.title')} description={t('toolsSettings.help')}>
      {!tools ? (
        loader.error ? (
          <EmptyState icon="alert-circle" title={t('common.error')} />
        ) : (
          <div style={{ display: 'grid', gap: '0.5rem' }}>
            <Skeleton height={64} />
            <Skeleton height={64} />
          </div>
        )
      ) : (
        RISKS.filter((r) => tools.some((x) => x.risk === r)).map((risk) => (
          <div key={risk}>
            <h3 className="group-title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Badge tone={RISK_TONE[risk]}>{t(`chat.risk.${risk}`)}</Badge>
              <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 500 }}>{t(`toolsSettings.risk_${risk}`)}</span>
            </h3>
            <ul className="row-list" style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {tools
                .filter((x) => x.risk === risk)
                .sort((a, b) => a.title.localeCompare(b.title))
                .map((tool) => (
                  <li key={tool.name} className="row" style={{ flexWrap: 'wrap' }}>
                    <div className="row__main" style={{ minWidth: '12rem' }}>
                      <div className="row__title" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                        {tool.title}
                        {tool.source === 'plugin' && <Badge tone="neutral">{t('toolsSettings.plugin')}</Badge>}
                      </div>
                      <div className="row__meta">
                        <span style={{ fontFamily: 'var(--neo-font-mono)', fontSize: '0.75rem' }}>{tool.name}</span>
                      </div>
                      <div className="neo-help" style={{ marginTop: '0.25rem' }} title={tool.description}>
                        {summarizeToolDescription(tool.description)}
                      </div>
                    </div>
                    <SegmentedControl
                      label={t('toolsSettings.permission_for', { tool: tool.title })}
                      value={tool.permission}
                      onChange={(v) => void setPermission(tool, v)}
                      options={[
                        { value: 'auto', label: t('toolsSettings.auto') },
                        { value: 'confirm', label: t('toolsSettings.confirm') },
                        { value: 'deny', label: t('toolsSettings.deny') },
                      ]}
                    />
                  </li>
                ))}
            </ul>
          </div>
        ))
      )}
    </Section>
  );
}
