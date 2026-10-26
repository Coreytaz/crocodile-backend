export type Point = { x: number; y: number };
export type Tool =
  "brush" | "eraser" | "line" | "rectangle" | "ellipse" | "fill";
export type DrawOperation = {
  id: string;
  tool: Tool;
  color: string;
  size: number;
  points: Point[];
  complete: boolean;
};
export type DrawingState = {
  version: number;
  revision: number;
  operations: DrawOperation[];
  redoCount: number;
};
export type Player = {
  id: string;
  name: string;
  connected: boolean;
  guessed: boolean;
};
export type ChatMessage = {
  id: string;
  text: string;
  time: number;
  kind: "chat" | "system";
  playerId?: string;
  name?: string;
};
export type RoundResult = {
  round: number;
  winnerId: string;
  winnerName: string;
  word: string;
};
export type RoomState = {
  id: string;
  ownerId: string;
  drawerId: string;
  version: number;
  hasWord: boolean;
  lastResult: RoundResult | null;
  players: Player[];
  messages: ChatMessage[];
};
export type PrivateWord = {
  version: number;
  word: string | null;
  options: string[];
};
export type Session = { roomId: string; playerId: string; token: string };
export type Reply<T> =
  | { ok: true; data: T }
  | { ok: false; error: { code: string; message: string } };
type Versioned = { version: number };
export type CommandPayloads = {
  "ROOM:CREATE": { name: string };
  "ROOM:JOIN": { roomId: string; name?: string; token?: string };
  "ROOM:LEAVE": Record<string, never>;
  "ROOM:SYNC": Record<string, never>;
  "ROOM:ASSIGN_DRAWER": Versioned & { playerId: string };
  "WORD:SELECT": Versioned & { word: string };
  "WORD:NEXT": Versioned;
  "CHAT:SEND": Versioned & { text: string };
  "DRAW:ADD": Versioned & { operation: DrawOperation };
  "DRAW:APPEND": Versioned & {
    operationId: string;
    offset: number;
    points: Point[];
    complete: boolean;
  };
  "DRAW:UNDO": Versioned;
  "DRAW:REDO": Versioned;
  "DRAW:CLEAR": Versioned;
};
export type CommandResults = {
  [E in keyof CommandPayloads]: E extends "ROOM:CREATE" | "ROOM:JOIN"
    ? Session
    : null;
};
export type ClientEvents = {
  [E in keyof CommandPayloads]: (
    data: CommandPayloads[E] & { commandId: string },
    ack: (reply: Reply<CommandResults[E]>) => void,
  ) => void;
};
export type Added = {
  version: number;
  revision: number;
  operation: DrawOperation;
};
export type Appended = {
  version: number;
  revision: number;
  operationId: string;
  offset: number;
  points: Point[];
  complete: boolean;
};
export type ServerEvents = {
  "ROOM:STATE": (state: RoomState) => void;
  "ROOM:REPLACED": () => void;
  "WORD:PRIVATE": (state: PrivateWord) => void;
  "CHAT:MESSAGE": (message: ChatMessage) => void;
  "DRAW:STATE": (state: DrawingState) => void;
  "DRAW:ADDED": (update: Added) => void;
  "DRAW:APPENDED": (update: Appended) => void;
};
