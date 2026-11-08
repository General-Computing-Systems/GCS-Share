const express = require('express');
const path = require('path');
const os = require("os");
const QRCode = require('qrcode');
const fs = require("fs");
const crypto = require("crypto");
const multer = require("multer")

const app = express();
const PORT = 3000;
const TRANSFER_EXPIRY = 2 * 60 * 1000;
const transfers = new Map();

const uploadDir = path.join(__dirname, "../uploads");

fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },

    filename: (req, file, cb) => {
        const safeName = path.basename(
            file.originalname.replace(/\\/g, "/")
        )
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/[^a-zA-Z0-9._ -]/g, "")
        .trim()
        .replace(/^\.+/, "")
        .slice(0,100) || "file";

        cb(null, `${crypto.randomUUID()}-${safeName}`);
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 50 * 1024 * 1024
    }
});

app.use(express.json());

const {
    createPairing,
    consumePairing,

} = require("./pairing");

const {
    createSession,
    joinSession,
    verifySession,
    getOtherDevice,
    getSharedSessionId,
    removeSession
} = require("./sessions");

function authenticateDevice(req, res, next) {
    const deviceId = req.get("x-device-id");
    const sessionToken = req.get("x-session-token");

    if (!deviceId || !sessionToken) {
        return res.status(401).json({
            success: false,
            message: "Missing device credentials"
        });
    }

    if (!verifySession(deviceId, sessionToken)) {
        return res.status(401).json({
            success: false,
            message: "Invalid session"
        });
    }

    req.deviceId = deviceId;
    next();
}

function removeUploadedFile(filename) {
    return fs.promises.unlink(path.join(uploadDir, filename)).catch(error => {
        if (error.code !== "ENOENT") throw error;
    });
}

function expireTransfer(transfer) {
    if (transfer.activeDownloads > 0) {
        transfer.expired = true;
        return;
    }

    transfers.delete(transfer.id);

    removeUploadedFile(transfer.file.id).catch(error => {
        console.error("Expired transfer cleanup failed:", error);
    });
}

setInterval(() => {
    const now = Date.now();
    for (const transfer of transfers.values()) {
        if (now >= transfer.expiresAt) {
            expireTransfer(transfer);
        }
    }
}, 1000).unref();

app.use(express.static(path.join(__dirname, "../public")));

app.post(
    "/api/upload",
    authenticateDevice,
    upload.single("file"),
    async (req, res) => {
        if (!req.file) {
            return res.status(400).json({
                success: false,
                message: "No file provided"
            });
        }

        const recipientDeviceId = getOtherDevice(req.deviceId);
        if (!recipientDeviceId) {
            await removeUploadedFile(req.file.filename);
            return res.status(409).json({
                success: false,
                message: "No paired recipient is available"
            });
        }

        const transfer = {
            id: crypto.randomUUID(),
            senderDeviceId: req.deviceId,
            recipientDeviceId,
            file: {
                id: req.file.filename,
                name: req.file.originalname,
                size: req.file.size
            },
            status: "pending",
            activeDownloads: 0,
            expired: false,
            expiresAt: Date.now() + TRANSFER_EXPIRY
        };
        transfers.set(transfer.id, transfer);

        res.json({
            success: true,
            message: "File uploaded successfully",
            file: {
                id: req.file.filename,
                originalName: req.file.originalname,
                size: req.file.size
            },
            transfer: {
                id: transfer.id,
                expiresAt: transfer.expiresAt
            }
        });
    }
);

app.get("/api/transfers/pending", authenticateDevice, (req, res) => {
    const now = Date.now();
    for (const transfer of transfers.values()) {
        if (now >= transfer.expiresAt) {
            expireTransfer(transfer);
        }
    }

    const transfer = [...transfers.values()].find(item =>
        item.recipientDeviceId === req.deviceId && item.status === "pending"
    );

    res.json({
        success: true,
        transfer: transfer ? {
            id: transfer.id,
            senderName: "Connected device",
            file: transfer.file,
            expiresAt: transfer.expiresAt
        } : null
    });
});

app.post("/api/transfers/:id/accept", authenticateDevice, (req, res) => {
    const transfer = transfers.get(req.params.id);
    if (!transfer || transfer.recipientDeviceId !== req.deviceId) {
        return res.status(404).json({ success: false, message: "Transfer not found" });
    }

    if (Date.now() >= transfer.expiresAt) {
        expireTransfer(transfer);
        return res.status(410).json({ success: false, message: "Transfer expired" });
    }

    if (transfer.status === "pending") {
        transfer.status = "accepted";
        transfer.acceptedAt = Date.now();
    } else if (transfer.status !== "accepted") {
        return res.status(409).json({ success: false, message: "Transfer is no longer pending" });
    }

    res.json({
        success: true,
        file: { id: transfer.file.id, name: transfer.file.name }
    });
});

app.post("/api/transfers/:id/decline", authenticateDevice, (req, res) => {
    const transfer = transfers.get(req.params.id);
    if (!transfer || transfer.recipientDeviceId !== req.deviceId) {
        return res.status(404).json({ success: false, message: "Transfer not found" });
    }

    if (Date.now() >= transfer.expiresAt) {
        expireTransfer(transfer);
        return res.status(410).json({ success: false, message: "Transfer expired" });
    }

    if (transfer.status !== "pending") {
        return res.status(409).json({ success: false, message: "Transfer is no longer pending" });
    }

    transfer.status = "declined";
    transfer.declinedAt = Date.now();
    res.json({ success: true });
});

