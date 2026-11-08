const crypto = require('crypto');

const PAIRING_EXPIRY= 2 * 60 * 1000;

let currentPairing = null;

function createPairing(sessionId) {
    const token = crypto.randomBytes(32).toString('hex');

    currentPairing = {
        token,
        sessionId,
        expiresAt: Date.now() + PAIRING_EXPIRY
    };

    return {
        token,
        expiresAt: currentPairing.expiresAt
    };
}

function consumePairing(token) {
    if (!currentPairing) {
        return null;
    }

    if (Date.now() > currentPairing.expiresAt) {
        currentPairing = null;
        return null;
    }

    if (token !== currentPairing.token) {
        return null;
    }

    const pairing = currentPairing;
    currentPairing = null;

    return {
        sessionId: pairing.sessionId
    };
}

module.exports = {
    createPairing,
    consumePairing
};