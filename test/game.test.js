const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { randomUUID } = require("node:crypto");
const { io } = require("socket.io-client");
const { createGameServer } = require("../build/src/game-server.js");

async function fixture(t, options = {}) {
  const game = createGameServer({
    disconnectGraceMs: 60,
    emptyRoomMs: 80,
    ...options,
  });
  game.server.listen(0, "127.0.0.1");
  await once(game.server, "listening");
  const url = `http://127.0.0.1:${game.server.address().port}`;
  const clients = [];
  t.after(async () => {
    clients.forEach((client) => client.socket.disconnect());
    await game.close();
  });
  const connect = async () => {
    const socket = io(url, {
      transports: ["websocket"],
      reconnection: false,
      forceNew: true,
    });
    const client = { socket, events: [] };
    for (const [event, key] of [
      ["ROOM:STATE", "room"],
      ["DRAW:STATE", "drawing"],
      ["WORD:PRIVATE", "secret"],
    ]) {
      socket.on(event, (value) => {
        client[key] = value;
        client.events.push({ event, value });
      });
    }
    socket.on("DRAW:ADDED", (value) => {
      client.events.push({ event: "DRAW:ADDED", value });
    });
    socket.on("DRAW:APPENDED", (value) => {
      client.events.push({ event: "DRAW:APPENDED", value });
    });
    socket.on("CHAT:MESSAGE", (value) =>
      client.events.push({ event: "CHAT:MESSAGE", value }),
    );
    client.send = async (event, payload = {}, commandId = randomUUID()) =>
      socket.timeout(1000).emitWithAck(event, { ...payload, commandId });
    client.ok = async (event, payload, commandId) => {
      const reply = await client.send(event, payload, commandId);
      assert.equal(reply.ok, true, JSON.stringify(reply));
      return reply.data;
    };
    clients.push(client);
    await once(socket, "connect");
    return client;
  };
  const host = await connect();
  host.session = await host.ok("ROOM:CREATE", { name: "Художник" });
  const join = async (name = "Игрок") => {
    const client = await connect();
    client.session = await client.ok("ROOM:JOIN", {
      name,
      roomId: host.session.roomId,
    });
    return client;
  };
  const select = async () => {
    const word = host.secret.options[0];
    await host.ok("WORD:SELECT", { version: host.room.version, word });
    return word;
  };
  return { host, join, connect, select };
}
const shape = (tool = "rectangle") => ({
  id: randomUUID(),
  tool,
  color: "#f97316",
  size: 8,
  points:
    tool === "fill"
      ? [{ x: 50, y: 50 }]
      : [
          { x: 10, y: 10 },
          { x: 100, y: 100 },
        ],
  complete: true,
});
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test("rooms, names, private options, secret words and isolated broadcasts", async (t) => {
  const { host, join, connect, select } = await fixture(t);
  assert.equal(host.secret.options.length, 3);
  assert.equal(new Set(host.secret.options).size, 3);
  const viewer = await join();
  assert.deepEqual(viewer.secret.options, []);
  const stranger = await connect();
  await stranger.ok("ROOM:CREATE", { name: "Другая комната" });
  const word = await select();
  assert.equal(viewer.secret.word, null);
  assert.equal(host.secret.word, word);
  assert.equal(JSON.stringify(viewer.room).includes(`"${word}"`), false);
  await host.ok("CHAT:SEND", { text: "Привет!", version: host.room.version });
  await delay(10);
  assert(viewer.events.some((entry) => entry.value.text === "Привет!"));
  assert(!stranger.events.some((entry) => entry.value.text === "Привет!"));
  const duplicate = await connect();
  assert.equal(
    (
      await duplicate.send("ROOM:JOIN", {
        roomId: host.session.roomId,
        name: " игрок ",
      })
    ).error.code,
    "NAME_TAKEN",
  );
  assert.equal(
    (await duplicate.send("ROOM:JOIN", { roomId: "BADCODE", name: "Друг" }))
      .error.code,
    "ROOM_NOT_FOUND",
  );
  assert.equal(
    (await duplicate.send("ROOM:CREATE", { name: "" })).error.code,
    "INVALID_NAME",
  );
});

