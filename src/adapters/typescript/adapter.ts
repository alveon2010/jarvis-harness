import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  CodeIntelligence,
  DetectionResult,
  LanguageAdapter,
  LanguageCapability,
} from "../../core/capabilities/contracts.ts";
import type { Snapshot } from "../../knowledge/graph/store.ts";
import { snapshotIntelligence } from "../snapshotIntelligence.ts";
import { TypeScriptExtractor } from "./extractor.ts";

/**
 * TypeScript / JavaScript adapter (ADR-0021 §2, §8): detection, default commands, the ts-morph
 * extractor and a code-intelligence port answered from the latest graph snapshot. In-process —
 * the first and most mature capability pack.
 */
export class TypeScriptAdapter implements LanguageAdapter {
  readonly id = "typescript";
  readonly languages = ["typescript", "javascript", "node", "react"];
  private readonly extractor = new TypeScriptExtractor();
  private readonly snapshotOf: (workspace: string) => Snapshot | undefined;

  constructor(snapshotOf: (workspace: string) => Snapshot | undefined = () => undefined) {
    this.snapshotOf = snapshotOf;
  }

  async detect(workspacePath: string): Promise<DetectionResult> {
    const evidence: string[] = [];
    const stacks = new Set<string>();
    if (existsSync(join(workspacePath, "tsconfig.json"))) {
      evidence.push("tsconfig.json");
      stacks.add("typescript");
    }
    if (existsSync(join(workspacePath, "package.json"))) {
      evidence.push("package.json");
      stacks.add("node");
      try {
        const pkg = JSON.parse(readFileSync(join(workspacePath, "package.json"), "utf8")) as {
          dependencies?: Record<string, string>;
          devDependencies?: Record<string, string>;
        };
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };
        if (deps.typescript) stacks.add("typescript");
        if (deps.react) stacks.add("react");
      } catch {
        // unreadable package.json
      }
    }
    return { detected: evidence.length > 0, stacks: [...stacks].sort(), evidence };
  }

  capabilities(): readonly LanguageCapability[] {
    return ["build", "test", "lint", "codeIntelligence", "graph"];
  }

  defaultCommands(): Partial<Record<"build" | "test" | "format" | "lint", string>> {
    return {};
  }

  graphExtractor(): TypeScriptExtractor {
    return this.extractor;
  }

  codeIntelligence(workspacePath: string): CodeIntelligence {
    return snapshotIntelligence(() => this.snapshotOf(workspacePath));
  }
}
