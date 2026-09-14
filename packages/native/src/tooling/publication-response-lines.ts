const responseBodyLimit = 64 * 1024;

/** Decode the helper's fixed, bounded newline response frames without reading ahead. */
export async function* readPublicationResponseLines(
  input: AsyncIterable<Uint8Array>
): AsyncGenerator<string, void, unknown> {
  const body = new Uint8Array(responseBodyLimit);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let used = 0;
  for await (const chunk of input) {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const remaining = chunk.subarray(
        offset,
        offset + responseBodyLimit - used + 1
      );
      const newline = remaining.indexOf(0x0a);
      const count = newline < 0 ? remaining.byteLength : newline;
      if (count > responseBodyLimit - used)
        throw new Error("Publication helper response exceeds 64 KiB");
      body.set(remaining.subarray(0, count), used);
      used += count;
      if (newline < 0) break;
      const line = decoder.decode(body.subarray(0, used));
      used = 0;
      offset += newline + 1;
      yield line;
    }
  }
  if (used > 0)
    throw new Error("Publication helper response ended before its newline");
}