test("first normalized correct guess wins and advances to word selection exactly once", async (t) => {
  const { host, join, select } = await fixture(t);
  const viewer = await join();
  const other = await join("Друг");
  const word = await select();
  const version = host.room.version;
  const operation = { ...shape("brush"), complete: false };
  await host.ok("DRAW:ADD", { version, operation });
  await host.ok("CHAT:SEND", { version, text: word });
  assert.equal(host.room.version, version); // The drawer cannot win.
  const guess = `  ${word.toUpperCase().replaceAll("Ё", "Е").replaceAll("Е", "Ё")}  `;
  const commandId = randomUUID();
  await viewer.ok("CHAT:SEND", { version, text: guess }, commandId);
  await viewer.ok("CHAT:SEND", { version, text: guess }, commandId);
  await host.ok("ROOM:SYNC");
  await other.ok("ROOM:SYNC");
  const result = {
    round: version,
    winnerId: viewer.session.playerId,
    winnerName: "Игрок",
    word,
  };
  assert.deepEqual(host.room.lastResult, result);
  assert.deepEqual(other.room.lastResult, result);
  assert.equal(host.room.version, version + 1);
  assert.equal(host.room.drawerId, host.session.playerId);
  assert.equal(host.room.hasWord, false);
  assert.equal(host.secret.word, null);
  assert.equal(host.secret.options.length, 3);
  assert(!host.secret.options.includes(word));
  assert.deepEqual(other.secret.options, []);
  assert.deepEqual(host.drawing.operations, []);
  assert(host.room.players.every((player) => !player.guessed));
  assert.equal(
    host.room.messages.filter((item) => item.text.includes("выиграл раунд"))
      .length,
    1,
  );
  assert.equal(
    (await other.send("CHAT:SEND", { version, text: word })).error.code,
    "STALE_VERSION",
  );
  assert.equal(
    (
      await host.send("DRAW:APPEND", {
        version,
        operationId: operation.id,
        offset: operation.points.length,
        points: [],
        complete: true,
      })
    ).error.code,
    "STALE_VERSION",
  );
  assert.equal(
    (
      await host.send("DRAW:ADD", {
        version: host.room.version,
        operation: shape(),
      })
    ).error.code,
    "NO_WORD",
  );
  assert(
    !viewer.events.some(
      (entry) =>
        entry.event === "CHAT:MESSAGE" &&
        entry.value.kind === "chat" &&
        entry.value.text.trim() === word,
    ),
  );
  await select();
  assert.equal(host.room.hasWord, true);
  assert.deepEqual(host.room.lastResult, result);
  await host.ok("DRAW:ADD", { version: host.room.version, operation: shape() });
  const late = await join("Поздний");
  assert.deepEqual(late.room.lastResult, result);
});

test("simultaneous correct guesses produce one winner and results survive reconnection", async (t) => {
  const { host, join, connect, select } = await fixture(t, {
    disconnectGraceMs: 1000,
  });
  const first = await join("Первый");
  const second = await join("Второй");
  const word = await select();
  const version = host.room.version;
  const replies = await Promise.all([
    first.send("CHAT:SEND", { version, text: word }),
    second.send("CHAT:SEND", { version, text: word }),
  ]);
  assert.equal(replies.filter((reply) => reply.ok).length, 1);
  assert.equal(replies.find((reply) => !reply.ok).error.code, "STALE_VERSION");
  await host.ok("ROOM:SYNC");
  const result = host.room.lastResult;
  assert(
    [first.session.playerId, second.session.playerId].includes(result.winnerId),
  );
  assert.equal(host.room.version, version + 1);
  assert.equal(
    host.room.messages.filter((item) => item.text.includes("выиграл раунд"))
      .length,
    1,
  );
  host.socket.disconnect();
  const restored = await connect();
  await restored.ok("ROOM:JOIN", {
    roomId: host.session.roomId,
    token: host.session.token,
  });
  assert.deepEqual(restored.room.lastResult, result);
  assert.equal(restored.secret.options.length, 3);
});

