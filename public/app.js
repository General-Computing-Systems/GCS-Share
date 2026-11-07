fetch("/api/status")
    .then(reponse => response.json())
    .then(data => {
        document.getElementById("status").textContent =
            `${data.name} is ${data.status}. Version ${data.version}`;
    })
    .catch(() => {
        document.getElementById("status").textContent =
            "Could not connect to GCS Share.";
    });