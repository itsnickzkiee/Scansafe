import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.resolve(here,'..');
const androidDir=path.join(root,'android');

if(!fs.existsSync(androidDir)){
  console.error('Android project not found. Run: npm run android:init');
  process.exit(1);
}

const isWin=process.platform==='win32';
const gradle=isWin?'gradlew.bat':'./gradlew';
const run=spawnSync(gradle,['assembleDebug'],{
  cwd:androidDir,
  stdio:'inherit',
  shell:isWin
});

if(run.status!==0){
  console.error('\nAPK build failed. Open Android Studio with: npm run android:open');
  console.error('Then confirm Android SDK/Gradle setup and build again.');
  process.exit(run.status ?? 1);
}

const apk=path.join(androidDir,'app','build','outputs','apk','debug','app-debug.apk');
if(!fs.existsSync(apk)){
  console.error(`Build finished but APK was not found at: ${apk}`);
  process.exit(1);
}

const dist=path.join(root,'dist');
fs.mkdirSync(dist,{recursive:true});
const target=path.join(dist,'ScanSafe-Evacuee-debug.apk');
fs.copyFileSync(apk,target);
console.log(`\nAPK ready: ${target}`);