test("server enforces owner, drawer, selection and current word version", async (t) => {
  const { host, join, select } = await fixture(t);
  const viewer = await join();
  const version = host.room.version;
  assert.equal(
    (
      await viewer.send("WORD:SELECT", {
        version,
        word: host.secret.options[0],
      })
    ).error.code,
    "FORBIDDEN",
  );
  assert.equal(
    (await host.send("DRAW:ADD", { version, operation: shape() })).error.code,
    "NO_WORD",
  );
  assert.equal(
    (await host.send("WORD:SELECT", { version, word: "не из списка" })).error
      .code,
    "INVALID_WORD",
  );
  await select();
  assert.equal(
    (await viewer.send("DRAW:ADD", { version, operation: shape() })).error.code,
    "FORBIDDEN",
  );
  assert.equal(
    (
      await viewer.send("ROOM:ASSIGN_DRAWER", {
        version,
        playerId: viewer.session.playerId,
      })
    ).error.code,
    "FORBIDDEN",
  );
  await host.ok("ROOM:ASSIGN_DRAWER", {
    version,
    playerId: viewer.session.playerId,
  });
  await viewer.ok("ROOM:SYNC");
  assert.equal(viewer.secret.options.length, 3);
  assert.equal(host.secret.word, null);
  assert.equal(viewer.room.hasWord, false);
  assert.equal(
    (await viewer.send("WORD:NEXT", { version })).error.code,
    "STALE_VERSION",
  );
});

test("all drawing tools, undo/redo, clear and late join snapshot", async (t) => {
  const { host, join, select } = await fixture(t);
  await select();
  const viewer = await join();
  const version = host.room.version;
  const operations = [
    "brush",
    "eraser",
    "line",
    "rectangle",
    "ellipse",
    "fill",
  ].map(shape);
  for (const operation of operations)
    await host.ok("DRAW:ADD", { version, operation });
  await viewer.ok("ROOM:SYNC");
  assert.equal(
    viewer.events.filter((entry) => entry.event === "DRAW:ADDED").length,
    6,
  );
  const late = await join("Опоздавший");
  assert.deepEqual(late.drawing.operations, operations);
  await host.ok("DRAW:UNDO", { version });
  await late.ok("ROOM:SYNC");
  assert.equal(late.drawing.operations.length, 5);
  assert.equal(late.drawing.redoCount, 1);
  await host.ok("DRAW:REDO", { version });
  await late.ok("ROOM:SYNC");
  assert.deepEqual(late.drawing.operations, operations);
  await host.ok("DRAW:UNDO", { version });
  await host.ok("DRAW:ADD", { version, operation: shape("line") });
  await host.ok("ROOM:SYNC");
  assert.equal(host.drawing.redoCount, 0);
  await host.ok("DRAW:CLEAR", { version });
  await late.ok("ROOM:SYNC");
  assert.deepEqual(late.drawing.operations, []);
  await host.ok("DRAW:REDO", { version });
  await late.ok("ROOM:SYNC");
  assert.deepEqual(late.drawing.operations, []);
});

test("streaming strokes, deduplicated retries, point ordering and stale commands", async (t) => {
  const { host, join, select } = await fixture(t);
  await select();
  const viewer = await join();
  const version = host.room.version;
  const operation = {
    ...shape("brush"),
    points: [{ x: 10, y: 10 }],
    complete: false,
  };
  const commandId = randomUUID();
  await host.ok("DRAW:ADD", { version, operation }, commandId);
  await host.ok("DRAW:ADD", { version, operation }, commandId);
  assert.equal(
    viewer.events.filter((entry) => entry.event === "DRAW:ADDED").length,
    1,
  );
  const append = {
    version,
    operationId: operation.id,
    offset: 1,
    points: [{ x: 50, y: 70 }],
    complete: false,
  };
  const appendId = randomUUID();
  await host.ok("DRAW:APPEND", append, appendId);
  await host.ok("DRAW:APPEND", append, appendId);
  assert.equal(
    viewer.events.filter((entry) => entry.event === "DRAW:APPENDED").length,
    1,
  );
  assert.equal(
    (await host.send("DRAW:APPEND", append)).error.code,
    "STALE_DRAW",
  );
  await host.ok("DRAW:APPEND", {
    ...append,
    offset: 2,
    points: [],
    complete: true,
  });
  const late = await join("Поздний");
  assert.equal(late.drawing.operations[0].points.length, 2);
  assert.equal(late.drawing.operations[0].complete, true);
  await host.ok("WORD:NEXT", { version });
  assert.equal(
    (await host.send("DRAW:ADD", { version, operation: shape() })).error.code,
    "STALE_VERSION",
  );
  assert.equal(
    (await viewer.send("CHAT:SEND", { version, text: "Старая догадка" })).error
      .code,
    "STALE_VERSION",
  );
});

