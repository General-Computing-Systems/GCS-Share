const crypto = require('crypto');

const PAIRING_EXPIRY = 2 * 60 * 1000; // 2 minutes in milliseconds

let currentPairing = null;

function createPairing() {
    const token = crypto.randomBytes(32).toString('hex');

    currentPairing = {
        token,
        expiresAt: Date.now() + PAIRING_EXPIRY,
    };

    return {
        token,
        expiresAt: currentPairing.expiresAt,
    };
}

function consumePairing(token) {
    if (!currentPairing) {
        return false;
    }

    if (Date.now() > currentPairing.expiresAt) {
        currentPairing = null;
        return false;
    }

    if (token !== currentPairing.token) {
        return false;
    }

    currentPairing = null;
    return true;
}

module.exports = {
    createPairing,
    consumePairing,
};