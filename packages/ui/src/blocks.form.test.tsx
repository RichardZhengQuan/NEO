import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BlockRenderer } from './blocks.js';
import { I18nProvider } from './i18n.js';

afterEach(() => {
  cleanup();
});

describe('form field names', () => {
  it.each(['__proto__', 'constructor', 'toString'])('renders a form with a field named %s without crashing', (name) => {
    render(
      <I18nProvider locale="en">
        <BlockRenderer block={{ type: 'form', fields: [{ name, label: 'Value', kind: 'text' }] }} />
      </I18nProvider>,
    );
    expect(screen.getByRole('textbox')).toBeTruthy();
  });

  it('shows validation error for a required __proto__ field on submit', () => {
    const { container } = render(
      <I18nProvider locale="en">
        <BlockRenderer block={{ type: 'form', title: 'Test form', fields: [{ name: '__proto__', label: 'Value', kind: 'text', required: true }] }} />
      </I18nProvider>,
    );
    fireEvent.submit(container.querySelector('form')!);
    expect(screen.getByRole('alert').textContent).toBe('This field is required');
  });
});
