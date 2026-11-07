const express = require('express');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(express.static(path.join(__dirname, "../public")));

app.get("/api/status", (req, res) => {
    res.json({
        name: "GCS Share",
        version: "0.1.0",
        status: "Online"
    });
});

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server is running on http://localhost:${PORT}`);
})