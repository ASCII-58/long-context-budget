// 只读地把 app.asar 里的某个文件抽出来看，用于核对桌面端协议处理器。
// 用法：node scripts/read-asar-file.mjs <asar 路径> <包内相对路径>
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const asar = await import(
  pathToFileURL('E:/plugins/dsh-rich-render/node_modules/@electron/asar/lib/asar.js').href
);

const [, , archive, entry] = process.argv;
if (!archive || !entry) {
  console.error('usage: node read-asar-file.mjs <archive> <entry>');
  process.exit(2);
}
const buffer = asar.extractFile(archive, entry);
process.stdout.write(buffer.toString('utf8'));
