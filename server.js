const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { pingTimeout: 60000, pingInterval: 10000 });

const PORT = 3000;
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// ─────────────────────────────────────────────────────
// Multi-Room State
// rooms[code] = { code, quiz, users, timer, analytics, status, ... }
// ─────────────────────────────────────────────────────
const rooms = {};

function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code;
    do {
        code = Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    } while (rooms[code]);
    return code;
}

function createRoom(quiz) {
    const code = generateRoomCode();
    rooms[code] = {
        code,
        quiz,
        users: {},
        currentQuestionIndex: -1,
        timer: null,
        timeLeft: 0,
        questionStartTime: null,
        analytics: [],
        status: 'waiting', // 'waiting' | 'active' | 'finished'
        createdAt: new Date().toISOString()
    };
    return code;
}

// ─────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────
const getQuizzes = () => {
    try { return JSON.parse(fs.readFileSync('./quizzes.json', 'utf8')); } catch (e) { return []; }
};
const saveQuizzes = (q) => fs.writeFileSync('./quizzes.json', JSON.stringify(q, null, 2));

function shuffleArray(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
}

function saveRoomState(code) {
    try {
        const room = rooms[code];
        if (!room || room.status === 'finished') return;
        const snapshot = {
            code, quizId: room.quiz.id,
            currentQuestionIndex: room.currentQuestionIndex,
            timeLeft: room.timeLeft,
            status: room.status,
            analytics: room.analytics,
            users: Object.fromEntries(
                Object.entries(room.users).map(([id, u]) => [
                    id, { name: u.name, score: u.score, streak: u.streak, answers: u.answers || [] }
                ])
            )
        };
        fs.writeFileSync(`./room_state_${code}.json`, JSON.stringify(snapshot, null, 2));
    } catch (e) {}
}

function getConsensus(code) {
    const room = rooms[code];
    if (!room) return { committed: 0, total: 0 };
    const users = Object.values(room.users);
    return { committed: users.filter(u => u.answeredCurrent).length, total: users.length };
}

function broadcastConsensus(code) {
    const c = getConsensus(code);
    io.to(code).emit('consensus_update', c);
    return c;
}

// ─────────────────────────────────────────────────────
// Quiz Flow Logic
// ─────────────────────────────────────────────────────
function sendQuestionToRoom(code) {
    const room = rooms[code];
    if (!room) return;
    room.currentQuestionIndex++;

    if (room.quiz && room.currentQuestionIndex < room.quiz.questions.length) {
        const question = room.quiz.questions[room.currentQuestionIndex];
        room.questionStartTime = Date.now();
        room.status = 'active';

        // Reset per-user answer state
        for (const id in room.users) {
            room.users[id].answeredCurrent = false;
            room.users[id].currentAnswerTime = null;
            room.users[id].lastAnswerCorrect = false;
        }
        broadcastConsensus(code);

        // Anti-Cheat: Send SHUFFLED options per socket individually
        io.sockets.adapter.rooms.get(code)?.forEach(socketId => {
            const shuffledOptions = shuffleArray(question.options);
            io.to(socketId).emit('new_question', {
                question: question.question,
                options: shuffledOptions,
                index: room.currentQuestionIndex,
                total: room.quiz.questions.length
            });
        });

        room.timeLeft = 20;
        io.to(code).emit('timer_update', room.timeLeft);

        clearInterval(room.timer);
        room.timer = setInterval(() => {
            room.timeLeft--;
            io.to(code).emit('timer_update', room.timeLeft);

            const c = broadcastConsensus(code);
            if (c.total > 0 && c.committed === c.total) {
                clearInterval(room.timer);
                setTimeout(() => handleTimeUp(code), 800);
                return;
            }
            if (room.timeLeft <= 0) {
                clearInterval(room.timer);
                handleTimeUp(code);
            }
        }, 1000);
    } else {
        finishQuiz(code);
    }
}

function handleTimeUp(code) {
    const room = rooms[code];
    if (!room || !room.quiz) return;
    const question = room.quiz.questions[room.currentQuestionIndex];

    // Collect analytics for this question
    const responses = Object.values(room.users).map(u => ({
        name: u.name,
        answered: u.answeredCurrent,
        isCorrect: u.lastAnswerCorrect || false,
        responseTime: u.currentAnswerTime || null
    }));
    const answered = responses.filter(r => r.answered);
    const correct = answered.filter(r => r.isCorrect);
    const avgResponseTime = answered.length
        ? Math.round(answered.reduce((s, r) => s + (r.responseTime || 0), 0) / answered.length)
        : 0;
    const totalPlayers = Object.keys(room.users).length;

    room.analytics.push({
        questionIndex: room.currentQuestionIndex,
        question: question.question,
        correctAnswer: question.correct,
        totalPlayers,
        totalAnswered: answered.length,
        totalCorrect: correct.length,
        accuracy: answered.length ? Math.round((correct.length / answered.length) * 100) : 0,
        avgResponseTime,
        dropOffRate: totalPlayers ? Math.round(((totalPlayers - answered.length) / totalPlayers) * 100) : 0
    });

    io.to(code).emit('question_result', { correct: question.correct });
    saveRoomState(code);
    setTimeout(() => triggerIntermission(code), 3500);
}

