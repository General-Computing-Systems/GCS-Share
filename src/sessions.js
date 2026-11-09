const crypto = require('crypto');
const sql = require('./database');

async function createSession() {
    const sessionId = crypto.randomUUID();

    await sql `
        INSERT INTO shared_sessions (id)
        VALUES (${sessionId})
    `;

    return joinSession(sessionId);
}

async function joinSession(sessionId) {
    const sharedSession = await sql`
        SELECT id
        FROM shared_sessions
        WHERE id = ${sessionId}
    `;

    if (sharedSession.length === 0) {
        throw new Error('Shared session not found');
    }

    const deviceId = crypto.randomUUID();
    const sessionToken = crypto.randomBytes(32).toString('hex');

    const tokenHash = crypto
        .createHash('sha256')
        .update(sessionToken)
        .digest('hex');

    await sql`
        INSERT INTO session_devices (
            device_id,
            session_id,
            token_hash
        )
        VALUES (
            ${deviceId},
            ${sessionId},
            ${tokenHash}
        )
    `;

    return {
        deviceId,
        sessionToken,
        sessionId
    };
}

async function verifySession(deviceId, sessionToken) {
    if (!deviceId || !sessionToken) {
        return false;
    }

    const result = await sql`
        SELECT token_hash
        FROM session_devices
        WHERE device_id = ${deviceId}
    `;

    if (result.length === 0) {
        return false;
    }

    const tokenHash = crypto
        .createHash('sha256')
        .update(sessionToken)
        .digest('hex');

    return crypto.timingSafeEqual(
        Buffer.from(tokenHash, 'hex'),
        Buffer.from(result[0].token_hash, 'hex')
    );
}

async function getSharedSessionId(deviceId) {
    const result = await sql`
        SELECT session_id
        FROM session_devices
        WHERE device_id = ${deviceId}
    `;

    return result.length > 0 ? result[0].session_id : null;
}

async function getOtherDevice(deviceId) {
    const result = await sql`
        SELECT other.device_id
        FROM session_devices AS current
        JOIN session_devices AS other
            ON other.session_id = current.session_id
            AND other.device_id <> current.device_id
        WHERE current.device_id = ${deviceId}
        LIMIT 1
    `;

    return result.length > 0 ? result[0].device_id : null;
}

async function removeSession(deviceId) {
    const result = await sql`
        DELETE FROM session_devices
        WHERE device_id = ${deviceId}
        RETURNING session_id
    `;

    if (result.length === 0) {
        return false;
    }

    const sessionId = result[0].session_id;

    await sql`
        DELETE FROM shared_sessions
        WHERE id = ${sessionId}
        AND NOT EXISTS (
            SELECT 1
            FROM session_devices
            WHERE session_id = ${sessionId}
        )
    `;

    return true;
}

module.exports = {
    createSession,
    joinSession,
    verifySession,
    getSharedSessionId,
    getOtherDevice,
    removeSession
};