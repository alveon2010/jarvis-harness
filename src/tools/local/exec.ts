import { execFile, spawn } from "node:child_process";

export interface CommandResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export interface CommandOptions {
  readonly cwd: string;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
  readonly maxBytes?: number;
  readonly input?: string;
  /** Each non-empty output line as it comes (stdout and stderr), e.g. for a progress line. */
  readonly onLine?: (line: string) => void;
}

const DEFAULT_MAX = 8 * 1024 * 1024;

/** Runs an executable with arguments (no shell). Output is capped, never thrown away silently. */
export function runCommand(
  file: string,
  args: readonly string[],
  options: CommandOptions,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const started = Date.now();
    const max = options.maxBytes ?? DEFAULT_MAX;
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ["pipe", "pipe", "pipe"],
      // Windows: a run started by the page has no console, so each console child would open a window
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = options.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          child.kill("SIGKILL");
        }, options.timeoutMs)
      : undefined;
    const lines = (chunk: Buffer) => {
      if (!options.onLine) return;
      for (const line of chunk.toString("utf8").split(/\r?\n|\r/)) {
        // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
        const plain = line.replace(/\u001b\[[0-9;?]*[A-Za-z]/g, "").trim();
        if (plain) options.onLine(plain);
      }
    };
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < max) stdout += chunk.toString("utf8");
      lines(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < max) stderr += chunk.toString("utf8");
      lines(chunk);
    });
    child.on("error", (error) => {
      if (timer) clearTimeout(timer);
      resolve({
        code: null,
        stdout,
        stderr: `${stderr}${error.message}`,
        timedOut,
        durationMs: Date.now() - started,
      });
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut, durationMs: Date.now() - started });
    });
    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
  });
}

/**
 * cmd.exe reads `/` as a switch: `./gradlew test` is "'.' is not recognized". A command word that
 * starts with `./` or `../` (at the start of the line or after `&&`, `||`, `&`, `|`, `(`) gets
 * backslashes, so `.\gradlew` finds gradlew.bat — the commands of project.yaml stay POSIX-style.
 */
export function windowsCommandLine(command: string): string {
  return command.replace(
    /(^|&&|\|\||[&|(])(\s*)(\.\.?\/[^\s&|()<>"]*)/g,
    (_, sep: string, space: string, word: string) => `${sep}${space}${word.replace(/\//g, "\\")}`,
  );
}

/** Runs a command line through the shell (project commands, `shell.run`). */
export function runShell(command: string, options: CommandOptions): Promise<CommandResult> {
  if (process.platform === "win32") return runCommand("cmd.exe", ["/c", windowsCommandLine(command)], options);
  return runCommand("/bin/sh", ["-c", command], options);
}

let rgAvailable: boolean | undefined;

export async function hasRipgrep(): Promise<boolean> {
  if (rgAvailable !== undefined) return rgAvailable;
  rgAvailable = await new Promise<boolean>((resolve) => {
    execFile("rg", ["--version"], { windowsHide: true }, (error) => resolve(!error));
  });
  return rgAvailable;
}

export function git(
  args: readonly string[],
  cwd: string,
  options: Partial<CommandOptions> = {},
): Promise<CommandResult> {
  return runCommand("git", args, { cwd, timeoutMs: 120_000, ...options });
}
