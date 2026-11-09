require('dotenv').config();
const sql = require('./database');
const express = require('express');
const path = require('path');
const os = require("os");
const QRCode = require('qrcode');
const crypto = require("crypto");
const s3 = require('./storage');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const {
    ListBucketsCommand,
    PutObjectCommand,
    GetObjectCommand,
    DeleteObjectCommand,
    HeadObjectCommand
} = require('@aws-sdk/client-s3');

const app = express();
const PORT = 3000;
const FILEBASE_BUCKET = process.env.FILEBASE_BUCKET;
const TRANSFER_EXPIRY = 2 * 60 * 1000;
const activeDownloads = new Map();

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

async function authenticateDevice(req, res, next) {
    const deviceId = req.get("x-device-id");
    const sessionToken = req.get("x-session-token");

    if (!deviceId || !sessionToken) {
        return res.status(401).json({
            success: false,
            message: "Missing device credentials"
        });
    }

    try {
        const valid = await verifySession(deviceId, sessionToken);

        if (!valid) {
            return res.status(401).json({
                success: false,
                message: "Invalid session"
            });
        }

        req.deviceId = deviceId;
        next();
    } catch (error) {
        console.error("Session authentication failed:", error);

        res.status(500).json({
            success: false,
            message: "Authentication failed"
        });
    }
}

async function removeUploadedFile(filename) {
    await s3.send(new DeleteObjectCommand({
        Bucket: FILEBASE_BUCKET,
        Key: filename
    }));
}

async function expireTransfer(transfer) {
    const downloadState = activeDownloads.get(transfer.id);

    if (downloadState && downloadState.count > 0) {
        downloadState.expired = true;
        return;
    }

    activeDownloads.delete(transfer.id);

    try {
        await removeUploadedFile(transfer.file_id);
    } catch (error) {
        console.error("Expired transfer cleanup failed:", error);
    }

    await sql`
        DELETE FROM transfers
        WHERE id = ${transfer.id}
    `;
}

setInterval(async () => {
    try {
        const expiredTransfers = await sql`
            SELECT id, file_id
            FROM transfers
            WHERE expires_at <= NOW()
        `;

        for (const transfer of expiredTransfers) {
            await expireTransfer(transfer);
        }
    } catch (error) {
        console.error("Automatic transfer cleanup failed:", error);
    }
}, 1000).unref();

app.use(express.static(path.join(__dirname, "../public")));

app.post("/api/upload-url", authenticateDevice, async (req, res) => {
    try {
        const { filename, contentType, fileSize } = req.body;

        if (
            !filename ||
            typeof filename !== "string" ||
            !Number.isSafeInteger(fileSize) ||
            fileSize <= 0 ||
            fileSize > 50 * 1024 * 1024
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid file details"
            });
        }

        const recipientDeviceId = await getOtherDevice(req.deviceId);

        if (!recipientDeviceId) {
            return res.status(409).json({
                success: false,
                message: "No paired recipient is available"
            });
        }

        const safeName = path.basename(
            filename.replace(/\\/g, "/")
        )
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .replace(/[^a-zA-Z0-9._ -]/g, "")
        .trim()
        .replace(/^\.+/, "")
        .slice(0, 100) || "file";

        const fileId = `${crypto.randomUUID()}-${safeName}`;
        const safeContentType =
            typeof contentType === "string" && contentType.length <= 255
                ? contentType
                : "application/octet-stream";

        const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

        const command = new PutObjectCommand({
            Bucket: FILEBASE_BUCKET,
            Key: fileId,
            ContentType: safeContentType
        });

        const uploadUrl = await getSignedUrl(s3, command, {
            expiresIn: 300
        });

        await sql`
            INSERT INTO pending_uploads (
                file_id,
                sender_device_id,
                recipient_device_id,
                file_name,
                file_size,
                content_type,
                expires_at
            )
            VALUES (
                ${fileId},
                ${req.deviceId},
                ${recipientDeviceId},
                ${safeName},
                ${fileSize},
                ${safeContentType},
                ${expiresAt}
            )
        `;

        res.json({
            success: true,
            uploadUrl,
            fileId
        });

    } catch (error) {
        console.error("Presigned URL creation failed:", error);

        res.status(500).json({
            success: false,
            message: "Could not create upload URL"
        });
    }
});

