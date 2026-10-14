import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";
import { detectStackScopes, detectStacks } from "../capabilities/detector.ts";
import type { GraphEdge, GraphNode } from "../core/capabilities/contracts.ts";
import { git } from "../tools/local/exec.ts";

/**
 * `jarvis onboard` scan (no model involved): everything about a repository that can be read off the
 * tree, the manifests and the git history. Facts only — each one cites the file it came from, so a
 * human (or a later agent pass) can check it.
 */
export interface ModuleFacts {
  readonly path: string;
  readonly role: "source" | "tests" | "docs" | "config" | "other";
  readonly files: number;
  readonly lines: number;
  readonly languages: string[];
  readonly dependsOn: string[];
  readonly usedBy: string[];
}

export interface CommandFact {
  readonly name: "tests" | "typecheck" | "lint" | "build";
  readonly command: string;
  readonly source: string;
}

export interface ScanReport {
  readonly root: string;
  readonly stacks: string[];
  readonly stackScopes: Record<string, string[]>;
  readonly packageManager?: string;
  readonly commands: CommandFact[];
  readonly modules: ModuleFacts[];
  readonly entryPoints: string[];
  readonly docs: Array<{
    path: string;
    kind: "readme" | "adr" | "docs" | "contributing" | "changelog" | "architecture";
  }>;
  readonly tooling: {
    linters: Array<{ tool: string; file: string }>;
    ci: string[];
    testFrameworks: string[];
  };
  readonly tests: { files: number; layout: "colocated" | "separate-dir" | "mixed" | "none"; dirs: string[] };
  readonly commits: { sampled: number; conventional: number; ticketPrefix: number; scopes: string[] };
  readonly hotspots: Array<{ file: string; commits: number }>;
  readonly sensitivePaths: string[];
  readonly files: number;
  readonly lines: number;
  readonly graph: { available: boolean; nodes?: number; edges?: number; reason?: string };
  /** A JVM tree's tests and libraries, from the graph (`jvmFactsOf`). */
  readonly jvm?: JvmFacts;
}

export interface JvmFacts {
  /** Per test source root: the runnable tests, their naming and the frameworks they import. */
  readonly testRoots: Array<{ root: string; tests: number; suffixes: string[]; frameworks: string[] }>;
  /** Test code other tests extend or use (base classes, fixtures, configurations), most used first. */
  readonly shared: Array<{ file: string; tests: number }>;
  /** Libraries the main code imports, by name. */
  readonly libraries: string[];
}

