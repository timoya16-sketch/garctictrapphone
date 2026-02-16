const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { RoomManager } = require('./roomManager');
const { GameManager } = require('./gameManager');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" },
    maxHttpBufferSize: 5e6 // 5MB для картинок
});

app.use(express.static(path.join(__dirname, '../client')));

const roomManager = new RoomManager();
const gameManager = new GameManager(io, roomManager);

io.on('connection', (socket) => {
    console.log(`✅ Подключился: ${socket.id}`);

    // ========== ЛОББИ ==========

    socket.on('create-room', ({ playerName, settings }) => {
        const room = roomManager.createRoom(socket.id, playerName, settings);
        socket.join(room.id);
        socket.emit('room-created', room);
        console.log(`🏠 Комната ${room.id} создана игроком ${playerName}`);
    });

    socket.on('join-room', ({ roomId, playerName }) => {
        const result = roomManager.joinRoom(roomId, socket.id, playerName);

        if (result.error) {
            socket.emit('error-message', result.error);
            return;
        }

        socket.join(roomId);
        socket.emit('room-joined', result.room);
        io.to(roomId).emit('player-joined', {
            players: result.room.players,
            newPlayer: playerName
        });
        console.log(`👤 ${playerName} вошёл в комнату ${roomId}`);
    });

    // ========== ИГРА ==========

    socket.on('start-game', ({ roomId }) => {
        const room = roomManager.getRoom(roomId);
        if (!room) return;
        if (room.hostId !== socket.id) {
            socket.emit('error-message', 'Только хост может начать игру');
            return;
        }
        if (room.players.length < 3) {
            socket.emit('error-message', 'Нужно минимум 3 игрока');
            return;
        }
        gameManager.startGame(roomId);
    });

    socket.on('submit-phrase', ({ roomId, phrase }) => {
        gameManager.submitPhrase(socket.id, roomId, phrase);
    });

    socket.on('submit-drawing', ({ roomId, imageData }) => {
        gameManager.submitDrawing(socket.id, roomId, imageData);
    });

    socket.on('submit-reaction', ({ roomId, chainIndex, stepIndex, emoji }) => {
        gameManager.addReaction(roomId, chainIndex, stepIndex, emoji);
        io.to(roomId).emit('reaction-added', { chainIndex, stepIndex, emoji });
    });

    // ========== ОТКЛЮЧЕНИЕ ==========

    socket.on('disconnect', () => {
        const roomId = roomManager.removePlayer(socket.id);
        if (roomId) {
            const room = roomManager.getRoom(roomId);
            if (room) {
                io.to(roomId).emit('player-left', {
                    players: room.players,
                    leftPlayerId: socket.id
                });
            }
        }
        console.log(`❌ Отключился: ${socket.id}`);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Сервер запущен: http://localhost:${PORT}`);
});