function triggerIntermission(code) {
    const room = rooms[code];
    if (!room) return;
    const scoreboard = Object.values(room.users)
        .map(u => ({ name: u.name, score: u.score }))
        .sort((a, b) => b.score - a.score);
    io.to(code).emit('intermission_state', { scoreboard });
    setTimeout(() => sendQuestionToRoom(code), 5000);
}

function finishQuiz(code) {
    const room = rooms[code];
    if (!room) return;
    room.status = 'finished';
    clearInterval(room.timer);

    const results = Object.values(room.users)
        .map(u => ({ name: u.name, score: u.score, tabSwitches: u.tabSwitches || 0 }))
        .sort((a, b) => b.score - a.score);

    const topPerformers = Object.values(room.users)
        .map(u => {
            const times = (u.answers || []).filter(a => a.responseTime).map(a => a.responseTime);
            const avgTime = times.length ? Math.round(times.reduce((s, t) => s + t, 0) / times.length) : null;
            return { name: u.name, score: u.score, avgResponseTime: avgTime };
        })
        .sort((a, b) => b.score - a.score || (a.avgResponseTime || 9999) - (b.avgResponseTime || 9999));

    io.to(code).emit('quiz_ended', { results, analytics: room.analytics, topPerformers });

    let allResults = [];
    try { allResults = JSON.parse(fs.readFileSync('./results.json', 'utf8')); } catch (e) {}
    allResults.push({
        date: new Date().toISOString(),
        quizTitle: room.quiz?.title || 'Unknown',
        roomCode: code,
        scores: results,
        analytics: room.analytics
    });
    fs.writeFileSync('./results.json', JSON.stringify(allResults, null, 2));

    try { fs.unlinkSync(`./room_state_${code}.json`); } catch (e) {}
    setTimeout(() => { delete rooms[code]; }, 60000);
}

// ─────────────────────────────────────────────────────
// Heartbeat (per-room topology)
// ─────────────────────────────────────────────────────
setInterval(() => {
    const timestamp = Date.now();
    io.emit('ping', timestamp);
    for (const code in rooms) {
        const nodes = Object.entries(rooms[code].users).map(([id, u]) => ({
            id, name: u.name,
            latency: u.latency || 0,
            joinedAt: u.joinedAt,
            status: u.latency > 500 ? 'poor' : 'healthy',
            tabSwitches: u.tabSwitches || 0,
            streak: u.streak || 0
        }));
        io.to(code).emit('network_topology_update', nodes);
    }
}, 2000);

// ─────────────────────────────────────────────────────
// REST APIs
// ─────────────────────────────────────────────────────
app.get('/api/quizzes', (req, res) => res.json(getQuizzes()));

app.post('/api/quizzes', (req, res) => {
    const { title, questions } = req.body;
    if (!title || !questions?.length) return res.status(400).json({ error: 'Missing fields' });
    const quizzes = getQuizzes();
    const newQuiz = { id: 'quiz-' + Date.now(), title, questions };
    quizzes.push(newQuiz);
    saveQuizzes(quizzes);
    res.json(newQuiz);
});

app.delete('/api/quizzes/:id', (req, res) => {
    let quizzes = getQuizzes().filter(q => q.id !== req.params.id);
    saveQuizzes(quizzes);
    res.json({ ok: true });
});

app.get('/api/results', (req, res) => {
    try { res.json(JSON.parse(fs.readFileSync('./results.json', 'utf8'))); } catch (e) { res.json([]); }
});

app.post('/api/rooms', (req, res) => {
    const { quizId } = req.body;
    const quiz = getQuizzes().find(q => q.id === quizId);
    if (!quiz) return res.status(404).json({ error: 'Quiz not found' });
    const code = createRoom(quiz);
    res.json({ code, quizTitle: quiz.title });
});

app.get('/api/rooms', (req, res) => {
    const summary = Object.values(rooms).map(r => ({
        code: r.code,
        quizTitle: r.quiz?.title,
        status: r.status,
        participantCount: Object.keys(r.users).length,
        createdAt: r.createdAt
    }));
    res.json(summary);
});

app.get('/api/rooms/:code', (req, res) => {
    const room = rooms[req.params.code.toUpperCase()];
    if (!room) return res.status(404).json({ error: 'Room not found' });
    res.json({ code: room.code, status: room.status, quizTitle: room.quiz?.title, participantCount: Object.keys(room.users).length });
});

