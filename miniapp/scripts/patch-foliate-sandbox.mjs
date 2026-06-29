import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const unsafeSandbox = "'allow-same-origin allow-scripts'";
const safeSandbox = "'allow-same-origin'";
const files = [
  {
    label: "paginator",
    path: resolve(root, "node_modules/foliate-js/paginator.js"),
  },
  {
    label: "fixed-layout",
    path: resolve(root, "node_modules/foliate-js/fixed-layout.js"),
  },
];

for (const file of files) {
  const source = readFileSync(file.path, "utf8");
  const replacementCount = source.split(unsafeSandbox).length - 1;
  if (replacementCount < 1) {
    const safeCount = source.split(safeSandbox).length - 1;
    if (safeCount > 0 && !source.includes("allow-scripts")) {
      console.log(`foliate-js ${file.label} sandbox already patched`);
      continue;
    }
    throw new Error(
      `foliate-js sandbox patch failed for ${file.label}: expected to replace ${unsafeSandbox} at least once`,
    );
  }

  let patched = source.replaceAll(unsafeSandbox, safeSandbox);
  patched = patched.replaceAll(
    "// `allow-scripts` is needed for events because of WebKit bug\n",
    "// Book content iframes must not execute embedded scripts.\n",
  );
  writeFileSync(file.path, patched);
  console.log(`foliate-js ${file.label} sandbox patched: ${replacementCount} replacement(s)`);
}

console.log("foliate-js iframe sandbox patched: allow-scripts removed");
