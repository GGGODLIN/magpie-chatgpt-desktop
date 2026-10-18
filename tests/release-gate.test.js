import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

describe("Ticket 03 — 公開發布閘門與敏感資訊掃描", () => {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "..",
  );

  const buildForbiddenPatterns = (extraTerms = []) => {
    const patterns = [
      {
        label: "local macOS user home path prefix",
        pattern: new RegExp(["", "Users", ""].join("/"), "i"),
      },
      {
        label: "private gmail address",
        pattern: new RegExp(["@", "gmail", "\\.com"].join(""), "i"),
      },
    ];

    const runtimeUser = os.userInfo().username?.trim() ?? "";
    if (runtimeUser.length >= 3) {
      const escapedUser = runtimeUser.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      patterns.push({
        label: "current OS username",
        pattern: new RegExp(escapedUser, "i"),
      });
    }

    const envTerms = String(process.env.RELEASE_GATE_SENSITIVE_TERMS ?? "")
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);

    for (const term of [...envTerms, ...extraTerms]) {
      const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      patterns.push({
        label: `custom term (${term})`,
        pattern: new RegExp(escaped, "i"),
      });
    }
    return patterns;
  };

  test("所有追蹤檔案與完整 git 提交歷史對個人敏感字、私人信箱與本機絕對路徑皆為 0 命中", () => {
    const forbiddenPatterns = buildForbiddenPatterns();
    const trackedOutput = execFileSync("git", ["ls-files"], {
      cwd: repoRoot,
      encoding: "utf8",
    });
    const trackedSet = new Set(
      trackedOutput
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean),
    );
    trackedSet.add("tests/release-gate.test.js");

    const fileHits = [];
    for (const relPath of [...trackedSet].sort()) {
      const absPath = path.join(repoRoot, relPath);
      if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) continue;
      const content = fs.readFileSync(absPath, "utf8");
      for (const rule of forbiddenPatterns) {
        if (rule.pattern.test(content)) {
          fileHits.push(`${relPath}: ${rule.label}`);
        }
      }
    }
    expect(fileHits).toEqual([]);

    const logOutput = execFileSync(
      "git",
      ["log", "--all", "--format=%H %an <%ae>%n%B"],
      {
        cwd: repoRoot,
        encoding: "utf8",
      },
    );
    expect(logOutput.trim().length).toBeGreaterThan(0);

    const historyHits = [];
    for (const rule of forbiddenPatterns) {
      if (rule.pattern.test(logOutput)) {
        historyHits.push(rule.label);
      }
    }
    expect(historyHits).toEqual([]);

    const syntheticCheck = buildForbiddenPatterns(["synthetic-secret-token"]);
    const syntheticSample = [
      ["", "Users", "example_person"].join("/"),
      ["demo", "gmail.com"].join("@"),
      "synthetic-secret-token",
    ].join(" ");
    const detectedLabels = syntheticCheck
      .filter((rule) => rule.pattern.test(syntheticSample))
      .map((rule) => rule.label);
    expect(detectedLabels).toContain("local macOS user home path prefix");
    expect(detectedLabels).toContain("private gmail address");
    expect(detectedLabels).toContain("custom term (synthetic-secret-token)");
  });
});