const CODE_EXT: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".cs": "csharp",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".groovy": "groovy",
  ".scala": "scala",
  ".rb": "ruby",
  ".php": "php",
  ".swift": "swift",
  ".vue": "vue",
};
const SKIP_FILE =
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Cargo\.lock|poetry\.lock|go\.sum)$/;
const SKIP_DIR = /(^|\/)(node_modules|dist|build|coverage|\.jarvis|vendor)\//;
const MODULE_ROOTS = new Set(["packages", "apps", "services", "libs", "modules", "projects", "plugins"]);
const TEST_DIRS = new Set(["test", "tests", "__tests__", "e2e", "spec", "specs"]);
const DOC_DIRS = new Set(["docs", "doc", "documentation"]);
const TEST_FILE = /(\.|_)(test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$|Tests?\.cs$|_test\.go$/;

export function rolOf(path: string, first: string): ModuleFacts["role"] {
  if (TEST_DIRS.has(first) || TEST_SOURCE_SET.test(path)) return "tests";
  if (/(^|\/)src\/[^/]+\/resources$/.test(path)) return "config";
  if (/(^|\/)src\/docs(\/|$)/.test(path)) return "docs";
  if (DOC_DIRS.has(first)) return "docs";
  if (first.startsWith(".") || first === "scripts" || first === "tools" || first === "gradle")
    return "config";
  return path === "(root)" ? "other" : "source";
}

/** An external package by name — `pkg:react`, `pkg:@scope/name`, `pkg:org.example.web` — not a module of this tree. */
function externalOf(target: string): string | undefined {
  if (!target.startsWith("pkg:")) return undefined;
  const name = target.slice(4);
  // a JVM package: its first three parts (`org.springframework.web`), a library more than a class
  if (!name.includes("/") && /^[a-z][\w]*(\.[\w]+)+$/.test(name))
    return `pkg:${name.split(".").slice(0, 3).join(".")}`;
  return `pkg:${name
    .split("/")
    .slice(0, name.startsWith("@") ? 2 : 1)
    .join("/")}`;
}

/** Test source sets of a JVM build: `src/test/…`, `src/integrationTest/…`. */
const TEST_SOURCE_SET = /(^|\/)src\/(test|it|integrationTest|testFixtures)(\/|$)/;

/**
 * Where the modules of a JVM tree are: each source root (`src/main/java`, `svc/src/test/groovy`) with
 * its base package — the directory every source file of the root is under. A module is a package
 * right below the base (`…/orders/service`): the layers and features of the service, not one
 * `src/main` for everything.
 */
export interface ModuleLayout {
  readonly jvm: ReadonlyArray<{ readonly root: string; readonly base: string }>;
}

export function moduleLayoutOf(files: readonly string[]): ModuleLayout {
  const dirs = new Map<string, string[][]>();
  for (const f of files) {
    const m = /^(.*?src\/[^/]+\/(?:java|groovy|kotlin))\/(.+)\/[^/]+\.(?:java|groovy|kt)$/.exec(f);
    if (!m) continue;
    const root = m[1] as string;
    dirs.set(root, [...(dirs.get(root) ?? []), (m[2] as string).split("/")]);
  }
  const jvm = [...dirs.entries()].map(([root, all]) => {
    const first = all[0] ?? [];
    let n = 0;
    while (n < first.length && all.every((d) => d[n] === first[n])) n += 1;
    return { root, base: [root, ...first.slice(0, n)].join("/") };
  });
  return { jvm: jvm.sort((a, b) => b.root.length - a.root.length) };
}

/** The module of a graph target: a file's module, or the external package it names. */
function targetModuleOf(target: string, layout?: ModuleLayout): string {
  return externalOf(target) ?? moduleOf(target, layout);
}

export function moduleOf(file: string, layout?: ModuleLayout): string {
  for (const { root, base } of layout?.jvm ?? []) {
    if (file.startsWith(`${base}/`)) {
      const rest = file.slice(base.length + 1).split("/");
      return rest.length > 1 ? `${base}/${rest[0]}` : base;
    }
    if (file.startsWith(`${root}/`)) return root;
  }
  const resources = /^(.*?src\/[^/]+\/resources)\//.exec(file);
  if (resources && layout && layout.jvm.length > 0) return resources[1] as string;
  const parts = file.split("/");
  if (parts.length === 1) return "(root)";
  const [a, b] = parts as [string, string];
  if (MODULE_ROOTS.has(a) && parts.length > 2) return `${a}/${b}`;
  if (a === "src") return parts.length > 2 ? `src/${b}` : "src";
  return a;
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

function exists(root: string, rel: string): boolean {
  return existsSync(join(root, rel));
}

function packageManagerOf(root: string): string | undefined {
  if (exists(root, "pnpm-lock.yaml")) return "pnpm";
  if (exists(root, "yarn.lock")) return "yarn";
  if (exists(root, "bun.lockb") || exists(root, "bun.lock")) return "bun";
  if (exists(root, "package-lock.json")) return "npm";
  return exists(root, "package.json") ? "npm" : undefined;
}

function commandsOf(root: string, pm: string | undefined, files: readonly string[]): CommandFact[] {
  const out: CommandFact[] = [];
  const pkg = readJson<{ scripts?: Record<string, string>; devDependencies?: Record<string, string> }>(
    join(root, "package.json"),
  );
  if (pkg && pm) {
    const run = (script: string) => (pm === "npm" ? `npm run ${script}` : `${pm} ${script}`);
    const scripts = pkg.scripts ?? {};
    const pick = (name: CommandFact["name"], candidates: string[]) => {
      const found = candidates.find((c) => scripts[c]);
      if (found) out.push({ name, command: run(found), source: `package.json scripts.${found}` });
    };
    pick("tests", ["test", "test:unit", "tests"]);
    pick("typecheck", ["typecheck", "type-check", "tsc", "check:types"]);
    pick("lint", ["lint", "lint:check", "eslint"]);
    pick("build", ["build"]);
    if (!out.some((c) => c.name === "typecheck") && exists(root, "tsconfig.json"))
      out.push({
        name: "typecheck",
        command: `${pm === "npm" ? "npx" : pm} tsc --noEmit`,
        source: "tsconfig.json",
      });
  }
  const has = (re: RegExp) => files.some((f) => re.test(f));
  if (has(/\.(sln|csproj)$/)) {
    out.push({ name: "tests", command: "dotnet test", source: "*.sln / *.csproj" });
    out.push({ name: "build", command: "dotnet build", source: "*.sln / *.csproj" });
  }
  if (exists(root, "go.mod")) out.push({ name: "tests", command: "go test ./...", source: "go.mod" });
  if (exists(root, "Cargo.toml")) {
    out.push({ name: "tests", command: "cargo test", source: "Cargo.toml" });
    out.push({ name: "lint", command: "cargo clippy", source: "Cargo.toml" });
  }
  if (exists(root, "pom.xml")) out.push({ name: "tests", command: "mvn test", source: "pom.xml" });
  else if (exists(root, "build.gradle") || exists(root, "build.gradle.kts")) {
    out.push({ name: "tests", command: "./gradlew test", source: "build.gradle" });
    // compiles main and tests: what a typecheck is for Java (the test task must stay last in `tests`)
    out.push({ name: "typecheck", command: "./gradlew classes testClasses -q", source: "build.gradle" });
  }
  if (exists(root, "pyproject.toml") || exists(root, "pytest.ini") || exists(root, "requirements.txt")) {
    const toml = exists(root, "pyproject.toml") ? readFileSync(join(root, "pyproject.toml"), "utf8") : "";
    if (/pytest/.test(toml) || exists(root, "pytest.ini") || has(/(^|\/)test_[^/]+\.py$/))
      out.push({ name: "tests", command: "pytest", source: "pytest configuration / test files" });
    if (/\[tool\.ruff/.test(toml) || exists(root, "ruff.toml"))
      out.push({ name: "lint", command: "ruff check .", source: "ruff configuration" });
  }
  // one command per name: the first (package.json beats the heuristics)
  const seen = new Set<string>();
  return out.filter((c) => !seen.has(c.name) && seen.add(c.name));
}

const LINTERS: Array<[string, RegExp]> = [
  ["biome", /(^|\/)biome\.jsonc?$/],
  ["eslint", /(^|\/)(\.eslintrc(\.[a-z]+)?|eslint\.config\.[a-z]+)$/],
  ["prettier", /(^|\/)(\.prettierrc(\.[a-z]+)?|prettier\.config\.[a-z]+)$/],
  ["editorconfig", /(^|\/)\.editorconfig$/],
  ["ruff", /(^|\/)ruff\.toml$/],
  ["golangci-lint", /(^|\/)\.golangci\.ya?ml$/],
  ["rustfmt", /(^|\/)rustfmt\.toml$/],
  ["checkstyle", /(^|\/)checkstyle\.xml$/],
  ["stylecop", /(^|\/)stylecop\.json$/],
  ["dotnet-analyzers", /(^|\/)Directory\.Build\.props$/],
];
const CI: Array<[string, RegExp]> = [
  ["GitHub Actions", /^\.github\/workflows\/[^/]+\.ya?ml$/],
  ["GitLab CI", /^\.gitlab-ci\.ya?ml$/],
  ["Jenkins", /(^|\/)Jenkinsfile$/],
  ["Azure Pipelines", /(^|\/)azure-pipelines\.ya?ml$/],
  ["Bitbucket Pipelines", /^bitbucket-pipelines\.ya?ml$/],
];

function docsOf(files: readonly string[]): ScanReport["docs"] {
  const out: ScanReport["docs"] = [];
  for (const f of files) {
    const lower = f.toLowerCase();
    if (/(^|\/)readme(\.[a-z]+)?$/.test(lower) && f.split("/").length <= 2)
      out.push({ path: f, kind: "readme" });
    else if (/(^|\/)contributing(\.[a-z]+)?$/.test(lower)) out.push({ path: f, kind: "contributing" });
    else if (/(^|\/)changelog(\.[a-z]+)?$/.test(lower)) out.push({ path: f, kind: "changelog" });
    else if (/(^|\/)architecture(\.[a-z]+)?$/.test(lower)) out.push({ path: f, kind: "architecture" });
    else if (/(^|\/)(adr|adrs|decisions)\/[^/]+\.md$/.test(lower)) out.push({ path: f, kind: "adr" });
    else if (/^(docs?|documentation)\/.+\.(md|mdx|rst|adoc)$/.test(lower))
      out.push({ path: f, kind: "docs" });
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function entryPointsOf(root: string, files: readonly string[]): string[] {
  const out = new Set<string>();
  const pkg = readJson<{ main?: string; bin?: string | Record<string, string> }>(join(root, "package.json"));
  if (pkg?.main) out.add(pkg.main);
  if (typeof pkg?.bin === "string") out.add(pkg.bin);
  else if (pkg?.bin) for (const v of Object.values(pkg.bin)) out.add(v);
  for (const f of files) {
    if (/^(src\/)?(index|main|app|server|cli)\.(ts|tsx|js|mjs|py|go|rs)$/.test(f)) out.add(f);
    else if (/(^|\/)Program\.cs$/.test(f) || /(^|\/)main\.go$/.test(f) || /^cmd\/[^/]+\/main\.go$/.test(f))
      out.add(f);
    else if (/(^|\/)manage\.py$/.test(f) || /(^|\/)__main__\.py$/.test(f)) out.add(f);
    else if (/^src\/main\.rs$/.test(f) || /(^|\/)(Main|Application)\.java$/.test(f)) out.add(f);
  }
  return [...out].sort();
}

function testsOf(files: readonly string[]): ScanReport["tests"] {
  // a JVM test source set (`src/test/java`) is a directory of tests too
  const setOf = (f: string) => /^(.*?src\/(?:test|it|integrationTest|testFixtures)\/[^/]+)\//.exec(f)?.[1];
  const dirOf = (f: string) =>
    TEST_DIRS.has(f.split("/")[0] ?? "") ? (f.split("/")[0] as string) : setOf(f);
  const tests = files.filter(
    (f) =>
      TEST_FILE.test(f) ||
      TEST_DIRS.has(f.split("/")[0] ?? "") ||
      (setOf(f) !== undefined && CODE_EXT[extname(f)] !== undefined),
  );
  const inDir = tests.filter((f) => dirOf(f) !== undefined);
  const colocated = tests.filter((f) => dirOf(f) === undefined);
  const layout: ScanReport["tests"]["layout"] =
    tests.length === 0
      ? "none"
      : colocated.length === 0
        ? "separate-dir"
        : inDir.length === 0
          ? "colocated"
          : "mixed";
  return {
    files: tests.length,
    layout,
    dirs: [...new Set(inDir.map((f) => dirOf(f) as string))].sort(),
  };
}

function frameworksOf(root: string, files: readonly string[]): string[] {
  const pkg = readJson<{ dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>(
    join(root, "package.json"),
  );
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const out = new Set<string>();
  for (const name of ["vitest", "jest", "mocha", "ava", "playwright", "cypress", "@playwright/test"])
    if (deps[name]) out.add(name.replace("@playwright/test", "playwright"));
  if (files.some((f) => /(^|\/)(pytest\.ini|conftest\.py)$/.test(f))) out.add("pytest");
  if (files.some((f) => /\.csproj$/.test(f))) {
    for (const f of files.filter((x) => x.endsWith(".csproj"))) {
      const text = readFileSync(join(root, f), "utf8");
      for (const fw of ["xunit", "nunit", "mstest"]) if (new RegExp(fw, "i").test(text)) out.add(fw);
    }
  }
  return [...out].sort();
}

async function commitsOf(
  root: string,
): Promise<{ commits: ScanReport["commits"]; hotspots: ScanReport["hotspots"] }> {
  const subjects = await git(["log", "-n", "200", "--format=%s"], root);
  const lines = subjects.code === 0 ? subjects.stdout.split("\n").filter(Boolean) : [];
  const conv = /^(feat|fix|chore|docs|refactor|test|tests|perf|build|ci|style|revert)(\(([^)]+)\))?!?:/;
  const scopes = new Map<string, number>();
  let conventional = 0;
  let ticket = 0;
  for (const s of lines) {
    const m = conv.exec(s);
    if (m) {
      conventional += 1;
      if (m[3]) scopes.set(m[3], (scopes.get(m[3]) ?? 0) + 1);
    }
    if (/^\[?[A-Z][A-Z0-9]+-\d+/.test(s)) ticket += 1;
  }
  const names = await git(["log", "-n", "500", "--name-only", "--format=", "--diff-filter=AM"], root);
  const counts = new Map<string, number>();
  if (names.code === 0)
    for (const f of names.stdout.split("\n").filter(Boolean))
      if (!SKIP_FILE.test(f) && !SKIP_DIR.test(f)) counts.set(f, (counts.get(f) ?? 0) + 1);
  return {
    commits: {
      sampled: lines.length,
      conventional,
      ticketPrefix: ticket,
      scopes: [...scopes.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 6)
        .map(([k]) => k),
    },
    hotspots: [...counts.entries()]
      .filter(([f]) => exists(root, f))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 8)
      .map(([file, commits]) => ({ file, commits })),
  };
}

function sensitiveOf(root: string, files: readonly string[]): string[] {
  const out = new Set<string>();
  try {
    for (const e of readdirSync(root))
      if (/^\.env(\..+)?$/.test(e) && !/example|sample|template/.test(e)) out.add(e);
  } catch {
    // unreadable root: nothing to suggest
  }
  for (const f of files) {
    if (/\.(pem|key|p12|pfx|jks)$/.test(f)) out.add(f);
    else if (/(^|\/)(secrets?|credentials?)(\/|\.)/.test(f))
      out.add(f.split("/")[0] === "secrets" ? "secrets/**" : f);
  }
  return [...out].sort();
}

/** Adds one tracked file to a module's counts; returns the lines it contributed. */
export function countFile(
  root: string,
  f: string,
  s: { files: number; lines: number; langs: Set<string> },
): number {
  s.files += 1;
  const lang = CODE_EXT[extname(f)];
  if (!lang) return 0;
  s.langs.add(lang);
  try {
    const full = join(root, f);
    if (statSync(full).size < 1_000_000) {
      const n = readFileSync(full, "utf8").split("\n").length;
      s.lines += n;
      return n;
    }
  } catch {
    // deleted in the working tree or unreadable: the file still counts
  }
  return 0;
}

/**
 * Facts for a directory inside a module. In a monorepo a module is a whole package (the pilot's shared
 * library is too large for one mapper pass), so `onboard --module` also takes a part of
 * one. Dependencies are named at the same depth inside the same module (`…/src/observability`) and by
 * module outside it. Undefined when no tracked file lives there.
 */
export async function scopeFacts(
  root: string,
  path: string,
  graph?: { edges: readonly GraphEdge[] } | undefined,
): Promise<ModuleFacts | undefined> {
  const listed = await git(["ls-files", "-z", "--", path], root);
  const files = (listed.code === 0 ? listed.stdout.split("\0").filter(Boolean) : []).filter(
    (f) => f.startsWith(`${path}/`) && !SKIP_FILE.test(f) && !SKIP_DIR.test(f),
  );
  if (files.length === 0) return undefined;
  const s = { files: 0, lines: 0, langs: new Set<string>() };
  for (const f of files) countFile(root, f, s);

  const layout = moduleLayoutOf(await trackedFiles(root));
  const home = moduleOf(`${path}/x`, layout);
  const depth = path.split("/").length;
  const inside = (f: string) => f.startsWith(`${path}/`);
  const keyOf = (f: string) => {
    const external = externalOf(f);
    if (external) return external;
    if (moduleOf(f, layout) !== home) return moduleOf(f, layout);
    const parts = f.split("/");
    return parts.length > depth ? parts.slice(0, depth).join("/") : parts.slice(0, -1).join("/") || f;
  };
  const dependsOn = new Set<string>();
  const usedBy = new Set<string>();
  for (const e of graph?.edges ?? []) {
    if (e.relation !== "DEPENDS_ON" || e.to.startsWith("unresolved:") || e.from.includes("#")) continue;
    if (inside(e.from) && !inside(e.to)) dependsOn.add(keyOf(e.to));
    else if (inside(e.to) && !inside(e.from)) usedBy.add(keyOf(e.from));
  }
  return {
    path,
    role: rolOf(path, path.split("/")[0] as string),
    files: s.files,
    lines: s.lines,
    languages: [...s.langs].sort(),
    dependsOn: [...dependsOn].sort(),
    usedBy: [...usedBy].sort(),
  };
}

/** Tracked files the scan counts (no lock files, build output, vendored code or `.jarvis/`). */
export async function trackedFiles(root: string): Promise<string[]> {
  const listed = await git(["ls-files", "-z"], root);
  const all = listed.code === 0 ? listed.stdout.split("\0").filter(Boolean) : [];
  return all.filter((f) => !SKIP_FILE.test(f) && !SKIP_DIR.test(f));
}

export interface ScanOptions {
  readonly root: string;
  /** Edges of the project graph, when one is available: module dependencies come from it. */
  readonly graph?:
    | { edges: readonly GraphEdge[]; nodes: number; all?: readonly GraphNode[] | undefined }
    | undefined;
  readonly graphReason?: string;
}

export async function scanProject(options: ScanOptions): Promise<ScanReport> {
  const root = options.root;
  const listed = await git(["ls-files", "-z"], root);
  const all = listed.code === 0 ? listed.stdout.split("\0").filter(Boolean) : [];
  const files = all.filter((f) => !SKIP_FILE.test(f) && !SKIP_DIR.test(f));

  const layout = moduleLayoutOf(files);
  const stats = new Map<string, { files: number; lines: number; langs: Set<string> }>();
  let totalLines = 0;
  for (const f of files) {
    const m = moduleOf(f, layout);
    const s = stats.get(m) ?? { files: 0, lines: 0, langs: new Set<string>() };
    totalLines += countFile(root, f, s);
    stats.set(m, s);
  }

  const deps = new Map<string, Map<string, number>>();
  if (options.graph) {
    for (const e of options.graph.edges) {
      if (e.relation !== "DEPENDS_ON" || e.to.startsWith("unresolved:")) continue;
      // a symbol (`file#Type.method`) belongs to its file's module; symbol edges are not modules' ones
      if (e.from.includes("#") || e.to.includes("#")) continue;
      const a = moduleOf(e.from, layout);
      // pilot: `pkg:react` has no slash and became the module "(root)"
      const b = targetModuleOf(e.to, layout);
      // the JDK is everyone's dependency: no fact about a module
      if (a === b || /^pkg:(java|javax\.annotation|jdk|kotlin|groovy)(\.|$)/.test(b)) continue;
      const row = deps.get(a) ?? new Map<string, number>();
      row.set(b, (row.get(b) ?? 0) + 1);
      deps.set(a, row);
    }
  }
  const usedBy = new Map<string, string[]>();
  for (const [from, row] of deps)
    for (const to of row.keys()) usedBy.set(to, [...(usedBy.get(to) ?? []), from]);

  const modules: ModuleFacts[] = [...stats.entries()]
    .map(([path, s]) => ({
      path,
      role: rolOf(path, path.split("/")[0] as string),
      files: s.files,
      lines: s.lines,
      languages: [...s.langs].sort(),
      dependsOn: [...(deps.get(path)?.keys() ?? [])].sort(),
      usedBy: (usedBy.get(path) ?? []).sort(),
    }))
    .sort((a, b) => b.lines - a.lines || a.path.localeCompare(b.path));

  const pm = packageManagerOf(root);
  const { commits, hotspots } = await commitsOf(root);
  const jvm =
    layout.jvm.length > 0 && options.graph
      ? jvmFactsOf(layout, options.graph.edges, options.graph.all ?? [])
      : undefined;
  return {
    root,
    stacks: detectStacks(root),
    stackScopes: detectStackScopes(root),
    ...(pm ? { packageManager: pm } : {}),
    commands: commandsOf(root, pm, files),
    modules,
    entryPoints: entryPointsOf(root, files),
    docs: docsOf(files),
    tooling: {
      linters: LINTERS.flatMap(([tool, re]) =>
        files
          .filter((f) => re.test(f))
          .slice(0, 1)
          .map((file) => ({ tool, file })),
      ),
      ci: [...new Set(CI.filter(([, re]) => files.some((f) => re.test(f))).map(([n]) => n))],
      testFrameworks: [
        ...new Set([
          ...frameworksOf(root, files),
          ...(jvm?.testRoots ?? []).flatMap((r) => r.frameworks.map((f) => f.replace(/ \(\d+\)$/, ""))),
        ]),
      ].sort(),
    },
    tests: testsOf(files),
    commits,
    hotspots,
    sensitivePaths: sensitiveOf(root, files),
    files: files.length,
    lines: totalLines,
    graph: options.graph
      ? { available: true, nodes: options.graph.nodes, edges: options.graph.edges.length }
      : { available: false, ...(options.graphReason ? { reason: options.graphReason } : {}) },
    ...(jvm ? { jvm } : {}),
  };
}

const TEST_FRAMEWORKS: Array<[RegExp, string]> = [
  [/^org\.junit\.jupiter/, "JUnit 5"],
  [/^org\.junit(\.|$)(?!jupiter)/, "JUnit 4"],
  [/^spock\./, "Spock"],
  [/^org\.mockito/, "Mockito"],
  [/^org\.testcontainers/, "Testcontainers"],
  [/^org\.springframework\.boot\.test/, "Spring Boot Test"],
  [/^org\.springframework\.test\.web\.servlet/, "MockMvc"],
  [/^org\.springframework\.test\.web\.reactive/, "WebTestClient"],
  [/^org\.springframework\.cloud\.stream\.binder\.test/, "Spring Cloud Stream test binder"],
  [/^org\.springframework\.kafka\.test/, "Spring Kafka test"],
  [/^org\.assertj/, "AssertJ"],
  [/^(com\.github\.tomakehurst\.wiremock|org\.wiremock)/, "WireMock"],
];
const LIBRARIES: Array<[RegExp, string]> = [
  [/^lombok/, "Lombok"],
  [/^org\.mapstruct/, "MapStruct"],
  [/^org\.springframework\.web/, "Spring MVC"],
  [/^org\.springframework\.data\.mongodb/, "Spring Data MongoDB"],
  [/^org\.springframework\.data\.jpa|^jakarta\.persistence|^javax\.persistence/, "JPA"],
  [/^org\.springframework\.kafka/, "Spring Kafka"],
  [/^org\.springframework\.cloud\.stream/, "Spring Cloud Stream"],
  [/^org\.springframework\.cloud\.openfeign/, "OpenFeign"],
  [/^(jakarta|javax)\.validation/, "Bean Validation"],
  [/^io\.swagger|^org\.springdoc/, "OpenAPI annotations"],
  [/^com\.fasterxml\.jackson/, "Jackson"],
  [/^reactor\.|^org\.springframework\.web\.reactive/, "Reactor / WebFlux"],
];

/**
 * A JVM tree's tests and libraries from its graph: what each test source root's runnable tests are
 * called and import, the test code others extend or use, the libraries of the main code. The
 * conventions a test agent needs before it writes one — which framework where, which base class.
 */
export function jvmFactsOf(
  layout: ModuleLayout,
  edges: readonly GraphEdge[],
  nodes: readonly GraphNode[],
): JvmFacts | undefined {
  const testRoots = layout.jvm.filter((r) => TEST_SOURCE_SET.test(`${r.root}/`));
  const runnable = new Set(nodes.filter((n) => n.kind === "Test" && n.file).map((n) => n.file as string));
  const rootOf = (f: string) => testRoots.find((r) => f.startsWith(`${r.root}/`))?.root;
  const imports = new Map<string, Set<string>>(); // test file → packages
  const usedBy = new Map<string, Set<string>>(); // test-source file → runnable tests
  const mainLibs = new Set<string>();
  for (const e of edges) {
    if (e.from.includes("#") || e.to.includes("#")) continue;
    // a runnable test's imports are TESTED_BY edges into it; other files' are DEPENDS_ON out of them
    const [file, target] =
      e.relation === "TESTED_BY" ? [e.to, e.from] : e.relation === "DEPENDS_ON" ? [e.from, e.to] : [];
    if (!file || !target) continue;
    if (target.startsWith("pkg:")) {
      const pkg = target.slice(4);
      if (rootOf(file)) imports.set(file, (imports.get(file) ?? new Set()).add(pkg));
      else if (/\.(java|groovy|kt)$/.test(file))
        for (const [re, name] of LIBRARIES) if (re.test(pkg)) mainLibs.add(name);
    } else if (e.relation === "TESTED_BY" && rootOf(target) && runnable.has(file)) {
      usedBy.set(target, (usedBy.get(target) ?? new Set()).add(file));
    }
  }
  if (testRoots.length === 0 && mainLibs.size === 0) return undefined;
  return {
    testRoots: testRoots
      .map(({ root }) => {
        const tests = [...runnable].filter((f) => f.startsWith(`${root}/`));
        const suffixes = new Map<string, number>();
        for (const t of tests) {
          const s = /(Test|Tests|Spec|Specification|IT)\.\w+$/.exec(t)?.[1];
          if (s) suffixes.set(s, (suffixes.get(s) ?? 0) + 1);
        }
        // frameworks: what the root's test code imports, counted by its runnable tests and support code
        const code = [...imports.keys()].filter((f) => f.startsWith(`${root}/`));
        const frameworks = new Map<string, number>();
        for (const t of code)
          for (const name of new Set(
            [...(imports.get(t) ?? [])].flatMap((p) =>
              TEST_FRAMEWORKS.filter(([re]) => re.test(p)).map(([, n]) => n),
            ),
          ))
            frameworks.set(name, (frameworks.get(name) ?? 0) + 1);
        return {
          root,
          tests: tests.length,
          suffixes: [...suffixes]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([s, n]) => `*${s} (${n})`),
          frameworks: [...frameworks]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([f, n]) => `${f} (${n})`),
        };
      })
      .filter((r) => r.tests > 0),
    shared: [...usedBy]
      .map(([file, tests]) => ({ file, tests: tests.size }))
      .sort((a, b) => b.tests - a.tests || a.file.localeCompare(b.file))
      .slice(0, 12),
    libraries: [...mainLibs].sort(),
  };
}
