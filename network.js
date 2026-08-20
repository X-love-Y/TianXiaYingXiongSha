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

  async function doSave(rooms, metadata = {}) {
    const { changes, knownRevisions } = buildRoomChanges(rooms);
    writeLocalRooms(rooms);
    if (!Object.keys(changes).length) {
      lastServerSnapshot = clone(rooms);
      return rooms;
    }
    try {
      const payload = await request('/api/rooms', {
        method: 'PUT',
        body: JSON.stringify({ changes, knownRevisions, actorPlayerId: metadata.playerId || null })
      });
      if (payload.rooms) writeLocalRooms(payload.rooms, true);
      notifyRoomsChanged();
      return payload.rooms || rooms;
    } catch (error) {
      if (error && String(error.message || '').includes('409')) {
        try {
          const serverSnapshot = await request('/api/rooms', { method: 'GET' });
          if (serverSnapshot.rooms) {
            writeLocalRooms(serverSnapshot.rooms, true);
            notifyRoomsChanged();
            return serverSnapshot.rooms;
          }
        } catch {
          // Fall through to local state.
        }
      }
      return rooms;
    }
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
