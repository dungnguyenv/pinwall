/**
 * The parts of a multipart/form-data request, in order: `[name, value]` for a
 * field and `[name, filename]` for a file. jsdom's FormData does not survive
 * undici's `request.formData()`, so the tests read the body text instead.
 */
export async function formParts(request: Request): Promise<[string, string][]> {
  const type = request.headers.get('content-type') ?? '';
  const boundary = /boundary=(.+)$/.exec(type)?.[1];
  if (!boundary) throw new Error(`Not a multipart request: ${type}`);
  const body = await request.text();
  return body
    .split(`--${boundary}`)
    .slice(1, -1)
    .map((part) => {
      const [head = '', ...rest] = part.replace(/^\r\n/, '').split('\r\n\r\n');
      const name = /name="([^"]*)"/.exec(head)?.[1] ?? '';
      const filename = /filename="([^"]*)"/.exec(head)?.[1];
      return [name, filename ?? rest.join('\r\n\r\n').replace(/\r\n$/, '')];
    });
}
