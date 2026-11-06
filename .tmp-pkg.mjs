import { pathToFileURL } from 'node:url';
const asar = await import(pathToFileURL('E:/plugins/dsh-rich-render/node_modules/@electron/asar/lib/asar.js').href);
const archive = 'C:/Users/xyxy1/AppData/Local/Programs/DeepSeek Harness/resources/app.asar';
for (const p of ['dsh\\package.json', 'package.json']) {
  try { const s = asar.extractFile(archive, p).toString('utf8'); console.log('### ' + p); console.log(s.slice(0, 2000)); break; }
  catch (e) { console.log('FAIL', p, e.message.slice(0, 60)); }
}