app.post("/api/upload-complete", authenticateDevice, async (req, res) => {
    try {
        const { fileId } = req.body;

        if (!fileId || typeof fileId !== "string") {
            return res.status(400).json({
                success: false,
                message: "Invalid file ID"
            });
        }

        const result = await sql`
            SELECT *
            FROM pending_uploads
            WHERE file_id = ${fileId}
            AND sender_device_id = ${req.deviceId}
            LIMIT 1
        `;

        const pending = result[0];

        if (!pending) {
            return res.status(404).json({
                success: false,
                message: "Pending upload not found"
            });
        }

        if (new Date(pending.expires_at).getTime() <= Date.now()) {
            await s3.send(new DeleteObjectCommand({
                Bucket: FILEBASE_BUCKET,
                Key: fileId
            }));

            await sql`
                DELETE FROM pending_uploads
                WHERE file_id = ${fileId}
            `;

            return res.status(410).json({
                success: false,
                message: "Upload authorization expired"
            });
        }

        const file = await s3.send(new HeadObjectCommand({
            Bucket: FILEBASE_BUCKET,
            Key: fileId
        }));

        if (Number(file.ContentLength) !== Number(pending.file_size)) {
            await s3.send(new DeleteObjectCommand({
                Bucket: FILEBASE_BUCKET,
                Key: fileId
            }));

            await sql`
                DELETE FROM pending_uploads
                WHERE file_id = ${fileId}
            `;

            return res.status(400).json({
                success: false,
                message: "Uploaded file size does not match"
            });
        }

        const transferId = crypto.randomUUID();
        const expiresAt = new Date(Date.now() + TRANSFER_EXPIRY);

        await sql`
            INSERT INTO transfers (
                id,
                sender_device_id,
                recipient_device_id,
                file_id,
                file_name,
                file_size,
                status,
                expires_at
            )
            VALUES (
                ${transferId},
                ${pending.sender_device_id},
                ${pending.recipient_device_id},
                ${fileId},
                ${pending.file_name},
                ${pending.file_size},
                'pending',
                ${expiresAt}
            )
        `;

        await sql`
            DELETE FROM pending_uploads
            WHERE file_id = ${fileId}
        `;

        res.json({
            success: true,
            message: "File uploaded successfully",
            file: {
                id: fileId,
                originalName: pending.file_name,
                size: Number(pending.file_size)
            },
            transfer: {
                id: transferId,
                expiresAt: expiresAt.getTime()
            }
        });

    } catch (error) {
        console.error("Upload completion failed:", error);

        res.status(500).json({
            success: false,
            message: "Failed to complete upload"
        });
    }
});

app.get("/api/transfers/pending", authenticateDevice, async (req, res) => {
    const result = await sql`
        SELECT
            id,
            file_id,
            file_name,
            file_size,
            expires_at
        FROM transfers
        WHERE recipient_device_id = ${req.deviceId}
        AND status = 'pending'
        AND expires_at > NOW()
        ORDER BY created_at ASC
        LIMIT 1
    `;

    const transfer = result[0];

    res.json({
        success: true,
        transfer: transfer ? {
            id: transfer.id,
            senderName: "Connected device",
            file: {
                id: transfer.file_id,
                name: transfer.file_name,
                size: Number(transfer.file_size)
            },
            expiresAt: new Date(transfer.expires_at).getTime()
        } : null
    });
});

app.post("/api/transfers/:id/accept", authenticateDevice, async (req, res) => {
    const result = await sql`
        SELECT
            id,
            file_id,
            file_name,
            status,
            expires_at
        FROM transfers
        WHERE id = ${req.params.id}
        AND recipient_device_id = ${req.deviceId}
    `;

    const transfer = result[0];

    if (!transfer) {
        return res.status(404).json({
            success: false,
            message: "Transfer not found"
        });
    }

    if (new Date(transfer.expires_at).getTime() <= Date.now()) {
        return res.status(410).json({
            success: false,
            message: "Transfer expired"
        });
    }

    if (transfer.status === "pending") {
        await sql`
            UPDATE transfers
            SET
                status = 'accepted',
                accepted_at = NOW()
            WHERE id = ${transfer.id}
            AND status = 'pending'
        `;
    } else if (transfer.status !== "accepted") {
        return res.status(409).json({
            success: false,
            message: "Transfer is no longer pending"
        });
    }

    res.json({
        success: true,
        file: {
            id: transfer.file_id,
            name: transfer.file_name
        }
    });
});

app.post("/api/transfers/:id/decline", authenticateDevice, async (req, res) => {
    const result = await sql`
        SELECT id, file_id, status, expires_at
        FROM transfers
        WHERE id = ${req.params.id}
        AND recipient_device_id = ${req.deviceId}
    `;

    const transfer = result[0];

    if (!transfer) {
        return res.status(404).json({
            success: false,
            message: "Transfer not found"
        });
    }

    if (new Date(transfer.expires_at).getTime() <= Date.now()) {
        return res.status(410).json({
            success: false,
            message: "Transfer expired"
        });
    }

    if (transfer.status !== "pending") {
        return res.status(409).json({
            success: false,
            message: "Transfer is no longer pending"
        });
    }

    await sql`
        UPDATE transfers
        SET
            status = 'declined',
            declined_at = NOW()
        WHERE id = ${transfer.id}
        AND status = 'pending'
    `;

    await removeUploadedFile(transfer.file_id);

    res.json({ success: true });
});

