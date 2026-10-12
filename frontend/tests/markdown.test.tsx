// Markdown renderer: safety (no script/URL injection) and liveness (no input can stall the parser —
// the renderer this was ported from hung the browser tab on several fence spellings).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import { Markdown, parseChartSpec, safeUrl } from '../src/components/Markdown';

const html = (md: string, size?: 'xs' | 'sm') => renderToStaticMarkup(<Markdown content={md} size={size} />);

describe('Markdown liveness', () => {
  const pathological = [
    '```c++\nint main() {}\n```',
    '``` js\nconst a = 1\n```',
    '````\nnested ``` fence\n````',
    '```py title=example.py\nprint(1)\n```',
    '```unclosed fence\nline',
    '~~~\ntilde fence\n~~~',
    'text before\n```\ncode right after a paragraph line\n```',
    '```inline```',
    '<div>never closed\nstill open',
    '| a | b |\n|---|---|\n| 1 |',
    '- item\n  continuation\n- [x] done\n- [ ] todo',
    '>\n> quote\n>',
    '#\n##',
    '***\n---\n___',
    '1) one\n2) two',
    '|',
    '```',
    '',
  ];
  for (const md of pathological) {
    test(`terminates: ${JSON.stringify(md).slice(0, 40)}`, () => {
      const out = html(md);
      assert.equal(typeof out, 'string');
    });
  }

  test('a long LLM answer renders quickly', () => {
    const chunk = '## Heading\n\nSome **bold** and _italic_ text with `code` and a [link](https://example.com).\n\n- a\n- b\n\n| x | y |\n|---|---|\n| 1 | 2 |\n\n```ts\nconst x = 1;\n```\n\n';
    const started = Date.now();
    html(chunk.repeat(200));
    assert.ok(Date.now() - started < 3000);
  });
});

describe('Markdown rendering', () => {
  test('fences keep their content and any info string', () => {
    const out = html('```c++\nint x = 1 < 2;\n```');
    assert.match(out, /<pre[^>]*><code>int x = 1 &lt; 2;<\/code><\/pre>/);
    assert.match(html('````\na ``` b\n````'), /a ``` b/);
  });

  test('inline styles, tables, task lists', () => {
    const out = html('**b** _i_ `c` ~~s~~\n\n| h1 | h2 |\n|---|---|\n| v1 | v2 |\n\n- [x] shipped\n- [ ] pending');
    assert.match(out, /<strong[^>]*>b<\/strong>/);
    assert.match(out, /<em>i<\/em>/);
    assert.match(out, /<del>s<\/del>/);
    assert.match(out, /<th[^>]*>h1<\/th>/);
    assert.match(out, /<td[^>]*>v2<\/td>/);
    assert.match(out, /type="checkbox"[^>]*checked=""/);
  });

  test('dangerous URLs are neutralised, internal links stay in the tab', () => {
    const out = html('[x](javascript:alert(1)) [y](data:text/html,hi) [p](#/projects/prj_1) [e](https://example.com) [n](//evil.com)');
    assert.ok(!out.includes('javascript:'));
    assert.ok(!out.includes('data:text'));
    assert.ok(!out.includes('//evil.com'));
    assert.match(out, /href="#\/projects\/prj_1"(?![^>]*target)/);
    assert.match(out, /href="https:\/\/example.com" target="_blank" rel="noopener noreferrer"/);
    assert.equal(safeUrl(' JAVASCRIPT:x'), '#');
    assert.equal(safeUrl('/api/x'), '/api/x');
  });

  test('raw HTML is never injected as markup', () => {
    const out = html('<div><script>alert(1)</script><img src=x onerror=alert(1)></div>');
    assert.ok(!out.includes('<script'));
    assert.ok(!out.includes('<img'));
  });

  test('xs size uses the compact scale', () => {
    assert.match(html('hi', 'xs'), /text-xs/);
    assert.match(html('hi'), /text-sm/);
  });
});

describe('```chart blocks', () => {
  test('valid specs render as charts, invalid ones as code', () => {
    const kpi = html('```chart\n{"type":"kpi","title":"Totals","data":[{"label":"Active","value":7},{"label":"Done","value":3}]}\n```');
    assert.match(kpi, /<figure/);
    assert.match(kpi, /Totals/);
    assert.match(kpi, />Active</);
    const broken = html('```chart\n{"type":"pie","data":[]}\n```');
    assert.match(broken, /<pre/);
    assert.match(html('```chart\nnot json\n```'), /not json/);
  });

  test('spec parsing is strict and bounded', () => {
    assert.equal(parseChartSpec('{"type":"bar","data":[]}'), null);
    assert.equal(parseChartSpec('{"type":"line","data":[{"label":"a","value":1}]}'), null);
    const spec = parseChartSpec(JSON.stringify({
      type: 'bar', data: [...Array(30)].map((_, i) => ({ label: `L${i}`, value: i })).concat([{ label: 'bad', value: 'x' as unknown as number }]),
    }));
    assert.equal(spec?.data.length, 20);
    assert.equal(parseChartSpec('{"type":"donut","data":[{"label":"a","value":"4"}]}')?.data[0].value, 4);
  });
});
