const fs=require('fs');
const files=['src/app/lib/rag/rag.config.ts','src/app/lib/rag/rag.models.ts','src/app/services/rag-avatar.service.ts','src/app/services/firebase-client.ts','src/environments/environment.ts','src/environments/environment.prod.ts'];
for(const f of files){
  const lines=fs.readFileSync(f,'utf8').split('\n');
  let hits=[];
  lines.forEach((L,i)=>{ if(/[^\x00-\x7F]/.test(L)) hits.push((i+1)+': '+JSON.stringify(L)); });
  console.log('=== '+f+' (non-ascii lines: '+hits.length+') ===');
  hits.forEach(h=>console.log('  '+h));
}
