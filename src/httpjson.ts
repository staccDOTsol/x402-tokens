import type { ServerResponse } from "node:http";

export const json = (res: ServerResponse, code: number, body: unknown, extra: Record<string, string> = {}) => {
  const s = JSON.stringify(body);
  res.writeHead(code, { "content-type": "application/json", "content-length": Buffer.byteLength(s), ...extra });
  res.end(s);
};
