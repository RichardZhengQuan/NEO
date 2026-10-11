/**
 * A list of short strings edited as chips: type and press Enter (or comma) to
 * add, × to remove, plus optional one-tap suggestions.
 */
import { useId, useState, type ReactElement } from 'react';
import { Chip, Icon, useT } from '@neo/ui';

export function ChipInput(props: {
  label: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  suggestions?: string[];
  help?: string;
  max?: number;
  maxLength?: number;
}): ReactElement {
  const t = useT();
  const id = useId();
  const { label, values, onChange, placeholder, suggestions = [], help, max = 30, maxLength = 60 } = props;
  const [draft, setDraft] = useState('');
  const lower = new Set(values.map((v) => v.toLowerCase()));

  const add = (raw: string) => {
    const value = raw.trim().slice(0, maxLength);
    if (!value || lower.has(value.toLowerCase()) || values.length >= max) return;
    onChange([...values, value]);
  };

  return (
    <div className="neo-field">
      <label htmlFor={id} className="neo-label">
        {label}
      </label>
      {values.length > 0 && (
        <div className="neo-tags" role="list">
          {values.map((v) => (
            <span role="listitem" key={v}>
              <Chip size="sm" onRemove={() => onChange(values.filter((x) => x !== v))} removeLabel={t('common.remove_item', { item: v })}>
                {v}
              </Chip>
            </span>
          ))}
        </div>
      )}
      <div className="neo-input-group">
        <input
          id={id}
          className="neo-input"
          value={draft}
          placeholder={placeholder}
          maxLength={maxLength}
          disabled={values.length >= max}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if ((e.key === 'Enter' || e.key === ',') && draft.trim()) {
              e.preventDefault();
              add(draft);
              setDraft('');
            } else if (e.key === 'Backspace' && !draft && values.length) {
              onChange(values.slice(0, -1));
            }
          }}
          onBlur={() => {
            if (draft.trim()) {
              add(draft);
              setDraft('');
            }
          }}
        />
        {draft.trim() && (
          <span className="neo-input-addon">
            <button
              type="button"
              className="neo-btn neo-btn--ghost neo-btn--icon neo-btn--sm"
              aria-label={t('common.add')}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => {
                add(draft);
                setDraft('');
              }}
            >
              <Icon name="plus" size={15} />
            </button>
          </span>
        )}
      </div>
      {suggestions.filter((s) => !lower.has(s.toLowerCase())).length > 0 && (
        <div className="neo-tags" aria-label={t('common.suggestions')}>
          {suggestions
            .filter((s) => !lower.has(s.toLowerCase()))
            .map((s) => (
              <Chip key={s} size="sm" icon="plus" onClick={() => add(s)}>
                {s}
              </Chip>
            ))}
        </div>
      )}
      {help && (
        <p className="neo-help" style={{ margin: 0 }}>
          {help}
        </p>
      )}
    </div>
  );
}
