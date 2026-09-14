import assert from "node:assert/strict";
import { createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { after, describe, test } from "node:test";
import {
  createMonitor,
  decodeVarInt,
  encodeVarInt,
  parseStatus,
  pingServer,
  readStatusResponse,
  type MinecraftServerConfig,
} from "../src/minecraft.ts";

function statusPacket(json: string): Buffer {
  const text = Buffer.from(json, "utf8");
  const body = Buffer.concat([encodeVarInt(0x00), encodeVarInt(text.length), text]);
  return Buffer.concat([encodeVarInt(body.length), body]);
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

const statusJson = JSON.stringify({
  version: { name: "Paper 26.2", protocol: 999 },
  players: { max: 20, online: 2, sample: [{ name: "SomePlayer", id: "00000000-0000-0000-0000-000000000000" }] },
  description: { text: "", extra: [{ text: "§aTest " }, { text: "Server" }] },
  favicon: "data:image/png;base64,AAAA",
});

describe("VarInt", () => {
  test("encodes known values", () => {
    assert.deepEqual([...encodeVarInt(0)], [0x00]);
    assert.deepEqual([...encodeVarInt(127)], [0x7f]);
    assert.deepEqual([...encodeVarInt(128)], [0x80, 0x01]);
    assert.deepEqual([...encodeVarInt(300)], [0xac, 0x02]);
    assert.deepEqual([...encodeVarInt(-1)], [0xff, 0xff, 0xff, 0xff, 0x0f]);
  });

  test("round-trips, and reports incomplete or overlong input", () => {
    for (const value of [0, 1, 255, 2_097_151, 2_147_483_647, -1]) {
      assert.deepEqual(decodeVarInt(encodeVarInt(value)), { value, size: encodeVarInt(value).length });
    }
    assert.equal(decodeVarInt(Buffer.from([0x80])), null);
    assert.throws(() => decodeVarInt(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x01])), /longer than 5 bytes/);
  });
});

describe("status response", () => {
  test("waits for the whole packet", () => {
    const full = statusPacket(statusJson);
    assert.equal(readStatusResponse(full.subarray(0, full.length - 1)), null);
    assert.equal(readStatusResponse(full), statusJson);
  });

  test("keeps MOTD, version and counts, and drops player names", () => {
    const result = parseStatus(statusJson);
    assert.deepEqual(result, { motd: "Test Server", version: "Paper 26.2", playersOnline: 2, playersMax: 20 });
    assert.doesNotMatch(JSON.stringify(result), /SomePlayer/);
  });

  test("accepts a plain-string MOTD and tolerates missing fields", () => {
    assert.deepEqual(parseStatus(JSON.stringify({ description: "§lHello\n§rthere" })), {
      motd: "Hello there",
      version: "",
      playersOnline: 0,
      playersMax: 0,
    });
    assert.deepEqual(parseStatus("null"), { motd: "", version: "", playersOnline: 0, playersMax: 0 });
  });
});

describe("pingServer", () => {
  const sockets = new Set<Socket>();
  const servers: Server[] = [];

  function fakeServer(onConnection: (socket: Socket) => void): Server {
    const server = createServer((socket) => {
      sockets.add(socket);
      onConnection(socket);
    });
    servers.push(server);
    return server;
  }

  after(() => {
    for (const socket of sockets) socket.destroy();
    for (const server of servers) server.close();
  });

  test("sends a status handshake and reads a response split across writes", async () => {
    let handshake: { nextState: number; port: number } | undefined;
    const server = fakeServer((socket) => {
      socket.once("data", (data) => {
        // Handshake: length, id 0, protocol version, address, port, next state.
        let offset = decodeVarInt(data)!.size + 1;
        offset += decodeVarInt(data, offset)!.size;
        const address = decodeVarInt(data, offset)!;
        offset += address.size + address.value;
        const port = data.readUInt16BE(offset);
        handshake = { port, nextState: decodeVarInt(data, offset + 2)!.value };

        const reply = statusPacket(statusJson);
        socket.write(reply.subarray(0, 10));
        setTimeout(() => socket.write(reply.subarray(10)), 20);
      });
    });
    const port = await listen(server);

    const result = await pingServer("127.0.0.1", port, 2000);
    assert.deepEqual(result, { motd: "Test Server", version: "Paper 26.2", playersOnline: 2, playersMax: 20 });
    assert.deepEqual(handshake, { port, nextState: 1 });
  });

  test("rejects when nothing is listening", async () => {
    const server = createServer();
    const port = await listen(server);
    await new Promise((resolve) => server.close(resolve));
    await assert.rejects(pingServer("127.0.0.1", port, 2000));
  });

  test("rejects when the server never answers", async () => {
    const port = await listen(fakeServer(() => {}));
    await assert.rejects(pingServer("127.0.0.1", port, 200), /no status response within 200 ms/);
  });

  test("rejects when the server closes without answering", async () => {
    const port = await listen(fakeServer((socket) => socket.end()));
    await assert.rejects(pingServer("127.0.0.1", port, 2000), /closed before a status response/);
  });
});

describe("createMonitor", () => {
  const servers: MinecraftServerConfig[] = [
    { name: "Up", host: "up.example", port: 25565, join: "", mapUrl: "" },
    { name: "Down", host: "down.example", port: 25565, join: "", mapUrl: "" },
  ];
  const checkedAt = new Date("2026-09-14T12:00:00Z");

  test("starts unknown, then records each server's result independently", async () => {
    const monitor = createMonitor(servers, {
      now: () => checkedAt,
      ping: async (host) => {
        if (host === "down.example") throw new Error("connection refused");
        return { motd: "Up", version: "26.2", playersOnline: 1, playersMax: 20 };
      },
    });
    assert.deepEqual(
      monitor.statuses().map((status) => status.state),
      ["unknown", "unknown"],
    );

    await monitor.refresh();
    const [up, down] = monitor.statuses();
    assert.deepEqual(up, {
      server: servers[0],
      state: "online",
      checkedAt,
      result: { motd: "Up", version: "26.2", playersOnline: 1, playersMax: 20 },
    });
    assert.deepEqual(down, { server: servers[1], state: "offline", checkedAt, result: null });
  });

  test("does nothing when no servers are configured", () => {
    const monitor = createMonitor([], {
      ping: () => {
        throw new Error("must not ping");
      },
    });
    monitor.start();
    monitor.stop();
    assert.deepEqual(monitor.statuses(), []);
  });
});
