import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const files = [
  resolve(root, "node_modules/foliate-js/paginator.js"),
  resolve(root, "node_modules/foliate-js/fixed-layout.js"),
];

for (const file of files) {
  let source = readFileSync(file, "utf8");
  source = source.replaceAll("'allow-same-origin allow-scripts'", "'allow-same-origin'");
  source = source.replaceAll(
    "// `allow-scripts` is needed for events because of WebKit bug\n",
    "// Book content iframes must not execute embedded scripts.\n",
  );
  writeFileSync(file, source);
}

console.log("foliate-js iframe sandbox patched: allow-scripts removed");
