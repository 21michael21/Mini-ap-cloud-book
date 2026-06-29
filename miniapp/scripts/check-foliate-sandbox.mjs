import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  resolve(root, "node_modules/foliate-js/paginator.js"),
  resolve(root, "node_modules/foliate-js/fixed-layout.js"),
];

for (const file of files) {
  const source = readFileSync(file, "utf8");
  if (source.includes("'allow-same-origin allow-scripts'")) {
    throw new Error(`Unsafe foliate-js iframe sandbox still ships allow-scripts in ${file}`);
  }
}

console.log("foliate-js iframe sandbox check passed: no allow-scripts");
