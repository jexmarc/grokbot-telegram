import { request as httpRequest } from "node:http";
import { describe, expect, it } from "vitest";
import { handleRequest } from "../src/core/handler.js";
import { readLimitedBody } from "../src/core/http.js";
import { startNodeServer } from "../src/adapters/node/server.js";
import { createFetchMock, createTestApp, testEnv } from "./helpers.js";

function chunkedRequest(totalBytes: number, chunkBytes = 512): { request: Request; pulled: () => number } {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      sent += chunkBytes;
      controller.enqueue(new Uint8Array(chunkBytes).fill(97));
    },
  });
  const request = new Request("https://bridge.example/send", {
    method: "POST",
    body: stream,
    duplex: "half",
  });
  return { request, pulled: () => sent };
}

describe("body limits", () => {
  it("stops reading a chunked body without content-length once the cap is passed", async () => {
    const { request, pulled } = chunkedRequest(10_000_000);
    const result = await readLimitedBody(request, 2048);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.response.status).toBe(413);
    expect(pulled()).toBeLessThan(10_000);
  });

  it("rejects /send without a bearer before reading the body", async () => {
    const app = createTestApp();
    const { request, pulled } = chunkedRequest(10_000_000);
    const response = await handleRequest(request, app.deps);
    expect(response.status).toBe(401);
    expect(pulled()).toBeLessThan(5_000);
  });

  it("returns 413 from the Node server for an oversized chunked body", async () => {
    const mock = createFetchMock();
    const server = await startNodeServer({
      env: testEnv({ MAX_BODY_BYTES: "2048" }),
      port: 0,
      fetchImpl: mock.fetchImpl,
      typingMode: "once",
    });
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const req = httpRequest(`${server.url}/nowhere`, { method: "POST" }, (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        });
        req.on("error", reject);
        // Chunked transfer: no content-length header.
        for (let i = 0; i < 10; i += 1) req.write(Buffer.alloc(1024, 97));
        req.end();
      });
      expect(status).toBe(413);
    } finally {
      await server.close();
    }
  });
});
