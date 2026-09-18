/**
 * buildMessyHank — ONE deliberately messy hank composing every happy-path
 * tricky case from the phase-1 review (issues 01–07) into a single closure,
 * so the kitchen-sink test can assert global invariants over their
 * INTERACTIONS instead of each wrinkle in isolation. Error cases (symlinks,
 * escaping refs, empty copy roots, duplicate keys, reserved paths) abort the
 * closure — most of them at the loader gate now — and therefore live in
 * their own per-case tests; by construction they can never share a fixture
 * with the happy path.
 *
 * STRICT-REFS ERA: every ref is a portable relative path inside the hank
 * dir, and there are no symlinks — the loader rejects anything else, so the
 * old external/absolute/symlink wrinkles are impossible inputs, not tricky
 * ones. What stays tricky in-dir: edge member names (.. prefix, non-ASCII,
 * __proto__), the exec bit, empty directories inside copy trees, one
 * authored string resolving to two different files from two different
 * sentinel-config anchors, and back-refs from nested config dirs.
 *
 * Built programmatically at test runtime (exec bits through git are
 * fine, but the layout is easier to evolve here than as a committed tree).
 *
 * Directory layout (<root> = fresh temp dir; everything under messy-hank/):
 *
 *   <root>/messy-hank/                    (the hank dir)
 *   ├── hank.json
 *   ├── ..templates/                 <--- name STARTS with ".." but is in-dir:
 *   │   └── intro.md                      must stay a plain member (parsing edge)
 *   ├── __proto__/                   <--- bundle path colliding with Object.prototype:
 *   │   └── tricky.md                     null-prototype files/codonInputs maps must hold it
 *   ├── prompts/
 *   │   ├── global.md
 *   │   ├── main.md
 *   │   ├── append.md
 *   │   └── 深い.md                  <--- non-ASCII member name (UTF-8 bytewise sort order)
 *   ├── sa/
 *   │   └── check.json               <--- file sentinel #1; authors "../shared/u.md"
 *   ├── nested/
 *   │   ├── sb/
 *   │   │   └── check.json           <--- file sentinel #2; authors the SAME string
 *   │   │                                 "../shared/u.md" resolving to a DIFFERENT file
 *   │   │                                 (issue 04: distinct (baseDir, raw) ref records)
 *   │   │                                 + systemPromptFile back-ref "../../prompts/append.md"
 *   │   └── shared/
 *   │       └── u.md                 <--- sb's "../shared/u.md" target ("prompt for sb")
 *   ├── shared/
 *   │   └── u.md                     <--- sa's "../shared/u.md" target ("prompt for sa")
 *   ├── sent/
 *   │   ├── check.json               <--- file sentinel #3: userPromptFile "../prompts/main.md"
 *   │   │                                 (up-and-back-down inside the hank) + sideways
 *   │   └── schema.ts                     structuredOutput.schemaFile "schema.ts"
 *   └── tpl/                         <--- rig copy.from tree, in-dir
 *       ├── bin/
 *       │   └── run.sh               <--- exec bit 755: mode is in tree hash, files entry,
 *       │                                 and bundleHash (issue 01)
 *       ├── docs/
 *       │   └── readme.md
 *       └── empty-nested/            <--- empty directory: WARN empty-dir, excluded from
 *                                         bundle + tree hash (NOT the error case — the
 *                                         tree has other files; issue 07 Part A)
 *
 * hank.json highlights: array-form globalSystemPromptFile (parity with
 * loadGlobalSystemPrompt's "\n\n" join), a codon id of "__proto__", decoy
 * outputs (copy.to "workspace/tpl", outputFiles copy "out/**" — never
 * closure refs, issue 06), lint bait (git clone + $HOME command, secret-ish
 * env key), one inline sentinel (refs anchor at the hank dir) beside the
 * three file sentinels (refs anchor at each config's own dir).
 *
 * The kitchen-sink test additionally appends auxiliary members via
 * extendClosure (issue 07 Part B) — "comments.jsonl" (644) and
 * "meta/notes.txt" (755) — which must flow into files and bundleHash.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface MessyHank {
  root: string;
  hankDir: string;
}

function write(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content);
}

function sentinel(id: string, extra: Record<string, unknown>): Record<string, unknown> {
  return {
    id,
    name: `${id} sentinel`,
    trigger: { type: "event", on: ["*"] },
    execution: { strategy: "immediate" },
    model: "anthropic/claude-haiku-4-5",
    ...extra,
  };
}

/** Build the messy hank into a fresh temp root; caller removes `root`. */
export function buildMessyHank(): MessyHank {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "messy-hank-"));
  const hankDir = path.join(root, "messy-hank");

  // ---- prompts and edge-name members
  write(path.join(hankDir, "prompts/global.md"), "global system prompt\n");
  write(path.join(hankDir, "prompts/main.md"), "main prompt\n");
  write(path.join(hankDir, "prompts/append.md"), "appended system prompt\n");
  write(path.join(hankDir, "prompts/深い.md"), "deep prompt (non-ascii name)\n");
  write(path.join(hankDir, "..templates/intro.md"), "intro from ..templates\n");
  write(path.join(hankDir, "__proto__/tricky.md"), "prototype-colliding path\n");

  // ---- same-authored-string, two targets (issue 04): "../shared/u.md"
  // from sa/ and from nested/sb/ resolve to different files, both in-dir.
  write(path.join(hankDir, "shared/u.md"), "prompt for sa\n");
  write(path.join(hankDir, "nested/shared/u.md"), "prompt for sb\n");
  write(
    path.join(hankDir, "sa/check.json"),
    `${JSON.stringify(sentinel("sa-check", { userPromptFile: "../shared/u.md" }), null, 2)}\n`,
  );
  write(
    path.join(hankDir, "nested/sb/check.json"),
    `${JSON.stringify(
      sentinel("sb-check", {
        userPromptFile: "../shared/u.md",
        systemPromptFile: "../../prompts/append.md",
      }),
      null,
      2,
    )}\n`,
  );

  // ---- sentinel with an up-and-back-down prompt ref + sideways schema
  write(
    path.join(hankDir, "sent/check.json"),
    `${JSON.stringify(
      sentinel("sent-check", {
        userPromptFile: "../prompts/main.md",
        structuredOutput: { output: "object", schemaFile: "schema.ts" },
      }),
      null,
      2,
    )}\n`,
  );
  write(path.join(hankDir, "sent/schema.ts"), "export default {};\n");

  // ---- rig copy tree: exec bit + empty dir
  write(path.join(hankDir, "tpl/bin/run.sh"), "#!/bin/sh\necho run\n");
  fs.chmodSync(path.join(hankDir, "tpl/bin/run.sh"), 0o755);
  write(path.join(hankDir, "tpl/docs/readme.md"), "template readme\n");
  fs.mkdirSync(path.join(hankDir, "tpl/empty-nested"));
  // Default-ignored junk (hank-dir.ts): pruned from closure, lock, and
  // bundle — the kitchen-sink member assertions prove it never ships. The
  // node_modules symlink doubles as proof the loader scan prunes too
  // (an un-pruned symlink would fail loadCodonSequence outright).
  write(path.join(hankDir, "tpl/node_modules/pkg/index.js"), "junk\n");
  fs.symlinkSync("../pkg/index.js", path.join(hankDir, "tpl/node_modules/pkg/link.js"));
  write(path.join(hankDir, "tpl/debug.log"), "noise\n");
  write(path.join(hankDir, "tpl/.DS_Store"), "osjunk\n");

  // ---- hank.json
  const hank = {
    meta: { name: "messy-hank", version: "9.9.9" },
    requirements: { env: ["MESSY_TOKEN"] },
    globalSystemPromptFile: ["prompts/global.md", "..templates/intro.md"],
    hank: [
      {
        id: "__proto__",
        name: "Prototype-polluting codon",
        model: "sonnet",
        continuationMode: "fresh",
        promptFile: ["prompts/main.md", "..templates/intro.md"],
        appendSystemPromptFile: "prompts/append.md",
        rigSetup: [
          { type: "copy", copy: { from: "tpl", to: "workspace/tpl" } },
          {
            type: "command",
            command: { run: "git clone https://example.invalid/r.git deps && echo $HOME" },
          },
        ],
        env: { MESSY_API_KEY: "$HOME/secret" },
        sentinels: [
          { sentinelConfig: sentinel("inline-check", { userPromptFile: "prompts/main.md" }) },
          { sentinelConfig: "sa/check.json" },
          { sentinelConfig: "nested/sb/check.json" },
          { sentinelConfig: "sent/check.json" },
        ],
        outputFiles: [
          {
            copy: ["out/**"],
            beforeCopy: [{ type: "command", command: { run: "bun install" } }],
          },
        ],
      },
      {
        type: "loop",
        id: "loop-1",
        name: "Deep loop",
        terminateOn: { type: "iterationLimit", limit: 2 },
        codons: [
          {
            id: "deep",
            name: "Deep codon",
            model: "sonnet",
            continuationMode: "continue-previous",
            promptFile: ["prompts/深い.md", "__proto__/tricky.md"],
          },
        ],
      },
    ],
  };
  write(path.join(hankDir, "hank.json"), `${JSON.stringify(hank, null, 2)}\n`);

  return { root, hankDir };
}
