import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";
import YAML from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const specPath = resolve(root, "openapi/openapi.yaml");
const typeOutput = resolve(root, "packages/contract/src/types.generated.ts");
const pathOutput = resolve(root, "packages/contract/src/paths.generated.ts");
const schemaOutput = resolve(root, "packages/contract/src/schemas.generated.ts");
const check = process.argv.includes("--check");

type JsonRecord = Record<string, unknown>;

function pascalCase(value: string): string {
  return value
    .replace(/(^|[-_./:]+)([a-zA-Z0-9])/g, (_match, _separator: string, char: string) => char.toUpperCase())
    .replace(/[^a-zA-Z0-9]/g, "");
}

function rewriteRefs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(rewriteRefs);
  }
  if (value && typeof value === "object") {
    const result: JsonRecord = {};
    for (const [key, child] of Object.entries(value)) {
      if (key === "$ref" && typeof child === "string" && child.startsWith("#/components/schemas/")) {
        result[key] = `${child.slice("#/components/schemas/".length)}#`;
      } else {
        result[key] = rewriteRefs(child);
      }
    }
    return result;
  }
  return value;
}

async function expectedOutputs(): Promise<Array<{ path: string; content: string }>> {
  const source = await readFile(specPath, "utf8");
  const document = YAML.parse(source) as {
    info?: { version?: string };
    paths?: Record<string, Record<string, { operationId?: string }>>;
    components?: { schemas?: Record<string, unknown> };
  };
  const ast = await openapiTS(pathToFileURL(specPath), {
    alphabetize: true,
    exportType: true,
  });
  const types = `/* eslint-disable */\n// Generated from openapi/openapi.yaml. Do not edit.\n${astToString(ast)}`;

  const operations: Array<{ name: string; path: string; method: string }> = [];
  for (const [path, pathItem] of Object.entries(document.paths ?? {})) {
    for (const [method, operation] of Object.entries(pathItem)) {
      if (!["get", "post", "put", "patch", "delete"].includes(method) || !operation.operationId) {
        continue;
      }
      operations.push({ name: pascalCase(operation.operationId), path, method: method.toUpperCase() });
    }
  }
  operations.sort((a, b) => a.name.localeCompare(b.name));
  const version = document.info?.version ?? "0.0.0";
  const pathEntries = operations.map((item) => `  ${item.name}: ${JSON.stringify(item.path)},`).join("\n");
  const methodEntries = operations.map((item) => `  ${item.name}: ${JSON.stringify(item.method)},`).join("\n");
  const paths = `// Generated from openapi/openapi.yaml. Do not edit.\n`
    + `export const GAME_MANAGE_KIT_CONTRACT_VERSION = ${JSON.stringify(version)};\n\n`
    + `export const GameManageKitPath = {\n${pathEntries}\n} as const;\n\n`
    + `export const GameManageKitMethod = {\n${methodEntries}\n} as const;\n`;

  const schemas = Object.fromEntries(
    Object.entries(document.components?.schemas ?? {}).map(([name, schema]) => [
      name,
      { ...(rewriteRefs(schema) as JsonRecord), $id: name },
    ]),
  );
  const runtimeSchemas = `// Generated from openapi/openapi.yaml. Do not edit.\n`
    + `export const GameManageKitSchemas = ${JSON.stringify(schemas, null, 2)} as const;\n`;

  return [
    { path: typeOutput, content: types },
    { path: pathOutput, content: paths },
    { path: schemaOutput, content: runtimeSchemas },
  ];
}

for (const output of await expectedOutputs()) {
  if (check) {
    const actual = await readFile(output.path, "utf8").catch(() => "");
    if (actual !== output.content) {
      throw new Error(`契约生成物漂移: ${output.path}`);
    }
  } else {
    await writeFile(output.path, output.content, "utf8");
  }
}

console.log(check ? "[contract] generated files are current" : "[contract] generated files updated");
