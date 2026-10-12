// FormRenderer helpers: defaults, validation, normalisation (pure — the controls are exercised in the UI).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { initialFormValue, isEmptyValue, normalizeFormValue, validateForm } from '../src/components/FormRenderer';
import type { FieldDef } from '../src/types';

const field = (key: string, type: FieldDef['type'], extra: Partial<FieldDef> = {}): FieldDef => ({
  key, label: key, type, required: false, options: [], help: '', placeholder: '', default: null, ...extra,
});

describe('form helpers', () => {
  const fields = [
    field('title', 'text', { required: true }),
    field('size', 'number'),
    field('tags', 'multiselect', { options: ['a', 'b'] }),
    field('steps', 'list', { required: true }),
    field('ok', 'checkbox', { required: true }),
    field('link', 'url'),
    field('team', 'team', { default: 'team_1' }),
  ];

  test('initial values: existing > default > typed empty', () => {
    assert.deepEqual(initialFormValue(fields, { title: 'Kept' }), {
      title: 'Kept', size: '', tags: [], steps: [], ok: false, link: '', team: 'team_1',
    });
  });

  test('validation mirrors the backend rules', () => {
    const errors = validateForm(fields, { title: '  ', size: 'abc', steps: ['', ' '], ok: false, link: 'example.com' });
    assert.deepEqual(errors, { title: 'Required', size: 'Enter a number', steps: 'Required', link: 'Enter a full URL (https://…)' });
    assert.deepEqual(validateForm(fields, { title: 'T', size: 3, steps: ['one'], link: 'https://x.io' }), {});
  });

  test('empty detection and normalisation', () => {
    assert.ok(isEmptyValue(['', '  ']));
    assert.ok(!isEmptyValue(0));
    assert.ok(!isEmptyValue(false));
    assert.deepEqual(normalizeFormValue(fields, { steps: [' a ', '', 'b'], size: '' }), { steps: ['a', 'b'], size: null });
  });
});
