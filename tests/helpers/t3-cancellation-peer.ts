// Owned adversarial peer (Node server); production clients run under Bun.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
const root = process.env.FIXTURE_ROOT!;
const load = (name: string) => JSON.parse(readFileSync(root + "/" + name, "utf8"));
const log = (event: object) => appendFileSync(root + "/peer.jsonl", JSON.stringify(event) + "\n");
const server = createServer((request, response) => {
  const path = request.url?.split("?")[0];
  const mode: string = load("mode.json");
  response.setHeader("content-type", "application/json");
  if (path === "/.well-known/t3/environment")
    return void response.end(JSON.stringify(load("shape.json").descriptor));
  if (request.headers.authorization !== "Bearer PRIVATE_TOKEN")
    return void response.writeHead(403).end();
  if (path === "/api/auth/session") {
    if (["SIGINT", "SIGKILL", "HTTP-hang", "HTTP-oversize", "HTTP-rejected"].includes(mode)) {
      log({ action: "http-entry", case: mode });
      response.on("close", () => log({ action: "http-close", case: mode }));
      if (mode === "HTTP-rejected") response.writeHead(500);
      response.write(mode === "HTTP-oversize" ? "x".repeat(1024 * 1024 + 1) : "{");
      const timer = setInterval(() => {
        if (!response.destroyed) response.write(" ");
      }, 20);
      response.on("close", () => clearInterval(timer));
      return;
    }
    return void response.end(JSON.stringify(load("shape.json").session));
  }
  if (path === "/api/auth/websocket-ticket" && mode === "ticket-invalid")
    return void response.end('{"ticket":[]}');
  if (path === "/api/orchestration/shell" && mode === "shell-error")
    return void response.writeHead(500).end("PRIVATE_BODY");
  if (path === "/api/auth/websocket-ticket") return void response.end('{"ticket":"ticket"}');
  if (path === "/api/orchestration/shell")
    return void response.end(JSON.stringify(load("shape.json").shell));
  response.writeHead(403).end();
});
server.on("upgrade", (request, socket) => {
  const mode: string = load("mode.json");
  const url = new URL(request.url!, "http://fixture");
  if (
    url.pathname !== "/ws" ||
    url.searchParams.get("wsTicket") !== "ticket" ||
    url.searchParams.get("orchestrationProtocol") !== "1"
  ) {
    socket.destroy();
    return;
  }
  const accept = createHash("sha1")
    .update(request.headers["sec-websocket-key"] + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11")
    .digest("base64");
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
      accept +
      "\r\n\r\n",
  );
  let sent = false;
  const send = (body: string) => {
    const bytes = Buffer.from(body);
    const header =
      bytes.length < 126
        ? Buffer.from([0x81, bytes.length])
        : bytes.length < 65536
          ? Buffer.from([0x81, 126, bytes.length >> 8, bytes.length & 255])
          : Buffer.from([
              0x81,
              127,
              0,
              0,
              0,
              0,
              (bytes.length >>> 24) & 255,
              (bytes.length >>> 16) & 255,
              (bytes.length >>> 8) & 255,
              bytes.length & 255,
            ]);
    socket.write(Buffer.concat([header, bytes]));
  };
  socket.on("data", (raw: Buffer) => {
    if ((raw[0]! & 15) === 8 && ["success", "shell-error", "ticket-invalid"].includes(mode)) {
      socket.write(Buffer.from([0x88, 0]));
      socket.end();
      return;
    }
    // Decode enough client framing to assert only the supported config RPC.
    const length = raw[1]! & 127;
    const offset = length < 126 ? 2 : length === 126 ? 4 : 10;
    const mask = raw.subarray(offset, offset + 4);
    const body = raw.subarray(offset + 4);
    const decoded = Buffer.from(body.map((value, index) => value ^ mask[index % 4]!));
    if (sent) {
      if (decoded.toString().includes('"Pong"')) log({ action: "pong", case: mode });
      return;
    }
    if ((raw[0]! & 15) !== 1) return;
    const rpc = JSON.parse(decoded.toString());
    if (
      rpc._tag !== "Request" ||
      rpc.id !== "1" ||
      rpc.tag !== "server.getConfig" ||
      JSON.stringify(rpc.payload) !== "{}" ||
      JSON.stringify(rpc.headers) !== "[]"
    ) {
      log({ action: "denied", case: mode });
      socket.destroy();
      return;
    }
    sent = true;
    log({ action: "ws-entry", case: mode });
    // Deliberately never acknowledge a close handshake. Production must force.
    if (mode === "WS-hang") return;
    if (mode === "WS-malformed") send("{");
    else if (mode === "WS-rpc-failed")
      send(
        JSON.stringify({
          _tag: "Exit",
          requestId: "1",
          exit: { _tag: "Failure", cause: "PRIVATE_BODY" },
        }),
      );
    else if (mode === "WS-wrong-id")
      send(
        JSON.stringify({
          _tag: "Exit",
          requestId: "other",
          exit: { _tag: "Success", value: load("shape.json").catalog },
        }),
      );
    else if (mode === "WS-oversize")
      send(
        JSON.stringify({
          _tag: "Exit",
          requestId: "1",
          exit: { _tag: "Success", value: { padding: "x".repeat(1024 * 1024 + 1) } },
        }),
      );
    else if (mode === "WS-ping") {
      send('{"_tag":"Ping"}');
      send(JSON.stringify({ _tag: "Exit", requestId: "1", exit: { _tag: "Failure" } }));
    } else
      send(
        JSON.stringify({
          _tag: "Exit",
          requestId: "1",
          exit: { _tag: "Success", value: load("shape.json").catalog },
        }),
      );
  });
  socket.on("end", () => socket.end());
  socket.on("close", () => log({ action: "ws-close", case: mode }));
  socket.on("error", () => {});
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (address && typeof address !== "string")
    console.log(
      JSON.stringify({
        port: address.port,
        pid: process.pid,
        runtime: process.versions.node,
        executable: process.execPath,
      }),
    );
});
