export const DEFAULT_PROVIDER_RESPONSE_LIMIT_BYTES = 16 * 1_024;

export class BoundedJsonError extends Error {
  constructor() {
    super("Provider 响应不是有效的有界 JSON 对象");
    this.name = "BoundedJsonError";
  }
}

function fail(): never {
  throw new BoundedJsonError();
}

export async function discardResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export async function readBoundedJsonObject(
  response: Response,
  maximumBytes = DEFAULT_PROVIDER_RESPONSE_LIMIT_BYTES,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  if (
    !Number.isSafeInteger(maximumBytes)
    || maximumBytes < 1
    || maximumBytes > 1_048_576
  ) {
    throw new TypeError("Provider 响应大小上限无效");
  }

  const declaredLength = response.headers.get("content-length");
  if (declaredLength !== null) {
    if (!/^\d+$/u.test(declaredLength)) {
      await response.body?.cancel().catch(() => undefined);
      return fail();
    }
    const length = Number(declaredLength);
    if (!Number.isSafeInteger(length) || length > maximumBytes) {
      await response.body?.cancel().catch(() => undefined);
      return fail();
    }
  }

  if (!response.body) {
    return fail();
  }
  if (signal?.aborted) {
    await response.body.cancel().catch(() => undefined);
    return fail();
  }

  const reader = response.body.getReader();
  const abort = (): void => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) {
        break;
      }
      const chunk = next.value;
      totalBytes += chunk.byteLength;
      if (totalBytes > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        return fail();
      }
      chunks.push(chunk);
    }
  } catch {
    return fail();
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }

  if (signal?.aborted || totalBytes === 0) {
    return fail();
  }
  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  let parsed: unknown;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    parsed = JSON.parse(text);
  } catch {
    return fail();
  }
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
  ) {
    return fail();
  }
  return parsed as Record<string, unknown>;
}
