import type { SagaPlan, SagaPlanFlow, SagaPlanStep } from "./types.js";

/**
 * Escapes a single-line TOML string.
 */
function escapeTomlString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/**
 * Formats a string value for TOML, using multi-line syntax if needed.
 */
function formatTomlString(str: string): string {
  if (str.includes("\n")) {
    // Multi-line basic string
    const escaped = str.replace(/\\/g, "\\\\").replace(/"""/g, '"""');
    return `"""\n${escaped}\n"""`;
  }
  return `"${escapeTomlString(str)}"`;
}

/**
 * Formats an array of strings as a TOML array: ["a", "b"]
 */
function formatStringArray(arr: string[]): string {
  return `[${arr.map((s) => `"${escapeTomlString(s)}"`).join(", ")}]`;
}

/**
 * Serializes a SagaPlanFlow into a TOML [flow] block.
 * Conforms to Saga Spec 0040 (U4, D3).
 */
export function serializeFlowToToml(flow: SagaPlanFlow): string {
  const lines: string[] = ["[flow]"];
  lines.push(`name = ${formatTomlString(flow.name)}`);

  if (flow.description) {
    lines.push(`description = ${formatTomlString(flow.description)}`);
  }

  if (flow.max_concurrency !== undefined) {
    lines.push(`max_concurrency = ${flow.max_concurrency}`);
  }

  if (flow.pr_base) {
    lines.push(`pr_base = ${formatTomlString(flow.pr_base)}`);
  }

  if (flow.merge_on_green !== undefined) {
    lines.push(`merge_on_green = ${flow.merge_on_green}`);
  }

  if (flow.merge_wait_secs !== undefined) {
    lines.push(`merge_wait_secs = ${flow.merge_wait_secs}`);
  }

  if (flow.open_prs !== undefined) {
    lines.push(`open_prs = ${flow.open_prs}`);
  }

  if (flow.on_halt) {
    lines.push(`on_halt = ${formatTomlString(flow.on_halt)}`);
  }

  if (flow.critic_agent) {
    lines.push(`critic_agent = ${formatTomlString(flow.critic_agent)}`);
  }

  if (flow.builder_model) {
    lines.push(`builder_model = ${formatTomlString(flow.builder_model)}`);
  }

  if (flow.halt_paths && flow.halt_paths.length > 0) {
    lines.push(`halt_paths = ${formatStringArray(flow.halt_paths)}`);
  }

  return lines.join("\n");
}

/**
 * Serializes a single SagaPlanStep into a TOML [[step]] block.
 * Conforms to Saga Spec 0040 (U4, D7, D10).
 */
export function serializeStepToToml(step: SagaPlanStep): string {
  const lines: string[] = ["[[step]]"];
  lines.push(`id = ${formatTomlString(step.id)}`);
  lines.push(`title = ${formatTomlString(step.title)}`);
  lines.push(`kind = ${formatTomlString(step.kind)}`);

  if (step.agent) {
    lines.push(`agent = ${formatTomlString(step.agent)}`);
  }

  if (step.deps && step.deps.length > 0) {
    lines.push(`deps = ${formatStringArray(step.deps)}`);
  }

  if (step.duration !== undefined) {
    lines.push(`duration = ${step.duration}`);
  }

  if (step.verify_cmd && step.verify_cmd.length > 0) {
    lines.push(`verify_cmd = ${formatStringArray(step.verify_cmd)}`);
  }

  if (step.prompt) {
    lines.push(`prompt = ${formatTomlString(step.prompt)}`);
  }

  if (step.gate) {
    lines.push(`gate = ${formatTomlString(step.gate)}`);
  }

  if (step.ready_cmd && step.ready_cmd.length > 0) {
    lines.push(`ready_cmd = ${formatStringArray(step.ready_cmd)}`);
  }

  if (step.ready_max_wait_secs !== undefined) {
    lines.push(`ready_max_wait_secs = ${step.ready_max_wait_secs}`);
  }

  if (step.timeout_secs !== undefined) {
    lines.push(`timeout_secs = ${step.timeout_secs}`);
  }

  return lines.join("\n");
}

/**
 * Serializes a complete SagaPlan to TOML format.
 */
export function serializePlanToToml(plan: SagaPlan): string {
  const parts: string[] = [];

  parts.push(serializeFlowToToml(plan.flow));

  for (const step of plan.steps) {
    parts.push(serializeStepToToml(step));
  }

  return parts.join("\n\n") + "\n";
}

/**
 * Parses a basic TOML value (string, array, number, boolean).
 */
function parseTomlValue(val: string): unknown {
  const trimmed = val.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
    const inner = trimmed.slice(1, -1).trim();
    if (inner.length === 0) return [];
    // Split on commas not inside quotes
    const items: string[] = [];
    let cur = "";
    let inQuotes = false;
    for (let i = 0; i < inner.length; i++) {
      const ch = inner[i];
      if (ch === '"' && (i === 0 || inner[i - 1] !== "\\")) {
        inQuotes = !inQuotes;
      }
      if (ch === "," && !inQuotes) {
        items.push(cur.trim());
        cur = "";
      } else {
        cur += ch;
      }
    }
    if (cur.trim().length > 0) items.push(cur.trim());
    return items.map((item) => {
      const parsed = parseTomlValue(item);
      return typeof parsed === "string" ? parsed : String(parsed);
    });
  }
  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\")
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t");
  }
  return trimmed;
}

