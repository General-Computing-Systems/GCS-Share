const crypto = require('crypto');
const sql = require('./database');

const PAIRING_EXPIRY= 2 * 60 * 1000;

async function createPairing(sessionId) {
    const token = crypto.randomBytes(32).toString('hex');

    const tokenHash = crypto
        .createHash('sha256')
        .update(token)
        .digest('hex');

    const expiresAt = Date.now() + PAIRING_EXPIRY;

    await sql`
        DELETE FROM pairing_tokens
    `;

    await sql`
        INSERT INTO pairing_tokens (
            token_hash,
            session_id,
            expires_at
        )
        VALUES (
            ${tokenHash},
            ${sessionId},
            ${new Date(expiresAt)}
        )
    `;

    return {
        token,
        expiresAt
    };
}

async function consumePairing(token) {
    if (!token) {
        return null;
    }

    const tokenHash = crypto
        .createHash('sha256')
        .update(token)
        .digest('hex');

    const result = await sql`
        DELETE FROM pairing_tokens
        WHERE token_hash = ${tokenHash}
        AND expires_at > NOW()
        RETURNING session_id
    `;

    if (result.length === 0) {
        return null;
    }

    return {
        sessionId: result[0].session_id
    };
}

module.exports = {
    createPairing,
    consumePairing
};