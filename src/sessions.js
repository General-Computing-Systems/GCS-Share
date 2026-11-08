const crypto = require('crypto');

const sessions = new Map();
const sharedSessions = new Map();

function createSession() {
    const sessionId = crypto.randomUUID();

    sharedSessions.set(sessionId, {
        devices: [],
        createdAt: Date.now()
    });

    return joinSession(sessionId);
}

function joinSession(sessionId) {
    const sharedSession = sharedSessions.get(sessionId);

    if (!sharedSession) {
        throw new Error('Shared session is full');
    }

    const deviceId = crypto.randomUUID();
    const sessionToken = crypto.randomBytes(32).toString('hex');

    const tokenHash = crypto
        .createHash('sha256')
        .update(sessionToken)
        .digest('hex');

    sessions.set(deviceId, {
        tokenHash,
        sessionId,
        createdAt: Date.now()
    });

    sharedSession.devices.push(deviceId);

    return {
        deviceId, sessionToken, sessionId
    };
}

function verifySession(deviceId, sessionToken) {
    const session = sessions.get(deviceId);

    if (!session || !sessionToken) {
        return false;
    }

    const tokenHash = crypto
        .createHash('sha256')
        .update(sessionToken)
        .digest('hex');

    return crypto.timingSafeEqual(
        Buffer.from(tokenHash, 'hex'),
        Buffer.from(session.tokenHash, 'hex')
    );
}

function getSharedSessionId(deviceId) {
    const session = sessions.get(deviceId);
    return session ? session.sessionId : null;
}

function getOtherDevice(deviceId) {
    const sessionId = getSharedSessionId(deviceId);

    if (!sessionId) return null;

    const sharedSession = sharedSessions.get(sessionId);

    if (!sharedSession) return null;

    return sharedSession.devices.find(id => id !== deviceId) || null;
}

function removeSession(deviceId) {
    const session = sessions.get(deviceId);

    if (!session) return false;

    const sharedSession = sharedSessions.get(session.sessionId);
    if (sharedSession) {
        sharedSession.devices = sharedSession.devices.filter(
            id => id !== deviceId
        );

        if (sharedSession.devices.length === 0) {
            sharedSessions.delete(session.sessionId);
        }
    }

    return sessions.delete(deviceId);
}

module.exports = {
    createSession,
    joinSession,
    verifySession,
    getSharedSessionId,
    getOtherDevice,
    removeSession
};