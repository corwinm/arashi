import { confirm, input, multiSelect, select, type Choice, type PromptOutcome } from "./prompts.ts";
import { serializeConfig, type Config, type InlineHookLifecycle } from "./config.ts";
import type { RepositoryCandidateDiscovery } from "./repository-candidate-discovery.ts";
import {
  normalizeRepositoryEditorState,
  planRepositoryHookFile,
  setRepositoryInlineHook,
  setRepositoryPaths,
  summarizeRepositoryEditorState,
  validateRepositoryEditorState,
  type EditorDiagnostic,
  type RepositoryActivePathObserver,
  type RepositoryEditorState,
  type RepositoryScriptContext,
} from "./repository-config-editor.ts";

export interface RepositoryOnboardingEligibility {
  stdinIsTTY?: boolean;
  stdoutIsTTY?: boolean;
  json?: boolean;
  force?: boolean;
}
export const isRepositoryOnboardingEligible = (options: RepositoryOnboardingEligibility): boolean =>
  options.stdinIsTTY === true && options.stdoutIsTTY === true && !options.json && !options.force;

export interface RepositoryOnboardingPrompts {
  confirm(message: string, defaultValue?: boolean): Promise<PromptOutcome<boolean>>;
  input(message: string, defaultValue?: string): Promise<PromptOutcome<string>>;
  multiSelect<T>(message: string, choices: Choice<T>[]): Promise<PromptOutcome<T[]>>;
  select<T>(message: string, choices: Choice<T>[]): Promise<PromptOutcome<T>>;
  showDiagnostic(message: string): void;
}
export const repositoryOnboardingPrompts: RepositoryOnboardingPrompts = {
  confirm,
  input,
  multiSelect,
  select,
  showDiagnostic: (message) => console.error(message),
};
export type RepositoryOnboardingResult =
  | { status: "declined" | "confirmed"; editor: RepositoryEditorState }
  | { status: "cancelled"; reason: "exit" | "abort" | "declined" };

const cancelled = <T>(
  outcome: PromptOutcome<T>,
): outcome is Extract<PromptOutcome<T>, { status: "cancelled" }> => outcome.status === "cancelled";
const sections: Choice<"copy" | "symlink" | "hooks">[] = [
  { name: "Copy repository-local paths", value: "copy" },
  { name: "Symlink repository-local paths", value: "symlink" },
  { name: "Lifecycle hooks", value: "hooks" },
];
const lifecycles = (["pre-create", "post-create", "pre-remove", "post-remove"] as const).map(
  (value) => ({ name: value, value }),
);
const yesNo: Choice<boolean>[] = [
  { name: "Yes", value: true },
  { name: "No", value: false },
];
const boundedDiagnostic = (diagnostic: EditorDiagnostic): string =>
  `${diagnostic.field}: ${diagnostic.message.replaceAll(/\s+/g, " ")}`.slice(0, 240);
const showFieldDiagnostics = (
  prompts: RepositoryOnboardingPrompts,
  diagnostics: readonly EditorDiagnostic[],
  field: EditorDiagnostic["field"],
): void => {
  const owned = diagnostics.filter((diagnostic) => diagnostic.field === field).slice(0, 3);
  for (const diagnostic of owned.length > 0 ? owned : diagnostics.slice(0, 1)) {
    prompts.showDiagnostic(boundedDiagnostic({ ...diagnostic, field }));
  }
};

async function collectPaths(
  editor: RepositoryEditorState,
  field: "copy" | "symlink",
  suggestions: string,
  prompts: RepositoryOnboardingPrompts,
): Promise<RepositoryEditorState | { reason: "exit" | "abort"; status: "cancelled" }> {
  for (;;) {
    const paths: string[] = [];
    for (;;) {
      const answer = await prompts.input(
        `Enter one ${field} path (repository-relative; suggestions remain unselected${suggestions ? `: ${suggestions}` : ""}):`,
      );
      if (cancelled(answer)) return answer;
      paths.push(answer.value);
      const another = await prompts.select(`Add another ${field} path?`, yesNo);
      if (cancelled(another)) return another;
      if (!another.value) break;
    }
    const normalized = normalizeRepositoryEditorState(setRepositoryPaths(editor, field, paths));
    if (normalized.ok) return normalized.state;
    showFieldDiagnostics(prompts, normalized.diagnostics, field);
  }
}

async function collectInlineHook(
  editor: RepositoryEditorState,
  lifecycle: InlineHookLifecycle,
  source: "inline-bash" | "inline-map",
  prompts: RepositoryOnboardingPrompts,
): Promise<RepositoryEditorState | { reason: "exit" | "abort"; status: "cancelled" }> {
  for (;;) {
    const variants: Record<string, string> = {};
    if (source === "inline-bash") {
      const body = await prompts.input(`Enter Bash command for ${lifecycle}:`);
      if (cancelled(body)) return body;
      if (body.value.trim()) variants.bash = body.value;
    } else {
      for (const interpreter of ["bash", "powershell", "cmd"] as const) {
        const body = await prompts.input(
          `Enter ${interpreter} command for ${lifecycle} (blank to omit):`,
        );
        if (cancelled(body)) return body;
        if (body.value.trim()) variants[interpreter] = body.value;
      }
    }
    if (Object.keys(variants).length === 0) {
      prompts.showDiagnostic(`${lifecycle}: at least one non-empty inline command is required.`);
      continue;
    }
    const normalized = normalizeRepositoryEditorState(
      setRepositoryInlineHook(
        editor,
        lifecycle,
        source === "inline-bash" ? (variants.bash as string) : variants,
      ),
    );
    if (normalized.ok) return normalized.state;
    showFieldDiagnostics(prompts, normalized.diagnostics, lifecycle);
  }
}

