const express = require('express');
const path = require('path');
const os = require("os");

const app = express();
const PORT = 3000;

app.use(express.json());

const {
    createPairing,
    consumePairing,

} = require("./pairing");

app.use(express.static(path.join(__dirname, "../public")));

app.get("/api/status", (req, res) => {
    res.json({
        name: "GCS Share",
        version: "0.1.0",
        status: "Online"
    });
});

app.post("/api/pairing/create", (req, res) => {
    const pairing = createPairing();

    res.json({
        success: true,
        token: pairing.token,
        expiresAt: pairing.expiresAt
    })
})

app.post("/api/pairing/verify", express.json(), (req, res) => {
    const { token } = req.body;

    if (!token || typeof token !== "string") {
        return res.status(400).json({
            success: false,
            message: "Invalid token"
        });
    }
    
    const valid = consumePairing(token);

    if (!valid) {
        return res.status(401).json({
            success: false,
            message: "Invalid or expired token"
        });
    }

    res.json({
        success: true,
        message: "Pairing Successful"
    });
});


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