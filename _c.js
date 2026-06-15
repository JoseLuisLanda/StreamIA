const fs=require('fs');
function ln(f,n){const L=fs.readFileSync(f,'utf8').split('\n');console.log(f+':'+n+' (len '+(L[n-1]||'').length+') = '+JSON.stringify(L[n-1]));}
ln('src/app/services/conversation.service.ts',298);
ln('src/app/services/conversation.service.ts',297);
ln('src/app/pages/text-avatar/text-avatar.component.ts',933);
ln('src/app/pages/text-avatar/text-avatar.component.ts',932);
