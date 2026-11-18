// Проверка полноты переводов: каждая русская строка интерфейса должна быть в словаре src/i18n.ts.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const cyr = /[\u0400-\u04FF]/;
const root = path.resolve('src');
const dictFile = path.join(root, 'i18n.ts');

// Ключи словаря и проверка, что у каждого есть оба перевода
const dictSf = ts.createSourceFile(dictFile, fs.readFileSync(dictFile, 'utf8'), ts.ScriptTarget.Latest, true);
const keys = new Set();
const problems = [];
const findDict = (n) => {
  if (ts.isVariableDeclaration(n) && n.name.getText() === 'D' && n.initializer && ts.isObjectLiteralExpression(n.initializer)) {
    for (const p of n.initializer.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const key = p.name.text;
      if (keys.has(key)) problems.push(`duplicate key: ${key}`);
      keys.add(key);
      const vals = ts.isArrayLiteralExpression(p.initializer) ? p.initializer.elements.map((e) => e.text) : [];
      if (vals.length !== 2 || vals.some((v) => !v || cyr.test(v))) problems.push(`bad translation for: ${key}`);
      const ph = (s) => (s.match(/\{\w+\}/g) ?? []).sort().join();
      if (vals.some((v) => ph(v ?? '') !== ph(key))) problems.push(`placeholder mismatch for: ${key}`);
    }
    return;
  }
  ts.forEachChild(n, findDict);
};
findDict(dictSf);

// Строки, которые не показываются игроку
const ignore = (file, text) => file.endsWith('xray.ts') && text.includes('gl_FragColor');

const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : []));
for (const file of walk(root)) {
  if (file === dictFile || file.endsWith('LanguageGate.tsx')) continue;
  const sf = ts.createSourceFile(file, fs.readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const at = (n) => `${path.relative('.', file)}:${sf.getLineAndCharacterOfPosition(n.getStart()).line + 1}`;
  const visit = (n) => {
    if (ts.isJsxText(n) && cyr.test(n.text)) problems.push(`${at(n)} untranslated JSX text: ${n.text.trim()}`);
    else if (ts.isTemplateExpression(n) && cyr.test(n.head.text + n.templateSpans.map((s) => s.literal.text).join(''))) problems.push(`${at(n)} untranslated template: ${n.getText()}`);
    else if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && cyr.test(n.text) && !keys.has(n.text) && !ignore(file, n.text)) problems.push(`${at(n)} missing in dictionary: ${n.text}`);
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

if (problems.length) {
  console.error(problems.join('\n'));
  console.error(`\ni18n check failed: ${problems.length} problem(s)`);
  process.exit(1);
}
console.log(`i18n check passed: ${keys.size} strings × 2 languages`);
