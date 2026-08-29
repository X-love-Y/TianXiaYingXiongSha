(function () {
  const roomStorageKey = 'heroKillLocalRooms';
  const apiBase = '';
  let connected = false;
  let applyingRemote = false;
  let lastServerSnapshot = {};
  let saveQueue = Promise.resolve();

  function canUseNetwork() {
    return location.protocol === 'http:' || location.protocol === 'https:';
  }

  function readLocalRooms() {
    try {
      return JSON.parse(localStorage.getItem(roomStorageKey)) || {};
    } catch {
      return {};
    }
  }

  function clone(value) {
    return JSON.parse(JSON.stringify(value || {}));
  }

  function writeLocalRooms(rooms, remote = false) {
    applyingRemote = remote;
    localStorage.setItem(roomStorageKey, JSON.stringify(rooms || {}));
    applyingRemote = false;
    if (remote) lastServerSnapshot = clone(rooms);
  }

  function notifyRoomsChanged() {
    try {
      window.dispatchEvent(new StorageEvent('storage', { key: roomStorageKey }));
    } catch {
      window.dispatchEvent(new Event('heroKillRoomsChanged'));
    }
  }

  async function request(path, options = {}) {
    if (!canUseNetwork()) throw new Error('Network sync requires http(s).');
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: {
        'Content-Type': 'application/json',
        ...(options.headers || {})
      }
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.message || `Request failed: ${response.status}`);
    return payload;
  }

  async function loadRooms() {
    try {
      const payload = await request('/api/rooms', { method: 'GET' });
      if (payload.rooms) {
        writeLocalRooms(payload.rooms, true);
        notifyRoomsChanged();
      }
      return payload.rooms || readLocalRooms();
    } catch {
      return readLocalRooms();
    }
  }

  function buildRoomChanges(rooms) {
    const currentRooms = rooms || {};
    const changes = {};
    const knownRevisions = {};
    const roomCodes = new Set([...Object.keys(lastServerSnapshot), ...Object.keys(currentRooms)]);

    roomCodes.forEach((roomCode) => {
      const previousRoom = lastServerSnapshot[roomCode];
      const currentRoom = currentRooms[roomCode];
      if (previousRoom) knownRevisions[roomCode] = previousRoom.revision || 0;
      if (!previousRoom && !currentRoom) return;
      if (!currentRoom) {
        changes[roomCode] = null;
        return;
      }
      if (!previousRoom || JSON.stringify(previousRoom) !== JSON.stringify(currentRoom)) {
        changes[roomCode] = currentRoom;
      }
    });

    return { changes, knownRevisions };
  }

  // 409 冲突时，将“本地新建的房间 / 本地新加入的玩家”合并进服务器最新快照，
  // 避免整批提交被打回后本地状态被服务器快照覆盖，导致“房间建了/加入了但本地没记录”。
  function mergeLocalIntoServer(serverRooms, localRooms) {
    const merged = clone(serverRooms || {});
    Object.keys(localRooms || {}).forEach((roomCode) => {
      const local = localRooms[roomCode];
      if (!local) return;
      const server = merged[roomCode];
      if (!server) {
        // 服务器还没有该房间：保留本地（本地新建房间的意图）
        merged[roomCode] = clone(local);
        return;
      }
      const serverPlayers = server.players || [];
      const localPlayers = local.players || [];
      const missing = localPlayers.filter((player) => !serverPlayers.some((item) => item.id === player.id));
      if (missing.length) {
        merged[roomCode] = { ...server, players: [...serverPlayers, ...missing] };
      }
    });
    return merged;
  }

  async function doSave(rooms, metadata = {}) {
    let current = rooms;
    let built = buildRoomChanges(current);
    writeLocalRooms(current);
    if (!Object.keys(built.changes).length) {
      lastServerSnapshot = clone(current);
      return current;
    }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const payload = await request('/api/rooms', {
          method: 'PUT',
          body: JSON.stringify({ changes: built.changes, knownRevisions: built.knownRevisions, actorPlayerId: metadata.playerId || null })
        });
        if (payload.rooms) writeLocalRooms(payload.rooms, true);
        notifyRoomsChanged();
        return payload.rooms || current;
      } catch (error) {
        // 非 409 错误保持原有“乐观写入、静默返回本地”的行为，避免创建/加入被网络抖动打断。
        if (!String(error.message || '').includes('409')) return current;
        // 409：拉取服务器最新快照，合并本地意图后，以服务器为基准重算变更并重试
        const serverSnapshot = await request('/api/rooms', { method: 'GET' }).catch(() => null);
        if (!serverSnapshot || !serverSnapshot.rooms) throw error;
        const merged = mergeLocalIntoServer(serverSnapshot.rooms, current);
        writeLocalRooms(merged);
        lastServerSnapshot = clone(serverSnapshot.rooms);
        notifyRoomsChanged();
        current = merged;
        built = buildRoomChanges(merged);
        if (!Object.keys(built.changes).length) return current;
        }
    }
    return current;
  }

  function saveRooms(rooms, metadata = {}) {
    if (applyingRemote) return Promise.resolve(rooms);
    const snapshot = clone(rooms);
    saveQueue = saveQueue
      .catch(() => {})
      .then(() => doSave(snapshot, metadata));
    return saveQueue;
  }

  function connectRooms() {
    if (connected || !canUseNetwork() || !window.EventSource) return;
    connected = true;
    const events = new EventSource('/api/rooms/events');
    events.addEventListener('rooms', (event) => {
      try {
        const payload = JSON.parse(event.data);
        if (!payload.rooms) return;
        writeLocalRooms(payload.rooms, true);
        notifyRoomsChanged();
      } catch {
        // Ignore a malformed sync event; the next server event will refresh state.
      }
    });
    events.onerror = () => {
      connected = false;
      events.close();
      setTimeout(connectRooms, 1200);
    };
  }

  window.HeroKillNet = {
    loadRooms,
    saveRooms,
    connectRooms,
    readLocalRooms
  };

  connectRooms();
})();
