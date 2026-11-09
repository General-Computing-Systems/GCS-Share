const {
    S3Client
} = require('@aws-sdk/client-s3');

const s3 = new S3Client({
    endpoint: 'https://s3.filebase.io',
    region: 'auto',
    credentials: {
        accessKeyId: process.env.FILEBASE_ACCESS_KEY,
        secretAccessKey: process.env.FILEBASE_SECRET_KEY
    },
    forcePathStyle: true
});

module.exports = s3;