test("invalid payloads, coordinates, rate limits and no membership", async (t) => {
  const { host, connect, select } = await fixture(t);
  await select();
  const outsider = await connect();
  assert.equal(
    (await outsider.send("DRAW:CLEAR", { version: host.room.version })).error
      .code,
    "NOT_JOINED",
  );
  for (const operation of [
    { ...shape(), size: 1000 },
    { ...shape(), color: "red" },
    { ...shape(), tool: "html" },
    { ...shape(), points: [{ x: -1, y: 0 }] },
    { ...shape(), points: null },
  ]) {
    assert.equal(
      (await host.send("DRAW:ADD", { version: host.room.version, operation }))
        .error.code,
      "INVALID_DRAW",
    );
  }
  assert.equal(
    (
      await host.send("CHAT:SEND", {
        version: host.room.version,
        text: "a".repeat(501),
      })
    ).error.code,
    "INVALID_MESSAGE",
  );
  assert.equal(
    (await host.socket.timeout(1000).emitWithAck("WORD:NEXT", { version: 1 }))
      .error.code,
    "INVALID_COMMAND",
  );
  let limited = false;
  for (let index = 0; index < 55; index += 1) {
    const reply = await host.send("CHAT:SEND", {
      version: host.room.version,
      text: "привет",
    });
    if (!reply.ok) {
      assert.equal(reply.error.code, "RATE_LIMIT");
      limited = true;
      break;
    }
  }
  assert(limited);
});

test("reconnection restores identity, private word, finalized stroke, chat and dedup cache", async (t) => {
  const { host, join, connect, select } = await fixture(t, {
    disconnectGraceMs: 1000,
  });
  const viewer = await join();
  const word = await select();
  const version = host.room.version;
  const operation = { ...shape("brush"), complete: false };
  const commandId = randomUUID();
  await host.ok("DRAW:ADD", { version, operation }, commandId);
  await viewer.ok("CHAT:SEND", { version, text: "Не знаю" });
  host.socket.disconnect();
  const restored = await connect();
  const identity = await restored.ok("ROOM:JOIN", {
    roomId: host.session.roomId,
    token: host.session.token,
  });
  assert.equal(identity.playerId, host.session.playerId);
  assert.equal(restored.secret.word, word);
  assert.equal(restored.drawing.operations[0].complete, true);
  assert(restored.room.messages.some((item) => item.text === "Не знаю"));
  await restored.ok("DRAW:ADD", { version, operation }, commandId);
  await restored.ok("ROOM:SYNC");
  assert.equal(restored.drawing.operations.length, 1);
  const replacedEvent = once(restored.socket, "ROOM:REPLACED");
  const replacement = await connect();
  await replacement.ok("ROOM:JOIN", {
    roomId: identity.roomId,
    token: identity.token,
  });
  await replacedEvent;
  assert.equal(
    (await restored.send("DRAW:CLEAR", { version })).error.code,
    "NOT_JOINED",
  );
});

test("owner departure transfers ownership and drawer, explicit leave invalidates token", async (t) => {
  const { host, join, connect, select } = await fixture(t);
  await select();
  const viewer = await join();
  const friend = await join("Друг");
  const version = host.room.version;
  await host.ok("ROOM:LEAVE");
  assert.equal(viewer.room.ownerId, viewer.session.playerId);
  assert.equal(viewer.room.drawerId, viewer.session.playerId);
  assert.equal(viewer.room.version, version + 1);
  assert.equal(viewer.secret.options.length, 3);
  const invalid = await connect();
  assert.equal(
    (
      await invalid.send("ROOM:JOIN", {
        roomId: host.session.roomId,
        token: host.session.token,
      })
    ).error.code,
    "SESSION_EXPIRED",
  );
  await viewer.ok("ROOM:ASSIGN_DRAWER", {
    version: viewer.room.version,
    playerId: friend.session.playerId,
  });
  friend.socket.disconnect();
  await delay(100);
  assert.equal(viewer.room.drawerId, viewer.session.playerId);
  assert.equal(viewer.room.hasWord, false);
});