export const collectRepositoryOnboarding = async (options: {
  editor: RepositoryEditorState;
  prompts?: RepositoryOnboardingPrompts;
  discover: () => Promise<RepositoryCandidateDiscovery>;
  observeActivePaths?: RepositoryActivePathObserver;
  scriptContext?: RepositoryScriptContext;
}): Promise<RepositoryOnboardingResult> => {
  const prompts = options.prompts ?? repositoryOnboardingPrompts;
  const observeActivePaths = options.observeActivePaths ?? (async () => []);
  const begin = await prompts.confirm("Configure repository worktree setup now?", false);
  if (cancelled(begin)) return { reason: begin.reason, status: "cancelled" };
  if (!begin.value) return { editor: options.editor, status: "declined" };

  const selected = await prompts.multiSelect("Choose repository setup sections:", sections);
  if (cancelled(selected)) return { reason: selected.reason, status: "cancelled" };
  let { editor } = options;
  if (selected.value.includes("copy") || selected.value.includes("symlink")) {
    const discovery = await options.discover();
    if (discovery.diagnostic) prompts.showDiagnostic(discovery.diagnostic.slice(0, 240));
    const suggestions = discovery.candidates.map(({ path }) => path).join(", ");
    for (const field of ["copy", "symlink"] as const) {
      if (!selected.value.includes(field)) continue;
      const result = await collectPaths(editor, field, suggestions, prompts);
      if ("status" in result) return result;
      editor = result;
    }
  }
  if (selected.value.includes("hooks")) {
    const hooks = await prompts.multiSelect("Choose repository lifecycle hooks:", lifecycles);
    if (cancelled(hooks)) return { reason: hooks.reason, status: "cancelled" };
    for (const lifecycle of hooks.value) {
      let allowSkip = false;
      for (;;) {
        const sourceChoices: Choice<"inline-bash" | "inline-map" | "file" | "skip">[] = [
          { name: "Inline Bash command", value: "inline-bash" },
          { name: "Inline interpreter map", value: "inline-map" },
          { name: "Editable active file", value: "file" },
        ];
        if (allowSkip) {
          sourceChoices.push({ name: "Skip / keep existing active hook", value: "skip" });
        }
        const source = await prompts.select(`Choose source for ${lifecycle}:`, sourceChoices);
        if (cancelled(source)) return { reason: source.reason, status: "cancelled" };
        if (source.value === "skip") break;
        let candidate: RepositoryEditorState;
        if (source.value === "file") {
          if (!options.scriptContext)
            throw new Error(`Script context is required for ${lifecycle}.`);
          candidate = planRepositoryHookFile(editor, lifecycle, options.scriptContext);
        } else {
          const result = await collectInlineHook(editor, lifecycle, source.value, prompts);
          if ("status" in result) return result;
          candidate = result;
        }
        const validated = await validateRepositoryEditorState(candidate, observeActivePaths);
        if (validated.ok) {
          editor = validated.state;
          break;
        }
        const owned = validated.diagnostics.filter((diagnostic) => diagnostic.field === lifecycle);
        if (owned.length === 0) {
          for (const diagnostic of validated.diagnostics.slice(0, 3)) {
            prompts.showDiagnostic(boundedDiagnostic(diagnostic));
          }
          return { reason: "declined", status: "cancelled" };
        }
        showFieldDiagnostics(prompts, owned, lifecycle);
        allowSkip = true;
      }
    }
  }
  const validated = await validateRepositoryEditorState(editor, observeActivePaths);
  if (!validated.ok) {
    for (const diagnostic of validated.diagnostics.slice(0, 3))
      prompts.showDiagnostic(boundedDiagnostic(diagnostic));
    return { reason: "declined", status: "cancelled" };
  }
  editor = validated.state;
  const preview = summarizeRepositoryEditorState(editor);
  const persistedCandidate = JSON.parse(serializeConfig(editor.candidate)) as Config;
  const activeFiles = preview.hooks.filter((hook) => hook.source === "file");
  const previewSections = [
    "Apply this repository setup?",
    "Resulting repository configuration:",
    JSON.stringify(
      {
        repos: {
          [editor.repositoryName]: persistedCandidate.repos[editor.repositoryName],
        },
      },
      null,
      2,
    ),
  ];
  if (activeFiles.length > 0) {
    previewSections.push(
      "Files to create:",
      ...activeFiles.map(
        (file) => `  • ${file.lifecycle}: ${file.path} (active safe no-op; ready to edit)`,
      ),
    );
  }
  if (preview.warnings.length > 0) {
    previewSections.push("Warnings:", ...preview.warnings);
  }
  const final = await prompts.confirm(previewSections.join("\n"), false);
  if (cancelled(final)) return { reason: final.reason, status: "cancelled" };
  if (!final.value) return { reason: "declined", status: "cancelled" };
  return { editor, status: "confirmed" };
};
