import fs from 'node:fs';

const files = [
  new URL('./styles/tokens.css', import.meta.url),
  new URL('./styles/layout.css', import.meta.url),
  new URL('./styles/components.css', import.meta.url),
  new URL('./styles/round-timeline.css', import.meta.url),
];

export function uiStyles() {
  return files.map((file) => fs.readFileSync(file, 'utf8')).join('\n');
}
