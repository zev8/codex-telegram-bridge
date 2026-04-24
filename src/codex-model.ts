import type { CodexAppServerClient } from "./codex-app-server";
import type { AppConfig } from "./config";

export interface ModelProbeFailure {
  readonly model: string;
  readonly error: string;
}

export interface CodexModelSelection {
  readonly model: string;
  readonly candidates: readonly string[];
  readonly failures: readonly ModelProbeFailure[];
  readonly visibleModelCount: number;
}

const MODEL_ACCESS_ERROR_PATTERN = /(?:the model .*does not exist|do not have access to it|model .*not found|unsupported model)/i;

export function isModelAccessError(message: string | null | undefined): boolean {
  return Boolean(message && MODEL_ACCESS_ERROR_PATTERN.test(message));
}

export async function selectCodexModel(
  codex: CodexAppServerClient,
  config: AppConfig,
  unavailableModels = new Set<string>(),
): Promise<CodexModelSelection> {
  const models = await codex.listModels();
  const visibleModels = uniqueStrings(models.data.map((model) => model.model).filter(Boolean));
  const candidates = uniqueStrings(config.codexModelCandidates.length > 0 ? [...config.codexModelCandidates] : visibleModels).filter(
    (model) => !unavailableModels.has(model),
  );
  const failures: ModelProbeFailure[] = [];

  for (const model of candidates) {
    try {
      await codex.probeModel({
        model,
        cwd: config.codexWorkspaceCwd,
        serviceName: `${config.serviceName}_model_probe`,
        timeoutMs: config.codexModelProbeTimeoutMs,
      });
      return {
        model,
        candidates,
        failures,
        visibleModelCount: visibleModels.length,
      };
    } catch (error) {
      failures.push({
        model,
        error: getErrorMessage(error),
      });
    }
  }

  const detail = failures.map((failure) => `${failure.model}: ${failure.error}`).join("; ");
  throw new Error(`No configured Codex model passed the startup probe.${detail ? ` ${detail}` : ""}`);
}

export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}
