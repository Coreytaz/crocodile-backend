const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, {
    cors: {
        origin: '*',
    }
});
const cors = require('cors')

app.use(cors());

app.use(express.json());

const rooms = new Map();

app.get('/game', (req, res) => {
    res.json(rooms);
})
app.post('/game', (req, res) => {
    const { roomId, userName } = req.body;
    if (!rooms.has(roomId)) {
        rooms.set(roomId, new Map([
            ['users', new Map()],
            ['messages', []],
        ]));
    }
    res.send();
})

io.on('connection', (socket) => {
    socket.on('ROOM:JOIN', data => {
        console.log(data);
    })
    console.log('user connected', socket.id);
})

server.listen(9999, (err) => {
    if (err) {
        throw Error(err);
    }
    console.log('Сервер запущен!');
})