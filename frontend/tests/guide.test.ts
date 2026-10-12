// The user guide is data: every deep link must keep landing on a real screen, ids stay unique,
// and search finds what a user would type.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { NAV_ITEMS } from '../src/lib/nav';
import { parseRoute, paths } from '../src/lib/router';
import { GUIDE, GUIDE_GROUPS, searchGuide } from '../src/views/guide/content';

describe('user guide', () => {
  test('routes', () => {
    assert.equal(parseRoute('#/guide').name, 'guide');
    const r = parseRoute(`#${paths.guide('inbox')}`);
    assert.equal(r.name, 'guide');
    assert.equal(r.params.section, 'inbox');
  });

  test('has a dedicated menu entry with a go-to shortcut', () => {
    const item = NAV_ITEMS.find((n) => n.path === paths.guide());
    assert.ok(item, 'User Guide is in the navigation');
    assert.equal(item.section, 'bottom');
    assert.equal(item.shortcut, 'u');
    assert.equal(NAV_ITEMS.filter((n) => n.shortcut === 'u').length, 1);
  });

  test('sections are unique, grouped and non-empty', () => {
    const ids = GUIDE.map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const s of GUIDE) {
      assert.ok(GUIDE_GROUPS.includes(s.group), `${s.id} group`);
      assert.ok(s.title && s.summary && s.body.trim().length > 200, `${s.id} content`);
    }
  });

  test('every link resolves to a real screen', () => {
    for (const s of GUIDE) {
      for (const l of s.links ?? []) {
        const route = parseRoute(`#${l.to}`);
        assert.notEqual(route.name, 'not-found', `${s.id} → ${l.to}`);
        if (route.name === 'guide') assert.ok(GUIDE.some((g) => g.id === route.params.section), `${s.id} → ${l.to}`);
      }
    }
  });

  test('search ranks title hits first and requires every word', () => {
    assert.equal(searchGuide('')[0], undefined);
    assert.equal(searchGuide('keyboard shortcuts')[0].id, 'shortcuts');
    assert.ok(searchGuide('gherkin').length > 0);
    assert.ok(searchGuide('windows reload').some((s) => s.id === 'windows'));
    assert.equal(searchGuide('zzzz-nothing').length, 0);
  });
});
