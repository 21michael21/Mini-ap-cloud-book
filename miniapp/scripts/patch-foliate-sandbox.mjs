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

function replaceRequired(source, fileLabel, patchLabel, target, replacement) {
  return replaceAnyRequired(source, fileLabel, patchLabel, [target], replacement);
}

function replaceAnyRequired(source, fileLabel, patchLabel, targets, replacement) {
  let patched = source;
  let replacementCount = 0;
  for (const target of targets) {
    const count = patched.split(target).length - 1;
    if (count > 0) {
      replacementCount += count;
      patched = patched.replaceAll(target, replacement);
    }
  }
  if (replacementCount < 1) {
    if (patched.includes(replacement)) {
      console.log(`foliate-js ${fileLabel} ${patchLabel} already patched`);
      return patched;
    }
    throw new Error(`foliate-js ${fileLabel} ${patchLabel} patch failed: target string not found`);
  }
  console.log(`foliate-js ${fileLabel} ${patchLabel} patched: ${replacementCount} replacement(s)`);
  return patched;
}

function patchVisibleRangeNullGuard(source, fileLabel) {
  const walker = "    const walker = doc.createTreeWalker(doc.body, filter, { acceptNode })";
  const legacyGuard = "    if (!doc?.body) return doc?.createRange?.()\n";
  const currentGuard = "    if (!doc?.body) return document.createRange()\n";
  const replacement = `${currentGuard}${walker}`;
  let patched = source.replaceAll(`${legacyGuard}${walker}`, replacement);
  patched = patched.replaceAll(`${legacyGuard}${replacement}`, replacement);
  let duplicate = `${currentGuard}${replacement}`;
  while (patched.includes(duplicate)) patched = patched.replaceAll(duplicate, replacement);
  if (patched.includes(replacement)) {
    console.log(`foliate-js ${fileLabel} visible range null guard already patched`);
    return patched;
  }
  const replacementCount = patched.split(walker).length - 1;
  if (replacementCount < 1) {
    throw new Error(`foliate-js ${fileLabel} visible range null guard patch failed: target string not found`);
  }
  console.log(`foliate-js ${fileLabel} visible range null guard patched: ${replacementCount} replacement(s)`);
  return patched.replaceAll(walker, replacement);
}

for (const file of files) {
  const source = readFileSync(file.path, "utf8");
  const replacementCount = source.split(unsafeSandbox).length - 1;
  let patched = source;
  if (replacementCount < 1) {
    const safeCount = source.split(safeSandbox).length - 1;
    if (safeCount > 0 && !source.includes("allow-scripts")) {
      console.log(`foliate-js ${file.label} sandbox already patched`);
    } else {
      throw new Error(
        `foliate-js sandbox patch failed for ${file.label}: expected to replace ${unsafeSandbox} at least once`,
      );
    }
  } else {
    patched = patched.replaceAll(unsafeSandbox, safeSandbox);
    patched = patched.replaceAll(
      "// `allow-scripts` is needed for events because of WebKit bug\n",
      "// Book content iframes must not execute embedded scripts.\n",
    );
    console.log(`foliate-js ${file.label} sandbox patched: ${replacementCount} replacement(s)`);
  }

  if (file.label === "paginator") {
    patched = replaceRequired(
      patched,
      file.label,
      "style null guard",
      "const setStylesImportant = (el, styles) => {\n    const { style } = el\n    for (const [k, v] of Object.entries(styles)) style.setProperty(k, v, 'important')\n}",
      "const setStylesImportant = (el, styles) => {\n    if (!el?.style) return\n    const { style } = el\n    for (const [k, v] of Object.entries(styles)) style.setProperty(k, v, 'important')\n}",
    );
    patched = replaceRequired(
      patched,
      file.label,
      "view destroy guard",
      "    destroy() {\n        if (this.document) this.#observer.unobserve(this.document.body)\n    }",
      "    destroy() {\n        if (this.document?.body) this.#observer.unobserve(this.document.body)\n    }",
    );
    patched = replaceRequired(
      patched,
      file.label,
      "image sizing null guard",
      "    setImageSize() {\n        const { width, height, margin } = this.#layout\n        const vertical = this.#vertical\n        const doc = this.document\n        for (const el of doc.body.querySelectorAll('img, svg, video')) {",
      "    setImageSize() {\n        const { width, height, margin } = this.#layout\n        const vertical = this.#vertical\n        const doc = this.document\n        if (!doc?.body) return\n        for (const el of doc.body.querySelectorAll('img, svg, video')) {",
    );
    patched = patchVisibleRangeNullGuard(patched, file.label);
    patched = replaceRequired(
      patched,
      file.label,
      "background document element guard",
      "        const doc = this.#view?.document\n        if (!doc) return\n        const htmlStyle = doc.defaultView.getComputedStyle(doc.documentElement)",
      "        const doc = this.#view?.document\n        if (!doc?.documentElement) return\n        const htmlStyle = doc.defaultView.getComputedStyle(doc.documentElement)",
    );
    patched = replaceRequired(
      patched,
      file.label,
      "expand document element guard",
      "    expand() {\n        const { documentElement } = this.document\n        if (this.#column) {",
      "    expand() {\n        const documentElement = this.document?.documentElement\n        if (!documentElement) return\n        if (this.#column) {",
    );
    patched = replaceRequired(
      patched,
      file.label,
      "paginator destroy guard",
      "    destroy() {\n        this.#observer.unobserve(this)\n        this.#view.destroy()\n        this.#view = null\n        this.sections[this.#index]?.unload?.()\n        this.#mediaQuery.removeEventListener('change', this.#mediaQueryListener)\n    }",
      "    destroy() {\n        this.#observer.unobserve(this)\n        this.#view?.destroy?.()\n        this.#view = null\n        this.sections[this.#index]?.unload?.()\n        this.#mediaQuery.removeEventListener('change', this.#mediaQueryListener)\n    }",
    );
  }

  writeFileSync(file.path, patched);
}

{
  const viewPath = resolve(root, "node_modules/foliate-js/view.js");
  const source = readFileSync(viewPath, "utf8");
  const patched = replaceAnyRequired(
    source,
    "view",
    "relocate CFI guard",
    [
      "        const cfi = this.getCFI(index, range)",
      "        let cfi = null\n        try {\n            cfi = this.getCFI(index, range)\n        }\n        catch (e) {\n            console.warn(e)\n        }",
    ],
    "        let cfi = null\n        try {\n            cfi = this.getCFI(index, range)\n        }\n        catch {\n        }",
  );
  writeFileSync(viewPath, patched);
}

console.log("foliate-js iframe sandbox patched: allow-scripts removed");
