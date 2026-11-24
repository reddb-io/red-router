// Copy the legacy translator with its type-only import erased and its relative
// imports made absolute, so Node's type stripping can load it unmodified otherwise.
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";
const [source, target] = process.argv.slice(2);
let text = readFileSync(source, "utf8");
text = text.replace(/^\s*JsonRecord,\r?\n/m, "");
text = text.replace(/from "(\.[^"]+)"/g, (_, rel) => `from "${pathToFileURL(resolve(dirname(source), rel)).href}"`);
text = text.replace(/\bJsonRecord\b/g, "Record<string, unknown>");
writeFileSync(target, text);
console.log("copied");
