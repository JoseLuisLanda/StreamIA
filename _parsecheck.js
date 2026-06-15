const ts = require('typescript');
const fs = require('fs');
const files = [
  'src/environments/environment.ts',
  'src/environments/environment.prod.ts',
  'src/app/lib/rag/rag.config.ts',
  'src/app/lib/rag/rag.models.ts',
  'src/app/services/firebase-client.ts',
  'src/app/services/rag-avatar.service.ts',
  'src/app/pages/text-avatar/text-avatar.component.ts',
  'src/app/services/conversation.service.ts',
];
let bad = 0;
for (const f of files) {
  const src = fs.readFileSync(f, 'utf8');
  const sf = ts.createSourceFile(f, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const diags = sf.parseDiagnostics || [];
  if (diags.length) {
    bad++;
    console.log('SYNTAX ERRORS in', f);
    for (const d of diags) {
      const pos = sf.getLineAndCharacterOfPosition(d.start);
      console.log('  '+(pos.line+1)+':'+(pos.character+1), ts.flattenDiagnosticMessageText(d.messageText,'\n'));
    }
  } else {
    console.log('OK  ', f);
  }
}
console.log(bad ? ('\n'+bad+' file(s) with syntax errors') : '\nAll files parse cleanly.');
