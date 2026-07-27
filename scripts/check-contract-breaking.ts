import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import YAML from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const defaultSpecPath = resolve(root, "openapi/openapi.yaml");
const defaultBaselinePath = resolve(root, "openapi/contract-baseline.json");

type JsonRecord = Record<string, unknown>;

export interface ContractBaseline {
  readonly baselineVersion: string;
  readonly operations: Readonly<Record<string, string>>;
  readonly components: Readonly<Record<string, string>>;
}

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function semanticValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(semanticValue);
  }
  if (!isRecord(value)) {
    return value;
  }
  const result: JsonRecord = {};
  for (const key of Object.keys(value).sort()) {
    if (["description", "summary", "externalDocs", "example", "examples"].includes(key)) {
      continue;
    }
    result[key] = semanticValue(value[key]);
  }
  return result;
}

function digest(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(semanticValue(value)))
    .digest("hex");
}

export async function createContractBaseline(specPath = defaultSpecPath): Promise<ContractBaseline> {
  const document = YAML.parse(await readFile(specPath, "utf8")) as JsonRecord;
  const info = isRecord(document.info) ? document.info : {};
  const paths = isRecord(document.paths) ? document.paths : {};
  const operations: Record<string, string> = {};
  for (const path of Object.keys(paths).sort()) {
    const pathItem = isRecord(paths[path]) ? paths[path] : {};
    for (const method of ["get", "post", "put", "patch", "delete"]) {
      const operation = pathItem[method];
      if (!isRecord(operation)) {
        continue;
      }
      operations[`${method.toUpperCase()} ${path}`] = digest({
        pathParameters: pathItem.parameters ?? [],
        operation,
      });
    }
  }

  const componentRoot = isRecord(document.components) ? document.components : {};
  const components: Record<string, string> = {};
  for (const kind of Object.keys(componentRoot).sort()) {
    const entries = isRecord(componentRoot[kind]) ? componentRoot[kind] : {};
    for (const name of Object.keys(entries).sort()) {
      components[`${kind}/${name}`] = digest(entries[name]);
    }
  }
  return {
    baselineVersion: String(info.version ?? "0.0.0"),
    operations,
    components,
  };
}

export async function checkContractBreaking(
  specPath = defaultSpecPath,
  baselinePath = defaultBaselinePath,
): Promise<void> {
  const current = await createContractBaseline(specPath);
  const baseline = JSON.parse(await readFile(baselinePath, "utf8")) as ContractBaseline;
  const failures: string[] = [];

  for (const [key, expected] of Object.entries(baseline.operations)) {
    const actual = current.operations[key];
    if (actual === undefined) {
      failures.push(`删除 operation: ${key}`);
    } else if (actual !== expected) {
      failures.push(`修改既有 operation: ${key}`);
    }
  }
  for (const [key, expected] of Object.entries(baseline.components)) {
    const actual = current.components[key];
    if (actual === undefined) {
      failures.push(`删除 component: ${key}`);
    } else if (actual !== expected) {
      failures.push(`修改既有 component: ${key}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(
      `检测到相对 ${baseline.baselineVersion} 基线的 breaking change：\n${failures.join("\n")}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await checkContractBreaking();
  console.log("[contract] no breaking changes against committed baseline");
}