app.post("/api/transfers/:id/complete", authenticateDevice, async (req, res) => {
    const transfer = transfers.get(req.params.id);
    if (!transfer || transfer.recipientDeviceId !== req.deviceId) {
        return res.status(404).json({ success: false, message: "Transfer not found" });
    }

    if (Date.now() >= transfer.expiresAt) {
        expireTransfer(transfer);
        return res.status(410).json({ success: false, message: "Transfer expired" });
    }

    if (transfer.status === "completed") {
        return res.json({ success: true });
    }
    if (transfer.status !== "accepted") {
        return res.status(409).json({ success: false, message: "Transfer has not been accepted" });
    }

    try {
        await removeUploadedFile(transfer.file.id);
    } catch (error) {
        console.error("Completed transfer cleanup failed:", error);
        return res.status(500).json({ success: false, message: "Could not clean up transferred file" });
    }

    transfer.status = "completed";
    transfer.completedAt = Date.now();
    res.json({ success: true });
});

app.get("/api/files/:id", authenticateDevice, (req, res) => {
    const filename = req.params.id;

    if (path.basename(filename) !== filename) {
        return res.status(400).json({
            success: false,
            message: "Invalid filename"
        });
    }

    const transfer = [...transfers.values()].find(item => item.file.id === filename);
    if (!transfer || transfer.recipientDeviceId !== req.deviceId) {
        return res.status(404).json({
            success: false,
            message: "Accepted transfer file not found"
        });
    }

    if (Date.now() >= transfer.expiresAt) {
        expireTransfer(transfer);
        return res.status(410).json({ success: false, message: "Transfer expired" });
    }

    if (transfer.status !== "accepted") {
        return res.status(409).json({ success: false, message: "Transfer has not been accepted" });
    }

    const filePath = path.resolve(uploadDir, filename);

    if (!filePath.startsWith(uploadDir + path.sep)) {
        return res.status(400).json({
            success: false,
            message: "Invalid file path"
        });
    }

    fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
            return res.status(404).json({
                success: false,
                message: "File not found"
            });
        }

        transfer.activeDownloads++;
        res.download(filePath, transfer.file.name, error => {
            transfer.activeDownloads--;

            if (transfer.activeDownloads === 0 && transfer.expired) {
                expireTransfer(transfer);
            }

            if (error) {
                console.error("File download failed:", error);
            }
        });
    });
});

app.get("/api/status", (req, res) => {
    res.json({
        name: "GCS Share",
        version: "0.1.0",
        status: "Online"
    });
});

app.get("/api/devices/me", (req, res) => {
    const deviceId = req.get("x-device-id");
    const sessionToken = req.get("x-session-token");

    if (!deviceId || !sessionToken) {
        return res.status(401).json({
            success: false,
            message: "Missing device credentials"
        });
    }

    const valid = verifySession(deviceId, sessionToken);

    if (!valid) {
        return res.status(401).json({
            success: false,
            message: "Invalid session"
        });
    }

    res.json({
        success: true,
        deviceId,
        status: "Connected"
    });
});

app.post("/api/pairing/create", (req, res) => {
    const session = createSession();
    const pairing = createPairing(session.sessionId);

    res.json({
        success: true,
        token: pairing.token,
        expiresAt: pairing.expiresAt,
        deviceId: session.deviceId,
        sessionToken: session.sessionToken
    });
});

app.post("/api/pairing/verify", (req, res) => {
    const { token } = req.body;

    if (!token || typeof token !== "string") {
        return res.status(400).json({
            success: false,
            message: "Invalid token"
        });
    }

    const pairing = consumePairing(token);

    if (!pairing) {
        return res.status(401).json({
            success: false,
            message: "Invalid or expired token"
        });
    }

    try {
        const session = joinSession(pairing.sessionId);

        res.json({
            success: true,
            message: "Pairing successful",
            deviceId: session.deviceId,
            sessionToken: session.sessionToken
        }); 
    } catch (error) {
        res.status(400).json({
            success: false,
            message: "Unable to join this session"
        });
    }
});

app.post("/api/pairing/qr", async (req, res) => {
    try {
        const session = createSession();
        const pairing = createPairing(session.sessionId);

        const localIP = getLocalIPs().find(ip =>
            ip.interface === "Ethernet"
        )?.address
        
        if (!localIP) {
            throw new Error("No local network IP found");
        }

        const connectionUrl =
            `http://${localIP}:${PORT}/connect.html?token=${encodeURIComponent(pairing.token)}`;
        const qrCode = await QRCode.toDataURL(connectionUrl);

        res.json({
            success: true,
            qrCode,
            expiresAt: pairing.expiresAt,
            deviceId: session.deviceId,
            sessionToken: session.sessionToken
        });
    } catch (error) {
        console.error("QR generation failed:", error);

        res.status(500).json({
            success: false,
            message: "Failed to generate QR code."
        })
    }
})

function getLocalIPs() {
    const interfaces = os.networkInterfaces();
    const addresses = [];

    for (const name of Object.keys(interfaces)) {
        for (const info of interfaces[name]) {
            if (info.family === "IPv4" && !info.internal) {
                addresses.push({
                    interface: name,
                    address: info.address
                });
            }
        }
    }
    return addresses;
}

app.listen(PORT, "0.0.0.0", () => {
    console.log("\n==========================================");
    console.log("             GCS Share is online!");
    console.log(`                Version: 0.1.0`);
    console.log(`                 Port: ${PORT}`);
    console.log("==========================================\n");

    console.log(`Local: http://localhost:${PORT}`);

    const addresses = getLocalIPs();

    if (addresses.length === 0) {
        console.log("\nNo local IP addresses found.");
    } else {
        console.log("\nAvailable local IP addresses:");

        for (const info of addresses) {
            console.log(
                `${info.interface}: http://${info.address}:${PORT}`
            );
        }
    }

    console.log("\n==========================================");
});