test("grace period preserves ownership; expired owner is replaced and empty rooms expire", async (t) => {
  const { host, join, connect } = await fixture(t);
  const viewer = await join();
  host.socket.disconnect();
  await delay(20);
  assert.equal(viewer.room.ownerId, host.session.playerId);
  assert.equal(
    viewer.room.players.find((player) => player.id === host.session.playerId)
      .connected,
    false,
  );
  await delay(80);
  assert.equal(viewer.room.ownerId, viewer.session.playerId);
  const id = host.session.roomId;
  await viewer.ok("ROOM:LEAVE");
  await delay(110);
  const outsider = await connect();
  assert.equal(
    (await outsider.send("ROOM:JOIN", { roomId: id, name: "Друг" })).error.code,
    "ROOM_NOT_FOUND",
  );
});

test("chat history retains only the last 200 messages", async (t) => {
  const { host, join } = await fixture(t);
  for (let index = 0; index < 6; index += 1) {
    const viewer = await join(`Участник ${index}`);
    for (let number = 0; number < 35; number += 1)
      await viewer.ok("CHAT:SEND", {
        version: viewer.room.version,
        text: `сообщение ${index}-${number}`,
      });
  }
  await host.ok("ROOM:SYNC");
  assert.equal(host.room.messages.length, 200);
  assert.equal(host.room.messages.at(-1).text, "сообщение 5-34");
});

test("operation limit preserves the picture; undo and clear allow new work", async (t) => {
  const { host, connect, select } = await fixture(t, {
    disconnectGraceMs: 1000,
  });
  await select();
  const version = host.room.version;
  let drawer = host;
  for (let index = 0; index < 500; index += 1) {
    if (index === 300) {
      drawer.socket.disconnect();
      drawer = await connect();
      await drawer.ok("ROOM:JOIN", {
        roomId: host.session.roomId,
        token: host.session.token,
      });
    }
    await drawer.ok("DRAW:ADD", { version, operation: shape() });
  }
  assert.equal(
    (await drawer.send("DRAW:ADD", { version, operation: shape() })).error.code,
    "DRAW_LIMIT",
  );
  await drawer.ok("ROOM:SYNC");
  assert.equal(drawer.drawing.operations.length, 500);
  await drawer.ok("DRAW:UNDO", { version });
  await drawer.ok("DRAW:ADD", { version, operation: shape("line") });
  await drawer.ok("ROOM:SYNC");
  assert.equal(drawer.drawing.operations.length, 500);
  assert.equal(drawer.drawing.redoCount, 0);
  await drawer.ok("DRAW:CLEAR", { version });
  await drawer.ok("DRAW:ADD", { version, operation: shape("fill") });
  await drawer.ok("ROOM:SYNC");
  assert.equal(drawer.drawing.operations.length, 1);
});

test("point budgets and append limit preserve accepted points", async (t) => {
  const { host, select } = await fixture(t);
  await select();
  const version = host.room.version;
  const points = Array.from({ length: 256 }, (_, index) => ({
    x: index,
    y: index,
  }));
  for (let index = 0; index < 390; index += 1)
    await host.ok("DRAW:ADD", {
      version,
      operation: { ...shape("brush"), points },
    });
  assert.equal(
    (
      await host.send("DRAW:ADD", {
        version,
        operation: { ...shape("brush"), points },
      })
    ).error.code,
    "DRAW_LIMIT",
  );
  await host.ok("ROOM:SYNC");
  assert.equal(host.drawing.operations.length, 390);
  await host.ok("DRAW:CLEAR", { version });
  // Reconnect to begin a separate rate-limit window before testing a long stroke.
  host.socket.disconnect();
  host.socket.connect();
  await once(host.socket, "connect");
  await host.ok("ROOM:JOIN", {
    roomId: host.session.roomId,
    token: host.session.token,
  });
  const operation = { ...shape("brush"), points, complete: false };
  await host.ok("DRAW:ADD", { version, operation });
  for (let offset = 256; offset < 9984; offset += 256)
    await host.ok("DRAW:APPEND", {
      version,
      operationId: operation.id,
      offset,
      points,
      complete: false,
    });
  assert.equal(
    (
      await host.send("DRAW:APPEND", {
        version,
        operationId: operation.id,
        offset: 9984,
        points,
        complete: true,
      })
    ).error.code,
    "DRAW_LIMIT",
  );
  await host.ok("DRAW:APPEND", {
    version,
    operationId: operation.id,
    offset: 9984,
    points: [],
    complete: true,
  });
  await host.ok("ROOM:SYNC");
  assert.equal(host.drawing.operations[0].points.length, 9984);
  assert.equal(host.drawing.operations[0].complete, true);
});
