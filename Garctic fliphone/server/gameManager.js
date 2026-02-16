class GameManager {
    constructor(io, roomManager) {
        this.io = io;
        this.roomManager = roomManager;
        this.timers = new Map();
    }

    startGame(roomId) {
        const room = this.roomManager.getRoom(roomId);
        if (!room) return;

        room.state = 'playing';

        // Инициализируем цепочки — каждый игрок начинает свою
        room.chains = room.players.map((player, index) => ({
            id: index,
            startedBy: player.name,
            steps: [],
            reactions: {}
        }));

        // Порядок передачи: каждая цепочка сдвигается
        room.currentStep = 0;
        room.totalSteps = room.players.length; // Столько шагов = столько игроков
        room.submissions = new Map();

        // Генерируем модификаторы для каждого шага если включены
        if (room.settings.modifiers) {
            room.stepModifiers = this.generateModifiers(room.totalSteps);
        }

        this.io.to(roomId).emit('game-started', {
            totalSteps: room.totalSteps,
            mode: room.settings.mode,
            modifiers: room.settings.modifiers
        });

        // Первый шаг — все пишут фразу
        this.startStep(roomId);
    }

    startStep(roomId) {
        const room = this.roomManager.getRoom(roomId);
        if (!room) return;

        room.submissions = new Map();
        const step = room.currentStep;
        const isDrawing = step % 2 === 1; // Нечётные — рисуют, чётные — пишут

        // Определяем кто что видит
        room.players.forEach((player, playerIndex) => {
            // Какую цепочку обрабатывает этот игрок
            const chainIndex = (playerIndex + step) % room.players.length;
            const chain = room.chains[chainIndex];

            let taskData = {
                step,
                type: step === 0 ? 'write-first' : (isDrawing ? 'draw' : 'guess'),
                timeLimit: isDrawing ? room.settings.drawTime : room.settings.guessTime,
                chainIndex,
                modifier: room.stepModifiers ? room.stepModifiers[step] : null
            };

            // Передаём предыдущий результат
            if (step > 0 && chain.steps.length > 0) {
                const lastStep = chain.steps[chain.steps.length - 1];
                if (isDrawing) {
                    taskData.phrase = lastStep.content; // Видит фразу — рисует
                } else {
                    taskData.imageData = lastStep.content; // Видит рисунок — пишет
                }
            }

            this.io.to(player.id).emit('new-task', taskData);
        });

        // Таймер
        const timeLimit = (step === 0 || !isDrawing)
            ? room.settings.guessTime
            : room.settings.drawTime;

        this.startTimer(roomId, timeLimit);
    }

    submitPhrase(playerId, roomId, phrase) {
        const room = this.roomManager.getRoom(roomId);
        if (!room || room.state !== 'playing') return;

        const playerIndex = room.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1) return;

        const chainIndex = (playerIndex + room.currentStep) % room.players.length;
        const player = room.players[playerIndex];

        room.submissions.set(playerId, true);

        room.chains[chainIndex].steps.push({
            type: 'phrase',
            content: phrase,
            author: player.name,
            authorAvatar: player.avatar,
            timestamp: Date.now()
        });

        this.io.to(roomId).emit('submission-progress', {
            submitted: room.submissions.size,
            total: room.players.length
        });

        // Все отправили — следующий шаг
        if (room.submissions.size >= room.players.length) {
            this.nextStep(roomId);
        }
    }

    submitDrawing(playerId, roomId, imageData) {
        const room = this.roomManager.getRoom(roomId);
        if (!room || room.state !== 'playing') return;

        const playerIndex = room.players.findIndex(p => p.id === playerId);
        if (playerIndex === -1) return;

        const chainIndex = (playerIndex + room.currentStep) % room.players.length;
        const player = room.players[playerIndex];

        room.submissions.set(playerId, true);

        room.chains[chainIndex].steps.push({
            type: 'drawing',
            content: imageData,
            author: player.name,
            authorAvatar: player.avatar,
            timestamp: Date.now()
        });

        this.io.to(roomId).emit('submission-progress', {
            submitted: room.submissions.size,
            total: room.players.length
        });

        if (room.submissions.size >= room.players.length) {
            this.nextStep(roomId);
        }
    }

    nextStep(roomId) {
        this.clearTimer(roomId);

        const room = this.roomManager.getRoom(roomId);
        if (!room) return;

        room.currentStep++;

        if (room.currentStep >= room.totalSteps) {
            this.endGame(roomId);
        } else {
            // Пауза перед следующим шагом
            this.io.to(roomId).emit('step-transition', {
                nextStep: room.currentStep,
                totalSteps: room.totalSteps
            });
            setTimeout(() => this.startStep(roomId), 3000);
        }
    }

    endGame(roomId) {
        const room = this.roomManager.getRoom(roomId);
        if (!room) return;

        room.state = 'revealing';

        // Подсчёт очков и ачивок
        const results = this.calculateResults(room);

        // Сохраняем в галерею
        room.gallery.push(...room.chains.map(chain => ({
            ...chain,
            date: new Date().toISOString(),
            votes: 0
        })));

        this.io.to(roomId).emit('game-ended', {
            chains: room.chains,
            results,
            achievements: results.achievements
        });
    }

    calculateResults(room) {
        const results = {
            scores: {},
            achievements: []
        };

        room.players.forEach(p => {
            results.scores[p.name] = 0;
        });

        room.chains.forEach((chain, chainIdx) => {
            if (chain.steps.length < 2) return;

            const firstPhrase = chain.steps[0]?.content?.toLowerCase().trim();
            const lastPhrase = chain.steps[chain.steps.length - 1]?.type === 'phrase'
                ? chain.steps[chain.steps.length - 1]?.content?.toLowerCase().trim()
                : null;

            // Телепат — последняя фраза совпала с первой
            if (lastPhrase && firstPhrase === lastPhrase) {
                const author = chain.steps[chain.steps.length - 1].author;
                results.scores[author] = (results.scores[author] || 0) + 50;
                results.achievements.push({
                    player: author,
                    type: 'telepathist',
                    icon: '🎯',
                    text: 'Телепат! Угадал слово в слово!'
                });
            }

            // Разрушитель — фраза МАКСИМАЛЬНО далека от оригинала
            if (lastPhrase && firstPhrase) {
                const similarity = this.stringSimilarity(firstPhrase, lastPhrase);
                if (similarity < 0.1) {
                    results.achievements.push({
                        player: chain.steps[1]?.author || 'Unknown',
                        type: 'destroyer',
                        icon: '💀',
                        text: `Разрушитель! "${chain.steps[0].content}" → "${chain.steps[chain.steps.length - 1].content}"`
                    });
                }
            }
        });

        return results;
    }

    stringSimilarity(a, b) {
        if (a === b) return 1;
        const longer = a.length > b.length ? a : b;
        const shorter = a.length > b.length ? b : a;
        if (longer.length === 0) return 1;

        let matches = 0;
        const shorterWords = shorter.split(' ');
        const longerWords = longer.split(' ');
        shorterWords.forEach(word => {
            if (longerWords.includes(word)) matches++;
        });

        return matches / Math.max(longerWords.length, shorterWords.length);
    }

    generateModifiers(totalSteps) {
        const allModifiers = [
            { id: 'no-lift', name: 'Без отрыва', icon: '🖌', description: 'Рисуй одной линией!' },
            { id: 'one-color', name: 'Один цвет', icon: '🎨', description: 'Только случайный цвет', color: this.randomColor() },
            { id: 'pixel', name: 'Пиксель-арт', icon: '⬛', description: 'Сетка 16x16' },
            { id: 'mirror', name: 'Зеркало', icon: '🪞', description: 'Холст отзеркален!' },
            { id: 'upside-down', name: 'Вверх ногами', icon: '🔄', description: 'Холст перевёрнут!' },
            { id: 'speed', name: 'Бомба', icon: '💣', description: 'Только 15 секунд!' },
            { id: 'fog', name: 'Туман войны', icon: '👀', description: 'Видишь только часть' },
            { id: 'thick', name: 'Толстая кисть', icon: '🖊', description: 'Минимальная толщина 20px' },
            { id: 'none', name: 'Без модификатора', icon: '✨', description: 'Повезло!' }
        ];

        const modifiers = [null]; // Первый шаг (ввод фразы) — без модификатора
        for (let i = 1; i < totalSteps; i++) {
            if (i % 2 === 1) { // Только для шагов рисования
                const mod = allModifiers[Math.floor(Math.random() * allModifiers.length)];
                modifiers.push(mod);
            } else {
                modifiers.push(null);
            }
        }
        return modifiers;
    }

    randomColor() {
        const colors = ['#FF0000', '#00FF00', '#0000FF', '#FF00FF', '#FFAA00', '#00FFFF'];
        return colors[Math.floor(Math.random() * colors.length)];
    }

    startTimer(roomId, seconds) {
        this.clearTimer(roomId);

        let remaining = seconds;

        const interval = setInterval(() => {
            remaining--;
            this.io.to(roomId).emit('timer-tick', { remaining });

            if (remaining <= 0) {
                this.clearTimer(roomId);
                this.forceSubmissions(roomId);
            }
        }, 1000);

        this.timers.set(roomId, interval);
    }

    clearTimer(roomId) {
        const timer = this.timers.get(roomId);
        if (timer) {
            clearInterval(timer);
            this.timers.delete(roomId);
        }
    }

    forceSubmissions(roomId) {
        const room = this.roomManager.getRoom(roomId);
        if (!room) return;

        // Игроки, которые не отправили
        room.players.forEach((player, playerIndex) => {
            if (!room.submissions.has(player.id)) {
                const chainIndex = (playerIndex + room.currentStep) % room.players.length;
                const isDrawing = room.currentStep % 2 === 1;

                room.chains[chainIndex].steps.push({
                    type: isDrawing ? 'drawing' : 'phrase',
                    content: isDrawing ? '' : '(не успел 😅)',
                    author: player.name,
                    authorAvatar: player.avatar,
                    timestamp: Date.now(),
                    timeout: true
                });

                room.submissions.set(player.id, true);
            }
        });

        this.nextStep(roomId);
    }

    addReaction(roomId, chainIndex, stepIndex, emoji) {
        const room = this.roomManager.getRoom(roomId);
        if (!room) return;

        const chain = room.chains[chainIndex];
        if (!chain) return;

        const key = `${chainIndex}-${stepIndex}`;
        if (!chain.reactions[key]) chain.reactions[key] = {};
        chain.reactions[key][emoji] = (chain.reactions[key][emoji] || 0) + 1;
    }
}

module.exports = { GameManager };