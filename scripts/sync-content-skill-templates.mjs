#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const outputPath = join(
  projectRoot,
  "packages/content-engine/src/channel-template-snapshots.json",
);

const definitions = {
  official_site: {
    skillName: "gd-market-guanwang-auto",
    versionFlag: "--website-version",
    files: [
      "SKILL.md",
      "references/workflow-contract.md",
      "references/writing-system.md",
      "references/quality-gates.md",
      "references/website-layout.md",
      "references/image-policy.md",
      "references/publishing-contract.md",
    ],
    writingFiles: [
      "SKILL.md",
      "references/writing-system.md",
      "references/quality-gates.md",
    ],
  },
  wechat: {
    skillName: "gd-market-gzh-auto",
    versionFlag: "--wechat-version",
    files: [
      "SKILL.md",
      "references/workflow-contract.md",
      "references/writing-system.md",
      "references/quality-gates.md",
      "references/geekdance-brand-layout.md",
      "references/image-policy.md",
      "references/publishing-contract.md",
    ],
    writingFiles: [
      "SKILL.md",
      "references/writing-system.md",
      "references/quality-gates.md",
    ],
  },
};

function flagValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function validateVersion(version, flag) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? ""))
    throw new Error(`${flag} 必须使用 x.y.z 版本号`);
  return version;
}

async function currentSnapshots() {
  try {
    return JSON.parse(await readFile(outputPath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

const previous = await currentSnapshots();
const templates = {};

for (const [channel, definition] of Object.entries(definitions)) {
  const skillRoot = join(
    process.env.CODEX_HOME || join(homedir(), ".codex"),
    "skills",
    definition.skillName,
  );
  const contents = await Promise.all(
    definition.files.map(async (relativePath) => ({
      relativePath,
      content: (await readFile(join(skillRoot, relativePath), "utf8")).trim(),
    })),
  );
  const instructions = contents
    .map(
      ({ relativePath, content }) =>
        `===== ${definition.skillName}/${relativePath} =====\n${content}`,
    )
    .join("\n\n");
  const contentByPath = new Map(
    contents.map(({ relativePath, content }) => [relativePath, content]),
  );
  const writingInstructions = definition.writingFiles
    .map(
      (relativePath) =>
        `===== ${definition.skillName}/${relativePath} =====\n${contentByPath.get(relativePath)}`,
    )
    .join("\n\n");
  const sourceHash = createHash("sha256").update(instructions).digest("hex");
  const previousTemplate = previous?.templates?.[channel];
  const requestedVersion = flagValue(definition.versionFlag);
  if (
    previousTemplate &&
    previousTemplate.sourceHash !== sourceHash &&
    !requestedVersion
  )
    throw new Error(
      `${definition.skillName} 已变化，请用 ${definition.versionFlag} x.y.z 明确新版本`,
    );
  const version = validateVersion(
    requestedVersion || previousTemplate?.version || "1.0.0",
    definition.versionFlag,
  );
  if (
    previousTemplate &&
    previousTemplate.sourceHash !== sourceHash &&
    previousTemplate.version === version
  )
    throw new Error(
      `${definition.skillName} 规则已变化，模板版本必须高于 ${version}`,
    );
  templates[channel] = {
    skillName: definition.skillName,
    version,
    sourceHash,
    sourceFiles: definition.files,
    writingInstructions,
    instructions,
  };
}

await writeFile(
  outputPath,
  `${JSON.stringify({ schemaVersion: 1, templates }, null, 2)}\n`,
);
console.log(`已同步渠道 Skill 模板：${outputPath}`);
for (const [channel, template] of Object.entries(templates))
  console.log(
    `${channel}: ${template.skillName}@${template.version} (${template.sourceHash.slice(0, 12)})`,
  );
