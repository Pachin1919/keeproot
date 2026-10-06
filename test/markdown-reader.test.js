import assert from 'node:assert/strict';
import test from 'node:test';
import { renderResourceReaderView } from '../src/ui/views/resource-reader-view.js';
const render = text => renderResourceReaderView({project:{id:'P-md'},reader:{kind:'markdown',text,name:'说明.md'},links:[]});
test('Markdown reader supports tables, nested lists, quotations and emphasis without loading content', () => {
 const html=render('# 标题\n\n| 项目 | 数值 |\n| --- | ---: |\n| 研究 | 85 |\n\n- 第一层\n  - 第二层 **重点**\n\n> 引用 *内容*\n\n~~已过期~~');
 assert.match(html,/<table>/);assert.match(html,/<th[^>]*>数值<\/th>/);assert.match(html,/<td[^>]*>85<\/td>/);
 assert.match(html,/<li>第一层\s*<ul>/);assert.match(html,/<strong>重点<\/strong>/);assert.match(html,/<blockquote>/);assert.match(html,/<em>内容<\/em>/);assert.match(html,/<s>已过期<\/s>/);
});
test('Markdown parser never turns disguised URLs or images into executable or automatic requests', () => {
 const html=render('[坏](&#74;avascript:alert(1)) [本地](file:///C:/secret) [协议](//evil.test/path)\n\n![远程](https://evil.test/img) ![内联](data:image/png;base64,AAAA)\n\n<script>alert(1)</script>\n\n```md\n[[a|别名]] [链接](https://example.test)\n```');
 const body=html.match(/<article[^>]*>([\s\S]*?)<\/article>/)[1];
 assert.doesNotMatch(body,/<script|<img|href="(?:javascript:|file:|\/\/|data:)/i);assert.match(body,/&lt;script&gt;/);assert.match(body,/<code[^>]*>\[\[a\|别名\]\]/);
});
