import express from "express";
import http from "node:http";
import { randomUUID, randomBytes, randomInt } from "node:crypto";
import { Server, type Socket } from "socket.io";
import dictionary from "./words.js";
import type {
  ChatMessage,
  ClientEvents,
  CommandResults,
  DrawOperation,
  DrawingState,
  Point,
  Reply,
  RoomState,
  RoundResult,
  ServerEvents,
  Session,
  Tool,
} from "./protocol.js";

type Timer = ReturnType<typeof setTimeout>;
type CommandReply = Reply<Session | null>;
type CommandCache = Map<string, CommandReply>;
type RawCommand = Record<string, unknown> & { commandId: string };
type SocketData = { roomId?: string | null; playerId?: string | null };
type InterServerEvents = Record<string, never>;
type GameSocket = Socket<
  ClientEvents,
  ServerEvents,
  InterServerEvents,
  SocketData
>;
type GamePlayer = {
  id: string;
  name: string;
  token: string;
  socketId: string | null;
  timer: Timer | null;
  commands: CommandCache;
};
type Room = {
  id: string;
  players: Map<string, GamePlayer>;
  ownerId: string | null;
  drawerId: string | null;
  version: number;
  revision: number;
  word: string | null;
  lastResult: RoundResult | null;
  options: string[];
  guessed: Set<string>;
  messages: ChatMessage[];
  operations: DrawOperation[];
  redo: DrawOperation[];
  pointCount: number;
  usedOperationIds: Set<string>;
  emptyTimer: Timer | null;
};
export type GameServerOptions = {
  origin?: string;
  disconnectGraceMs?: number;
  emptyRoomMs?: number;
};

const WIDTH = 1200;
const HEIGHT = 800;
const MAX_OPERATIONS = 500;
const MAX_POINTS = 100000;
const MAX_STROKE_POINTS = 10000;
const tools = new Set<string>([
  "brush",
  "eraser",
  "line",
  "rectangle",
  "ellipse",
  "fill",
]);
const normalize = (value: string) =>
  value
    .trim()
    .toLocaleLowerCase("ru")
    .replaceAll("ё", "е")
    .replace(/\s+/gu, " ");

class GameError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}
function requireThat(
  condition: unknown,
  code: string,
  message: string,
): asserts condition {
  if (!condition) throw new GameError(code, message);
}
function identifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-zA-Z0-9_-]{1,80}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isTool(value: unknown): value is Tool {
  return typeof value === "string" && tools.has(value);
}