app.post("/api/transfers/:id/complete", authenticateDevice, async (req, res) => {
    const result = await sql`
        SELECT
            id,
            file_id,
            status,
            expires_at
        FROM transfers
        WHERE id = ${req.params.id}
        AND recipient_device_id = ${req.deviceId}
    `;

    const transfer = result[0];

    if (!transfer) {
        return res.status(404).json({
            success: false,
            message: "Transfer not found"
        });
    }

    if (new Date(transfer.expires_at).getTime() <= Date.now()) {
        return res.status(410).json({
            success: false,
            message: "Transfer expired"
        });
    }

    if (transfer.status === "completed") {
        return res.json({ success: true });
    }

    if (transfer.status !== "accepted") {
        return res.status(409).json({
            success: false,
            message: "Transfer has not been accepted"
        });
    }

    try {
        await removeUploadedFile(transfer.file_id);
    } catch (error) {
        console.error("Completed transfer cleanup failed:", error);
        return res.status(500).json({
            success: false,
            message: "Could not clean up transferred file"
        });
    }

    await sql`
        UPDATE transfers
        SET
            status = 'completed',
            completed_at = NOW()
        WHERE id = ${transfer.id}
        AND status = 'accepted'
    `;

    res.json({ success: true });
});

app.get("/api/files/:id", authenticateDevice, async (req, res) => {
    const filename = req.params.id;

    if (path.basename(filename) !== filename) {
        return res.status(400).json({
            success: false,
            message: "Invalid filename"
        });
    }

    const result = await sql`
        SELECT
            id,
            file_id,
            file_name,
            status,
            expires_at
        FROM transfers
        WHERE file_id = ${filename}
        AND recipient_device_id = ${req.deviceId}
        LIMIT 1
    `;

    const transfer = result[0];

    if (!transfer) {
        return res.status(404).json({
            success: false,
            message: "Accepted transfer file not found"
        });
    }

    if (new Date(transfer.expires_at).getTime() <= Date.now()) {
        await expireTransfer(transfer);

        return res.status(410).json({
            success: false,
            message: "Transfer expired"
        });
    }

    if (transfer.status !== "accepted") {
        return res.status(409).json({
            success: false,
            message: "Transfer has not been accepted"
        });
    }

    try {
        const file = await s3.send(new GetObjectCommand({
            Bucket: FILEBASE_BUCKET,
            Key: filename
        }));

        if (!file.Body) {
            return res.status(404).json({
                success: false,
                message: "File not found in storage"
            });
        }

        res.attachment(transfer.file_name);
        res.setHeader(
            "Content-Type",
            file.ContentType || "application/octet-stream"
        );

        if (file.ContentLength !== undefined) {
            res.setHeader("Content-Length", file.ContentLength);
        }

        file.Body.on("error", error => {
            console.error("File download failed:", error);

            if (!res.headersSent) {
                res.status(500).end();
            } else {
                res.destroy(error);
            }
        });

        file.Body.pipe(res);

    } catch (error) {
        console.error("Filebase download failed:", error);

        return res.status(500).json({
            success: false,
            message: "Failed to retrieve file from storage"
        });
    }
});

app.get("/api/status", (req, res) => {
    res.json({
        name: "GCS Share",
        version: "0.1.0",
        status: "Online"
    });
});

app.get("/api/devices/me", async (req, res) => {
    const deviceId = req.get("x-device-id");
    const sessionToken = req.get("x-session-token");

    if (!deviceId || !sessionToken) {
        return res.status(401).json({
            success: false,
            message: "Missing device credentials"
        });
    }

    const valid = await verifySession(deviceId, sessionToken);

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

app.post("/api/pairing/create", async (req, res) => {
    const session = await createSession();
    const pairing = await createPairing(session.sessionId);

    res.json({
        success: true,
        token: pairing.token,
        expiresAt: pairing.expiresAt,
        deviceId: session.deviceId,
        sessionToken: session.sessionToken
    });
});

app.post("/api/pairing/verify", async (req, res) => {
    const { token } = req.body;

    if (!token || typeof token !== "string") {
        return res.status(400).json({
            success: false,
            message: "Invalid token"
        });
    }

    const pairing = await consumePairing(token);

    if (!pairing) {
        return res.status(401).json({
            success: false,
            message: "Invalid or expired token"
        });
    }

    try {
        const session = await joinSession(pairing.sessionId);

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
        const session = await createSession();
        const pairing = await createPairing(session.sessionId);

        const localIP = getLocalIPs().find(ip =>
            ip.interface === "Ethernet"
        )?.address
        
        if (!localIP) {
            throw new Error("No local network IP found");
        }

        const connectionUrl =
            `http://${localIP}:${PORT}/receive.html?token=${encodeURIComponent(pairing.token)}`;
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

console.log('Starting Neon connection test...');
console.log('DATABASE_URL loaded:', Boolean(process.env.DATABASE_URL));

console.log('Starting Filebase connection test...');

s3.send(new ListBucketsCommand({}))
    .then(result => {
        console.log('Filebase connected successfully!');
        console.log('Available buckets:', result.Buckets.map(bucket => bucket.Name));
    })
    .catch(error => {
        console.error('Filebase connection failed:', error.message);
    });

sql`SELECT NOW()`
    .then(result => {
        console.log('Neon connected successfully:', result[0].now);
    })
    .catch(error => {
        console.error('Neon connection failed:', error.message);
    });

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