require('dotenv').config();

const {
    S3Client,
    PutBucketCorsCommand,
    GetBucketCorsCommand
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

async function configureCors() {
    try {
        await s3.send(new PutBucketCorsCommand({
            Bucket: process.env.FILEBASE_BUCKET,
            CORSConfiguration: {
                CORSRules: [
                    {
                        AllowedOrigins: ['*'],
                        AllowedMethods: ['PUT', 'GET', 'HEAD'],
                        AllowedHeaders: ['*'],
                        ExposeHeaders: ['ETag'],
                        MaxAgeSeconds: 3000
                    }
                ]
            }
        }));

        console.log('CORS configuration applied!');

        const result = await s3.send(new GetBucketCorsCommand({
            Bucket: process.env.FILEBASE_BUCKET
        }));

        console.log('Verified CORS rules:', result.CORSRules);

    } catch (error) {
        console.error('CORS configuration failed:', error);
    }
}

configureCors();