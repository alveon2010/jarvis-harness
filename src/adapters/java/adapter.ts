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
import { JavaExtractor } from "./extractor.ts";

const GRADLE = ["build.gradle", "build.gradle.kts", "settings.gradle", "settings.gradle.kts"];

/**
 * JVM adapter (ADR-0021 §2, §8): Gradle or Maven builds of Java, Groovy (Spock) and Kotlin.
 * The graph comes from imports and same-package names (src/adapters/java/extractor.ts), code
 * intelligence from the graph snapshot; commands stay the project's (tools.local), the defaults
 * only say what a plain build would run.
 */
export class JavaAdapter implements LanguageAdapter {
  readonly id = "java";
  readonly languages = ["java", "kotlin", "groovy", "gradle", "maven", "spring"];
  private readonly extractor = new JavaExtractor();
  private readonly snapshotOf: (workspace: string) => Snapshot | undefined;
  private build: "gradle" | "maven" | undefined;

  constructor(snapshotOf: (workspace: string) => Snapshot | undefined = () => undefined) {
    this.snapshotOf = snapshotOf;
  }

  async detect(workspacePath: string): Promise<DetectionResult> {
    const evidence: string[] = [];
    const stacks = new Set<string>();
    const gradle = GRADLE.filter((f) => existsSync(join(workspacePath, f)));
    const maven = existsSync(join(workspacePath, "pom.xml")) ? ["pom.xml"] : [];
    evidence.push(...gradle, ...maven);
    this.build = gradle.length > 0 ? "gradle" : maven.length > 0 ? "maven" : undefined;
    if (this.build) {
      stacks.add("java").add(this.build);
      const text = [...gradle, ...maven]
        .map((f) => {
          try {
            return readFileSync(join(workspacePath, f), "utf8");
          } catch {
            return "";
          }
        })
        .join("\n");
      if (/spring-boot|org\.springframework\.boot/.test(text)) stacks.add("spring");
      if (/kotlin/.test(text)) stacks.add("kotlin");
      if (/groovy|spock/.test(text)) stacks.add("groovy");
    }
    return { detected: evidence.length > 0, stacks: [...stacks].sort(), evidence };
  }

  capabilities(): readonly LanguageCapability[] {
    return ["build", "test", "codeIntelligence", "graph"];
  }

  defaultCommands(): Partial<Record<"build" | "test" | "format" | "lint", string>> {
    if (this.build === "gradle") return { build: "./gradlew classes testClasses -q", test: "./gradlew test" };
    if (this.build === "maven") return { build: "mvn -q test-compile", test: "mvn -q test" };
    return {};
  }

  graphExtractor(): JavaExtractor {
    return this.extractor;
  }

  codeIntelligence(workspacePath: string): CodeIntelligence {
    return snapshotIntelligence(() => this.snapshotOf(workspacePath));
  }
}
