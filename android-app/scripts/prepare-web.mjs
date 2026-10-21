import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const androidRoot = path.resolve(here, '..');
const projectRoot = path.resolve(androidRoot, '..');
const www = path.join(androidRoot, 'www');

const userPages = [
  'index.html',
  'user-portal.html',
  'my-information.html',
  'user-room.html',
  'user-notifications.html',
  'user-messages.html',
  'profile.html'
];

function copyFileRequired(src, dst){
  if(!fs.existsSync(src)){
    throw new Error(`Missing required ScanSafe file: ${src}`);
  }
  fs.mkdirSync(path.dirname(dst), {recursive:true});
  fs.copyFileSync(src, dst);
}

function copyDir(src, dst){
  if(!fs.existsSync(src)) throw new Error(`Missing assets directory: ${src}`);
  fs.mkdirSync(dst, {recursive:true});
  for(const entry of fs.readdirSync(src, {withFileTypes:true})){
    const s=path.join(src, entry.name);
    const d=path.join(dst, entry.name);
    if(entry.isDirectory()) copyDir(s,d);
    else fs.copyFileSync(s,d);
  }
}

fs.rmSync(www, {recursive:true, force:true});
fs.mkdirSync(www, {recursive:true});

for(const file of userPages){
  copyFileRequired(path.join(projectRoot,file), path.join(www,file));
}
copyDir(path.join(projectRoot,'assets'), path.join(www,'assets'));

for(const optional of ['manifest.webmanifest']){
  const src=path.join(projectRoot,optional);
  if(fs.existsSync(src)) fs.copyFileSync(src,path.join(www,optional));
}

// Make the bundled Android app evacuee-only without changing the web deployment.
const bridgePath=path.join(www,'assets','supabase-bridge.js');
if(fs.existsSync(bridgePath)){
  let code=fs.readFileSync(bridgePath,'utf8');

  const marker=`    localStorage.setItem('scanSafeLoginRole', profile.role==='evacuee'?'user':profile.role);`;
  if(code.includes(marker) && !code.includes('This Android app is for evacuees only')){
    const guard=`    if(profile.role!=='evacuee'){
      await sb.auth.signOut();
      uiError('This Android app is for evacuees only. Please use the ScanSafe web portal for administrator or staff access.');
      return;
    }

`;
    code=code.replace(marker,guard+marker);
  }

  // Capacitor native builds should not register the PWA service worker.
  code=code.replace(
    "if('serviceWorker' in navigator){",
    "if(!(window.Capacitor && typeof window.Capacitor.isNativePlatform==='function' && window.Capacitor.isNativePlatform()) && 'serviceWorker' in navigator){"
  );

  fs.writeFileSync(bridgePath,code,'utf8');
}

// Do not bundle a service worker in the native app.
const sw=path.join(www,'service-worker.js');
if(fs.existsSync(sw)) fs.rmSync(sw);

console.log(`Prepared ScanSafe evacuee web bundle at ${www}`);
console.log('Included pages:', userPages.join(', '));
