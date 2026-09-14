import { request, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";

export interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: string;
}

export async function listenOn(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

// node:http rather than fetch, so tests can set Host, Origin and Sec-Fetch-Site freely.
export function send(
  port: number,
  method: string,
  path: string,
  { headers = {}, body }: { headers?: Record<string, string>; body?: string } = {},
): Promise<Reply> {
  const formHeaders =
    body === undefined
      ? {}
      : { "content-type": "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(body)) };
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers: { ...formHeaders, ...headers } }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end(body);
  });
}
