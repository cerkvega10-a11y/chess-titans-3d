const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 8080;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon'
};

// ============================================================================
// 🌐 SISTEMA DE MULTIJUGADOR ONLINE, SALAS 1v1 DIRECTAS Y MATCHMAKING
// ============================================================================
let waitingPlayer = null; // Cola de espera para emparejamiento aleatorio
const directChallenges = new Map(); // key (par ordenado de nombres) -> { key, p1, p2, roomId, time }
const activeRooms = new Map(); // id -> { id, white, black, moves: [], turn: 'w', lastActive: Date.now() }

function cleanupStaleRooms() {
  const now = Date.now();
  for (const [id, room] of activeRooms.entries()) {
    if (now - room.lastActive > 1000 * 60 * 30) {
      activeRooms.delete(id);
    }
  }
  for (const [key, ch] of directChallenges.entries()) {
    if (now - ch.time > 1000 * 60 * 5) {
      directChallenges.delete(key);
    }
  }
}
setInterval(cleanupStaleRooms, 30000);

function parseJsonBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (e) {
        resolve({});
      }
    });
  });
}

const server = http.createServer(async (req, res) => {
  const urlParts = req.url.split('?');
  const safePath = urlParts[0];
  const queryStr = urlParts[1] || '';
  const queryParams = new URLSearchParams(queryStr);

  // Headers CORS para juego en red local o web
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  // ==========================================
  // RUTAS DE LA API MULTIJUGADOR ONLINE
  // ==========================================
  if (safePath.startsWith('/api/online/')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    // 1. EMPAREJAMIENTO ALEATORIO GLOBAL
    if (safePath === '/api/online/matchmake' && req.method === 'POST') {
      const data = await parseJsonBody(req);
      const playerId = data.playerId || ('p_' + Math.random().toString(36).substr(2, 9));
      const playerName = data.playerName || 'Ajedrecista';

      if (waitingPlayer && waitingPlayer.id !== playerId && (Date.now() - waitingPlayer.time < 15000)) {
        const roomId = 'room_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        const room = {
          id: roomId,
          white: { id: waitingPlayer.id, name: waitingPlayer.name },
          black: { id: playerId, name: playerName },
          moves: [],
          turn: 'w',
          lastActive: Date.now()
        };
        activeRooms.set(roomId, room);
        waitingPlayer.matchedRoomId = roomId;
        waitingPlayer = null;

        res.writeHead(200);
        res.end(JSON.stringify({ status: 'matched', roomId, color: 'b', opponentName: room.white.name }));
        return;
      }

      waitingPlayer = { id: playerId, name: playerName, time: Date.now(), matchedRoomId: null };
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'waiting', playerId }));
      return;
    }

    if (safePath === '/api/online/check-match' && req.method === 'GET') {
      const playerId = queryParams.get('playerId');
      for (const [roomId, room] of activeRooms.entries()) {
        if (room.white.id === playerId) {
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'matched', roomId, color: 'w', opponentName: room.black.name }));
          return;
        }
      }
      res.writeHead(200);
      res.end(JSON.stringify({ status: 'waiting' }));
      return;
    }

    // 2. RETO DIRECTO 1v1 POR NOMBRE DE USUARIO
    if (safePath === '/api/online/direct-challenge' && req.method === 'POST') {
      const data = await parseJsonBody(req);
      const myId = data.playerId;
      const myName = (data.playerName || 'Jugador').trim();
      const oppName = (data.targetName || '').trim();

      if (!oppName) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Nombre de contrincante requerido' }));
        return;
      }

      // Clave simétrica única basada en los dos nombres
      const pairKey = [myName.toLowerCase(), oppName.toLowerCase()].sort().join('___vs___');
      
      const existing = directChallenges.get(pairKey);
      if (existing && existing.p1.id !== myId && (Date.now() - existing.time < 25000)) {
        // ¡Coincidencia! El rival también te retó o está esperando
        const roomId = 'duel_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
        const room = {
          id: roomId,
          white: { id: existing.p1.id, name: existing.p1.name },
          black: { id: myId, name: myName },
          moves: [],
          turn: 'w',
          lastActive: Date.now()
        };
        activeRooms.set(roomId, room);
        existing.roomId = roomId;

        res.writeHead(200);
        res.end(JSON.stringify({ status: 'matched', roomId, color: 'b', opponentName: existing.p1.name }));
        return;
      }

      // Si no hay reto recíproco aún, registrar la espera
      directChallenges.set(pairKey, {
        key: pairKey,
        p1: { id: myId, name: myName },
        targetName: oppName,
        roomId: null,
        time: Date.now()
      });

      res.writeHead(200);
      res.end(JSON.stringify({ status: 'waiting_opponent', pairKey, myName, oppName }));
      return;
    }

    if (safePath === '/api/online/check-direct-challenge' && req.method === 'GET') {
      const playerId = queryParams.get('playerId');
      const pairKey = queryParams.get('pairKey');

      if (pairKey && directChallenges.has(pairKey)) {
        const ch = directChallenges.get(pairKey);
        if (ch.roomId && activeRooms.has(ch.roomId)) {
          const room = activeRooms.get(ch.roomId);
          const color = room.white.id === playerId ? 'w' : 'b';
          const opp = color === 'w' ? room.black.name : room.white.name;
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'matched', roomId: ch.roomId, color, opponentName: opp }));
          return;
        }
      }

      // Buscar si este jugador fue asignado a alguna sala
      for (const [roomId, room] of activeRooms.entries()) {
        if (room.white.id === playerId) {
          res.writeHead(200);
          res.end(JSON.stringify({ status: 'matched', roomId, color: 'w', opponentName: room.black.name }));
          return;
        }
      }

      res.writeHead(200);
      res.end(JSON.stringify({ status: 'waiting' }));
      return;
    }

    // 3. MOVIMIENTO EN TIEMPO REAL
    if (safePath === '/api/online/move' && req.method === 'POST') {
      const data = await parseJsonBody(req);
      const room = activeRooms.get(data.roomId);
      if (!room) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Sala no encontrada' }));
        return;
      }

      room.moves.push({ uci: data.move, from: data.playerId, time: Date.now() });
      room.turn = room.turn === 'w' ? 'b' : 'w';
      room.lastActive = Date.now();

      res.writeHead(200);
      res.end(JSON.stringify({ success: true, movesCount: room.moves.length }));
      return;
    }

    // 4. CONSULTA DE JUGADAS EN TIEMPO REAL
    if (safePath === '/api/online/poll' && req.method === 'GET') {
      const roomId = queryParams.get('roomId');
      const lastIndex = parseInt(queryParams.get('lastIndex') || '0', 10);
      const room = activeRooms.get(roomId);

      if (!room) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Sala no encontrada' }));
        return;
      }

      const newMoves = room.moves.slice(lastIndex);
      res.writeHead(200);
      res.end(JSON.stringify({
        moves: newMoves,
        totalMoves: room.moves.length,
        turn: room.turn
      }));
      return;
    }

    // 5. CANCELAR BÚSQUEDA
    if (safePath === '/api/online/cancel' && req.method === 'POST') {
      const data = await parseJsonBody(req);
      if (waitingPlayer && waitingPlayer.id === data.playerId) {
        waitingPlayer = null;
      }
      for (const [key, ch] of directChallenges.entries()) {
        if (ch.p1.id === data.playerId) {
          directChallenges.delete(key);
        }
      }
      res.writeHead(200);
      res.end(JSON.stringify({ canceled: true }));
      return;
    }
  }

  // ==========================================
  // SERVIR ARCHIVOS ESTÁTICOS
  // ==========================================
  let reqFile = safePath;
  if (reqFile === '/' || reqFile === '') reqFile = '/index.html';
  
  const filePath = path.join(__dirname, reqFile);
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, content) => {
    if (err) {
      if (err.code === 'ENOENT') {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('404 No encontrado');
      } else {
        res.writeHead(500);
        res.end(`Error del servidor: ${err.code}`);
      }
    } else {
      res.writeHead(200, {
        'Content-Type': contentType,
        'Cache-Control': 'no-cache'
      });
      res.end(content);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Servidor activo con multijugador online y duelos directos 1v1 en http://localhost:${PORT}`);
});
