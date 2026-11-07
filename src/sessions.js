const crypto = require('crypto');

const sessions = new Map();

function createSession() {
    const deviceId = crypto.randomUUID();
    const sessionToken = crypto.randomBytes(32).toString("hex");

    const tokenHash = crypto
        .createHash("sha256")
        .update(sessionToken)
        .digest("hex");

    sessions.set(deviceId, {
        tokenHash,
        createdAt: Date.now(),
    });

    return {
        deviceId,
        sessionToken,
    };
}

function verifySession(deviceId, sessionToken) {
    const session = sessions.get(deviceId);

    if (!session || !sessionToken) {
        return false;
    }

    const tokenHash = crypto
        .createHash("sha256")
        .update(sessionToken)
        .digest("hex");

    return crypti.timingSafeEqual(
        Buffer.from(tokenHash, "hex"),
        Buffer.from(session.tokenHash, "hex")
    );
}

function removeSession(deviceId) {
    return sessions.delete(deviceId);
}

module.exports = {
    createSession,
    verifySession,
    removeSession,
};