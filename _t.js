const ts = require('typescript');
function check(name, src){
  const sf = ts.createSourceFile(name, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const d = sf.parseDiagnostics||[];
  console.log(name, d.length? 'ERR' : 'ok', d.map(x=>ts.flattenDiagnosticMessageText(x.messageText,' ')).join('|'));
}
check('arrow.ts', '/** a → b */\nexport const x=1;\n');
check('emdash.ts', '/** a — b */\nexport const x=1;\n');
check('regex.ts', "export const f=(s)=>s.replace(/\\/+$/, '');\n");
check('tmpl.ts', 'export const g=(p)=>`/${p}`;\n');
check('ascii.ts', '/** plain */\nexport const y=1;\n');