/**
 * Parses a Saga Spec 0040 Plan from TOML text.
 */
export function parseSagaPlanToml(tomlText: string): SagaPlan {
  const flow: Record<string, unknown> = {};
  const steps: SagaPlanStep[] = [];

  let currentSection: "none" | "flow" | "step" = "none";
  let currentStep: Record<string, unknown> = {};

  const lines = tomlText.split("\n");
  let inMultiLinePrompt = false;
  let multiLineBuffer: string[] = [];
  let multiLineTargetKey = "";

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];

    if (inMultiLinePrompt) {
      if (rawLine.includes('"""')) {
        const endIdx = rawLine.indexOf('"""');
        multiLineBuffer.push(rawLine.slice(0, endIdx));
        const fullVal = multiLineBuffer.join("\n");
        if (currentSection === "flow") {
          flow[multiLineTargetKey] = fullVal;
        } else if (currentSection === "step") {
          currentStep[multiLineTargetKey] = fullVal;
        }
        inMultiLinePrompt = false;
        multiLineBuffer = [];
        multiLineTargetKey = "";
      } else {
        multiLineBuffer.push(rawLine);
      }
      continue;
    }

    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    if (trimmed === "[flow]") {
      currentSection = "flow";
      continue;
    }

    if (trimmed === "[[step]]") {
      if (currentSection === "step" && currentStep.id) {
        steps.push(currentStep as unknown as SagaPlanStep);
      }
      currentSection = "step";
      currentStep = {};
      continue;
    }

    const eqIdx = trimmed.indexOf("=");
    if (eqIdx !== -1) {
      const key = trimmed.slice(0, eqIdx).trim();
      const valStr = trimmed.slice(eqIdx + 1).trim();

      if (valStr.startsWith('"""')) {
        if (valStr.endsWith('"""') && valStr.length > 3) {
          const inner = valStr.slice(3, -3);
          if (currentSection === "flow") flow[key] = inner;
          else if (currentSection === "step") currentStep[key] = inner;
        } else {
          inMultiLinePrompt = true;
          multiLineTargetKey = key;
          multiLineBuffer = [valStr.slice(3)];
        }
        continue;
      }

      const parsedVal = parseTomlValue(valStr);
      if (currentSection === "flow") {
        flow[key] = parsedVal;
      } else if (currentSection === "step") {
        currentStep[key] = parsedVal;
      }
    }
  }

  if (currentSection === "step" && currentStep.id) {
    steps.push(currentStep as unknown as SagaPlanStep);
  }

  return {
    flow: {
      name: (flow.name as string) || "untitled-plan",
      description: flow.description as string | undefined,
      max_concurrency: flow.max_concurrency as number | undefined,
      merge_on_green: flow.merge_on_green as boolean | undefined,
      merge_wait_secs: flow.merge_wait_secs as number | undefined,
      open_prs: flow.open_prs as boolean | undefined,
      pr_base: flow.pr_base as string | undefined,
      on_halt: flow.on_halt as SagaPlanFlow["on_halt"],
      critic_agent: flow.critic_agent as string | undefined,
      builder_model: flow.builder_model as string | undefined,
      halt_paths: flow.halt_paths as string[] | undefined,
    },
    steps,
  };
}

