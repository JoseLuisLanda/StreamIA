const fs=require('fs');
const s=fs.readFileSync('src/app/lib/rag/rag.config.ts','utf8');
const lines=s.split('\n');
const L=lines[54]; // line 55
console.log('LEN', L.length);
let out=[];
for(let i=0;i<L.length;i++){const c=L.charCodeAt(i); out.push(c>126||c<32? `[${i+1}:U+${c.toString(16)}]`:L[i]);}
console.log(out.join(''));