// ─────────────────────────────────────────────────────
// WebSockets
// ─────────────────────────────────────────────────────
io.on('connection', (socket) => {

    socket.on('pong', (ts) => {
        const code = socket.data.roomCode;
        if (code && rooms[code]?.users[socket.id]) {
            rooms[code].users[socket.id].latency = Date.now() - ts;
        }
    });

    socket.on('join_room', ({ name, roomCode }) => {
        const code = roomCode.toUpperCase().trim();
        const room = rooms[code];
        if (!room) return socket.emit('error_message', 'Room not found. Check the code and try again.');
        if (room.status === 'finished') return socket.emit('error_message', 'This assessment has already ended.');

        // Reconnection: match by name
        const existingEntry = Object.entries(room.users).find(([, u]) => u.name.toLowerCase() === name.toLowerCase());
        if (existingEntry) {
            const [oldId, oldUser] = existingEntry;
            if (oldId !== socket.id) {
                room.users[socket.id] = { ...oldUser };
                delete room.users[oldId];
            }
        } else {
            room.users[socket.id] = {
                name, score: 0, streak: 0, tabSwitches: 0,
                answeredCurrent: false, joinedAt: new Date().toISOString(),
                latency: 0, answers: [], lastAnswerCorrect: false, currentAnswerTime: null
            };
        }

        socket.join(code);
        socket.data.roomCode = code;
        socket.emit('joined', { name, roomCode: code, quizTitle: room.quiz?.title, status: room.status });

        io.to(code).emit('user_list', Object.values(room.users).map(u => u.name));

        // Sync with starting state if countdown is in progress
        if (room.status === 'starting') {
            socket.emit('quiz_starting', { title: room.quiz.title, countdown: room.countdown });
        }

        // Fault tolerance: sync question if quiz is active
        if (room.status === 'active' && room.currentQuestionIndex >= 0) {
            const q = room.quiz.questions[room.currentQuestionIndex];
            socket.emit('new_question', {
                question: q.question,
                options: shuffleArray(q.options),
                index: room.currentQuestionIndex,
                total: room.quiz.questions.length
            });
            socket.emit('timer_update', room.timeLeft);
        }
        broadcastConsensus(code);
    });

    socket.on('join_admin_room', (code) => {
        const room = rooms[code.toUpperCase()];
        if (room) {
            socket.join(room.code);
            socket.data.roomCode = room.code;
            // Send initial topology
            const nodes = Object.entries(room.users).map(([id, u]) => ({
                id, name: u.name,
                latency: u.latency || 0,
                joinedAt: u.joinedAt,
                status: u.latency > 500 ? 'poor' : 'healthy',
                tabSwitches: u.tabSwitches || 0,
                streak: u.streak || 0
            }));
            socket.emit('network_topology_update', nodes);
        }
    });

    socket.on('start_quiz', (code) => {
        const room = rooms[code];
        if (!room || room.status !== 'waiting') return;
        
        room.status = 'starting';
        room.countdown = 5;

        for (const id in room.users) {
            room.users[id].score = 0;
            room.users[id].streak = 0;
            room.users[id].answers = [];
            room.users[id].answeredCurrent = false;
        }
        room.currentQuestionIndex = -1;
        room.analytics = [];

        io.to(code).emit('quiz_starting', { title: room.quiz.title, countdown: room.countdown });

        const countdownInterval = setInterval(() => {
            room.countdown--;
            io.to(code).emit('countdown_tick', room.countdown);
            if (room.countdown <= 0) {
                clearInterval(countdownInterval);
                sendQuestionToRoom(code);
            }
        }, 1000);
    });

    socket.on('submit_answer', ({ index, option, roomCode }) => {
        const code = roomCode || socket.data.roomCode;
        const room = rooms[code];
        if (!room) return;
        const user = room.users[socket.id];
        if (!user || user.answeredCurrent || room.currentQuestionIndex !== index) return;

        const responseTime = room.questionStartTime ? Date.now() - room.questionStartTime : null;
        const correctAns = room.quiz.questions[index].correct;
        const isCorrect = option === correctAns;

        user.answeredCurrent = true;
        user.lastAnswerCorrect = isCorrect;
        user.currentAnswerTime = responseTime;
        user.answers = user.answers || [];
        user.answers.push({ index, isCorrect, responseTime });

        if (isCorrect) {
            user.score++;
            user.streak++;
            if (user.streak > 0 && user.streak % 3 === 0) {
                io.to(code).emit('streak_alert', { name: user.name, streak: user.streak });
            }
        } else {
            user.streak = 0;
        }

        socket.emit('answer_ack', { state: 'success' });
        broadcastConsensus(code);
    });

    socket.on('tab_switch', ({ roomCode }) => {
        const code = roomCode || socket.data.roomCode;
        if (rooms[code]?.users[socket.id]) {
            const user = rooms[code].users[socket.id];
            user.tabSwitches = (user.tabSwitches || 0) + 1;
            // Immediate notification for admin
            io.to(code).emit('admin_notification', {
                type: 'tab_switch',
                user: user.name,
                count: user.tabSwitches
            });
        }
    });

    socket.on('send_reaction', (emoji) => {
        const code = socket.data.roomCode;
        if (!code) return;
        const name = rooms[code]?.users[socket.id]?.name || 'Admin';
        io.to(code).emit('receive_reaction', { emoji, name });
    });

    socket.on('disconnect', () => {
        const code = socket.data.roomCode;
        if (code && rooms[code]) {
            broadcastConsensus(code);
            // Keep user state for reconnect — do NOT delete
        }
    });
});

server.listen(PORT, () => console.log(`QuizPortal running on http://localhost:${PORT}`));
