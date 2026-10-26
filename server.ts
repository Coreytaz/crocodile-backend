import { createGameServer } from "./src/game-server.js";

const { server } = createGameServer();
const port = Number(process.env.PORT || 9999);
server.listen(port, () => console.log(`Crocodile: http://localhost:${port}`));