export function createGameServer({
  origin = process.env.ALLOWED_ORIGIN || "http://localhost:3000",
  disconnectGraceMs = 30000,
  emptyRoomMs = 600000,
}: GameServerOptions = {}) {
  const app = express();
  const server = http.createServer(app);
  const origins = origin.split(",").map((item) => item.trim());
  const io = new Server<
    ClientEvents,
    ServerEvents,
    InterServerEvents,
    SocketData
  >(server, {
    transports: ["websocket"],
    maxHttpBufferSize: 64 * 1024,
    cors: { origin: origins },
    // CORS alone does not restrict WebSocket handshakes.
    allowRequest: (request, done) =>
      done(
        null,
        !request.headers.origin || origins.includes(request.headers.origin),
      ),
  });
  const rooms = new Map<string, Room>();
  const timers = new Set<Timer>();
  let closing = false;
  const later = (callback: () => void, delay: number): Timer => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      callback();
    }, delay);
    timer.unref();
    timers.add(timer);
    return timer;
  };
  const cancel = (timer: Timer | null) => {
    if (!timer) return;
    clearTimeout(timer);
    timers.delete(timer);
  };
  const message = (room: Room, text: string, player?: GamePlayer) => {
    const item: ChatMessage = {
      id: randomUUID(),
      text,
      time: Date.now(),
      kind: player ? "chat" : "system",
      ...(player ? { playerId: player.id, name: player.name } : {}),
    };
    room.messages.push(item);
    if (room.messages.length > 200) room.messages.shift();
    io.to(room.id).emit("CHAT:MESSAGE", item);
  };
  const publicState = (room: Room): RoomState => {
    requireThat(
      room.ownerId && room.drawerId,
      "EMPTY_ROOM",
      "В комнате нет игроков",
    );
    return {
      id: room.id,
      ownerId: room.ownerId,
      drawerId: room.drawerId,
      version: room.version,
      hasWord: Boolean(room.word),
      lastResult: room.lastResult,
      players: [...room.players.values()].map((player) => ({
        id: player.id,
        name: player.name,
        connected: Boolean(player.socketId),
        guessed: room.guessed.has(player.id),
      })),
      messages: room.messages,
    };
  };
  const drawingState = (room: Room): DrawingState => ({
    version: room.version,
    revision: room.revision,
    operations: room.operations,
    redoCount: room.redo.length,
  });
  const publish = (room: Room) =>
    io.to(room.id).emit("ROOM:STATE", publicState(room));
  const publishDrawing = (room: Room) =>
    io.to(room.id).emit("DRAW:STATE", drawingState(room));
  const privateWord = (room: Room) => {
    for (const player of room.players.values()) {
      if (player.socketId)
        io.to(player.socketId).emit("WORD:PRIVATE", {
          version: room.version,
          word: player.id === room.drawerId ? room.word : null,
          options:
            player.id === room.drawerId && !room.word ? room.options : [],
        });
    }
  };
  const newWord = (room: Room, revealPrevious = true) => {
    if (room.word && revealPrevious)
      message(room, `Предыдущее слово: ${room.word}`);
    const previousOptions = new Set([room.word, ...room.options]);
    const available = dictionary.filter((word) => !previousOptions.has(word));
    room.options = [];
    while (room.options.length < 3)
      room.options.push(available.splice(randomInt(available.length), 1)[0]);
    room.word = null;
    room.guessed.clear();
    room.version += 1;
    room.operations = [];
    room.redo = [];
    room.pointCount = 0;
    room.usedOperationIds.clear();
    room.revision += 1;
    publish(room);
    publishDrawing(room);
    privateWord(room);
  };
  const completeActive = (room: Room) => {
    const last = room.operations.at(-1);
    if (last && !last.complete) {
      last.complete = true;
      room.revision += 1;
      publishDrawing(room);
    }
  };
  const removePlayer = (room: Room, player: GamePlayer) => {
    cancel(player.timer);
    room.players.delete(player.id);
    room.guessed.delete(player.id);
    message(room, `${player.name} вышел из комнаты`);
    if (!room.players.size) {
      room.ownerId = null;
      room.drawerId = null;
      room.emptyTimer = later(() => rooms.delete(room.id), emptyRoomMs);
      return;
    }
    if (room.ownerId === player.id)
      room.ownerId =
        [...room.players.values()].find((item) => item.socketId)?.id ||
        [...room.players.keys()][0];
    if (room.drawerId === player.id) {
      room.drawerId = room.ownerId;
      newWord(room);
    } else publish(room);
  };
  const getMembership = (socket: GameSocket) => {
    const room = rooms.get(socket.data.roomId ?? "");
    const player = room?.players.get(socket.data.playerId ?? "");
    requireThat(
      room && player && player.socketId === socket.id,
      "NOT_JOINED",
      "Сначала войдите в комнату",
    );
    return { room, player };
  };
  const requireDrawer = (
    socket: GameSocket,
    data: RawCommand,
    needsWord = true,
  ) => {
    const result = getMembership(socket);
    requireThat(
      result.room.drawerId === result.player.id,
      "FORBIDDEN",
      "Рисовать может только назначенный игрок",
    );
    requireThat(
      data.version === result.room.version,
      "STALE_VERSION",
      "Слово уже сменилось. Дождитесь обновления",
    );
    if (needsWord)
      requireThat(
        Boolean(result.room.word),
        "NO_WORD",
        "Сначала выберите слово",
      );
    return result;
  };
  const leave = (socket: GameSocket) => {
    if (!socket.data.roomId) return;
    const { room, player } = getMembership(socket);
    socket.leave(room.id);
    socket.data.roomId = null;
    socket.data.playerId = null;
    removePlayer(room, player);
  };
  const attach = (
    socket: GameSocket,
    room: Room,
    player: GamePlayer,
  ): Session => {
    cancel(player.timer);
    cancel(room.emptyTimer);
    player.timer = null;
    room.emptyTimer = null;
    const previousSocket = player.socketId
      ? io.sockets.sockets.get(player.socketId)
      : undefined;
    if (previousSocket && previousSocket.id !== socket.id) {
      previousSocket.leave(room.id);
      previousSocket.data.roomId = null;
      previousSocket.data.playerId = null;
      previousSocket.emit("ROOM:REPLACED");
    }
    player.socketId = socket.id;
    socket.data.roomId = room.id;
    socket.data.playerId = player.id;
    socket.join(room.id);
    publish(room);
    socket.emit("DRAW:STATE", drawingState(room));
    privateWord(room);
    return { roomId: room.id, playerId: player.id, token: player.token };
  };
  const makePlayer = (name: string): GamePlayer => ({
    id: randomUUID(),
    name,
    token: randomBytes(32).toString("hex"),
    socketId: null,
    timer: null,
    commands: new Map(),
  });
  const validateName = (name: unknown): string => {
    requireThat(
      typeof name === "string" &&
        name.trim().length >= 1 &&
        name.trim().length <= 24 &&
        !/[\p{Cc}\p{Cf}]/u.test(name),
      "INVALID_NAME",
      "Ник должен содержать от 1 до 24 символов",
    );
    return name.trim();
  };
  const validatePoints = (points: unknown): Point[] => {
    requireThat(
      Array.isArray(points) && points.length > 0 && points.length <= 256,
      "INVALID_DRAW",
      "Некорректные точки рисунка",
    );
    return points.map((point: unknown) => {
      requireThat(
        isRecord(point) &&
          typeof point.x === "number" &&
          typeof point.y === "number" &&
          Number.isFinite(point.x) &&
          Number.isFinite(point.y) &&
          point.x >= 0 &&
          point.x <= WIDTH &&
          point.y >= 0 &&
          point.y <= HEIGHT,
        "INVALID_DRAW",
        "Точка за пределами холста",
      );
      return {
        x: Math.round(point.x * 100) / 100,
        y: Math.round(point.y * 100) / 100,
      };
    });
  };

  io.on("connection", (socket) => {
    const buckets = new Map<string, { start: number; count: number }>();
    const connectionCommands: CommandCache = new Map();
    // The transport accepts arbitrary JSON, even when a typed client is used.
    // Keep input unknown here and narrow it in each command's runtime checks.
    const register = socket.on.bind(socket) as (
      event: keyof ClientEvents,
      listener: (data: unknown, ack: unknown) => void,
    ) => GameSocket;
    const on = <E extends keyof ClientEvents>(
      event: E,
      handler: (data: RawCommand) => CommandResults[E] | void,
    ) =>
      register(event, (data, ack) => {
        if (typeof ack !== "function") return;
        const respond = ack as (reply: CommandReply) => void;
        try {
          requireThat(
            isRecord(data) && identifier(data.commandId),
            "INVALID_COMMAND",
            "Некорректная команда",
          );
          const player = rooms
            .get(socket.data.roomId ?? "")
            ?.players.get(socket.data.playerId ?? "");
          const cache =
            event === "ROOM:JOIN" || event === "ROOM:CREATE"
              ? connectionCommands
              : player?.commands || connectionCommands;
          const cacheKey = `${event}:${data.commandId}`;
          const cached = cache.get(cacheKey);
          if (cached) return respond(cached);
          const key = event.startsWith("DRAW:") ? "drawing" : "other";
          const now = Date.now();
          const bucket = buckets.get(key) || { start: now, count: 0 };
          if (now - bucket.start >= 10000) {
            bucket.start = now;
            bucket.count = 0;
          }
          bucket.count += 1;
          buckets.set(key, bucket);
          requireThat(
            bucket.count <= (key === "drawing" ? 400 : 50),
            "RATE_LIMIT",
            "Слишком много действий. Подождите немного",
          );
          const result: CommandReply = {
            ok: true,
            data: handler({ ...data, commandId: data.commandId }) ?? null,
          };
          cache.set(cacheKey, result);
          if (cache.size > 512) cache.delete(cache.keys().next().value!);
          respond(result);
        } catch (error) {
          if (!(error instanceof GameError)) console.error(error);
          respond({
            ok: false,
            error: {
              code: error instanceof GameError ? error.code : "SERVER_ERROR",
              message:
                error instanceof GameError ? error.message : "Ошибка сервера",
            },
          });
        }
      });
    on("ROOM:CREATE", (data) => {
      const name = validateName(data.name);
      requireThat(
        !socket.data.roomId,
        "ALREADY_JOINED",
        "Сначала выйдите из текущей комнаты",
      );
      requireThat(
        rooms.size < 1000,
        "SERVER_FULL",
        "Сервер заполнен. Попробуйте позже",
      );
      let id;
      do {
        id = randomBytes(4).toString("hex").toUpperCase();
      } while (rooms.has(id));
      const player = makePlayer(name);
      const room: Room = {
        id,
        players: new Map([[player.id, player]]),
        ownerId: player.id,
        drawerId: player.id,
        version: 0,
        revision: 0,
        word: null,
        lastResult: null,
        options: [],
        guessed: new Set(),
        messages: [],
        operations: [],
        redo: [],
        pointCount: 0,
        usedOperationIds: new Set(),
        emptyTimer: null,
      };
      rooms.set(id, room);
      newWord(room);
      message(room, `${name} создал комнату`);
      return attach(socket, room, player);
    });
    on("ROOM:JOIN", (data) => {
      requireThat(
        typeof data.roomId === "string",
        "INVALID_ROOM",
        "Введите код комнаты",
      );
      const room = rooms.get(data.roomId.toUpperCase());
      requireThat(
        room && (room.players.size || !data.token),
        "ROOM_NOT_FOUND",
        "Комната не найдена. Возможно, сервер был перезапущен",
      );
      if (socket.data.roomId) {
        const current = getMembership(socket);
        requireThat(
          current.room.id === room.id && current.player.token === data.token,
          "ALREADY_JOINED",
          "Сначала выйдите из текущей комнаты",
        );
        return attach(socket, room, current.player);
      }
      let player;
      if (data.token) {
        player = [...room.players.values()].find(
          (item) => item.token === data.token,
        );
        requireThat(
          player,
          "SESSION_EXPIRED",
          "Время восстановления истекло. Войдите заново",
        );
      } else {
        const name = validateName(data.name);
        requireThat(
          room.players.size < 20,
          "ROOM_FULL",
          "В комнате уже 20 игроков",
        );
        requireThat(
          ![...room.players.values()].some(
            (item) => normalize(item.name) === normalize(name),
          ),
          "NAME_TAKEN",
          "Этот ник уже занят",
        );
        player = makePlayer(name);
        room.players.set(player.id, player);
        if (!room.ownerId) {
          room.ownerId = player.id;
          room.drawerId = player.id;
          newWord(room);
        }
        message(room, `${name} вошёл в комнату`);
      }
      return attach(socket, room, player);
    });
    on("ROOM:LEAVE", () => {
      leave(socket);
    });
    on("ROOM:SYNC", () => {
      const { room } = getMembership(socket);
      socket.emit("ROOM:STATE", publicState(room));
      socket.emit("DRAW:STATE", drawingState(room));
      privateWord(room);
    });
    on("ROOM:ASSIGN_DRAWER", (data) => {
      const { room, player } = getMembership(socket);
      requireThat(
        player.id === room.ownerId,
        "FORBIDDEN",
        "Только владелец может назначать рисующего",
      );
      requireThat(
        identifier(data.playerId) && room.players.get(data.playerId)?.socketId,
        "PLAYER_OFFLINE",
        "Игрок не в сети",
      );
      requireThat(
        data.version === room.version,
        "STALE_VERSION",
        "Состояние комнаты изменилось",
      );
      if (room.drawerId !== data.playerId) {
        room.drawerId = data.playerId;
        newWord(room);
      }
    });
    on("WORD:SELECT", (data) => {
      const { room } = requireDrawer(socket, data, false);
      requireThat(
        !room.word &&
          typeof data.word === "string" &&
          room.options.includes(data.word),
        "INVALID_WORD",
        "Выберите слово из предложенных",
      );
      room.word = data.word;
      room.options = [];
      publish(room);
      privateWord(room);
    });
    on("WORD:NEXT", (data) => {
      const { room } = requireDrawer(socket, data, false);
      newWord(room);
    });
    on("CHAT:SEND", (data) => {
      const { room, player } = getMembership(socket);
      requireThat(
        typeof data.text === "string" &&
          data.text.trim().length > 0 &&
          data.text.length <= 500 &&
          !/[\p{Cc}\p{Cf}]/u.test(data.text),
        "INVALID_MESSAGE",
        "Сообщение должно содержать от 1 до 500 символов",
      );
      requireThat(
        data.version === room.version,
        "STALE_VERSION",
        "Слово сменилось. Отправьте сообщение ещё раз",
      );
      if (room.word && normalize(data.text) === normalize(room.word)) {
        if (player.id !== room.drawerId && !room.guessed.has(player.id)) {
          room.lastResult = {
            round: room.version,
            winnerId: player.id,
            winnerName: player.name,
            word: room.word,
          };
          message(
            room,
            `${player.name} угадал слово и выиграл раунд ${room.version}! Слово: ${room.word}.`,
          );
          // Advance synchronously: another guess or an in-flight stroke from
          // the finished round cannot change its winner or the new canvas.
          newWord(room, false);
        }
      } else message(room, data.text.trim(), player);
    });
    on("DRAW:ADD", (data) => {
      const { room } = requireDrawer(socket, data);
      const input = data.operation;
      requireThat(
        isRecord(input) &&
          identifier(input.id) &&
          isTool(input.tool) &&
          typeof input.color === "string" &&
          /^#[0-9a-f]{6}$/iu.test(input.color) &&
          typeof input.size === "number" &&
          Number.isFinite(input.size) &&
          input.size >= 1 &&
          input.size <= 80,
        "INVALID_DRAW",
        "Некорректный инструмент",
      );
      requireThat(
        !room.usedOperationIds.has(input.id),
        "DUPLICATE_OPERATION",
        "Это действие уже принято",
      );
      const points = validatePoints(input.points);
      requireThat(
        ["brush", "eraser"].includes(input.tool) ||
          points.length === (input.tool === "fill" ? 1 : 2),
        "INVALID_DRAW",
        "Некорректная фигура",
      );
      const retainedPoints =
        room.pointCount -
        room.redo.reduce((count, item) => count + item.points.length, 0);
      requireThat(
        room.operations.length < MAX_OPERATIONS &&
          retainedPoints + points.length <= MAX_POINTS,
        "DRAW_LIMIT",
        "История рисунка заполнена. Очистите холст, чтобы продолжить",
      );
      completeActive(room);
      const operation: DrawOperation = {
        id: input.id,
        tool: input.tool,
        color: input.color.toLowerCase(),
        size: input.size,
        points,
        complete:
          !["brush", "eraser"].includes(input.tool) || input.complete === true,
      };
      room.pointCount = retainedPoints;
      room.redo = [];
      room.operations.push(operation);
      room.usedOperationIds.add(operation.id);
      room.pointCount += points.length;
      room.revision += 1;
      if (room.usedOperationIds.size > 2048)
        room.usedOperationIds.delete(
          room.usedOperationIds.values().next().value!,
        );
      io.to(room.id).emit("DRAW:ADDED", {
        version: room.version,
        revision: room.revision,
        operation,
      });
    });
    on("DRAW:APPEND", (data) => {
      const { room } = requireDrawer(socket, data);
      const operation = room.operations.at(-1);
      requireThat(
        operation && operation.id === data.operationId && !operation.complete,
        "INVALID_STROKE",
        "Штрих уже завершён",
      );
      requireThat(
        typeof data.offset === "number" &&
          data.offset === operation.points.length,
        "STALE_DRAW",
        "Порядок точек изменился. Восстановите рисунок",
      );
      const points =
        Array.isArray(data.points) &&
        data.points.length === 0 &&
        data.complete === true
          ? []
          : validatePoints(data.points);
      requireThat(
        operation.points.length + points.length <= MAX_STROKE_POINTS &&
          room.pointCount + points.length <= MAX_POINTS,
        "DRAW_LIMIT",
        "Штрих слишком длинный. Отпустите указатель",
      );
      operation.points.push(...points);
      operation.complete = data.complete === true;
      room.pointCount += points.length;
      room.revision += 1;
      io.to(room.id).emit("DRAW:APPENDED", {
        version: room.version,
        revision: room.revision,
        operationId: operation.id,
        offset: data.offset,
        points,
        complete: operation.complete,
      });
    });
    for (const action of ["UNDO", "REDO", "CLEAR"] as const)
      on(`DRAW:${action}`, (data) => {
        const { room } = requireDrawer(socket, data);
        completeActive(room);
        if (action === "CLEAR") {
          room.operations = [];
          room.redo = [];
          room.pointCount = 0;
        }
        if (action === "UNDO" && room.operations.length)
          room.redo.push(room.operations.pop()!);
        if (action === "REDO" && room.redo.length)
          room.operations.push(room.redo.pop()!);
        room.revision += 1;
        publishDrawing(room);
      });
    socket.on("disconnect", () => {
      if (closing) return;
      const room = rooms.get(socket.data.roomId ?? "");
      const player = room?.players.get(socket.data.playerId ?? "");
      if (!room || !player || player.socketId !== socket.id) return;
      player.socketId = null;
      if (player.id === room.drawerId) completeActive(room);
      publish(room);
      player.timer = later(() => removePlayer(room, player), disconnectGraceMs);
    });
  });

  return {
    app,
    server,
    io,
    close: async () => {
      closing = true;
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      await new Promise<void>((resolve) => io.close(() => resolve()));
    },
  };
}
