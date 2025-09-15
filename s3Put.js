const { S3Client, PutObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');

const s3 = new S3Client({ region: process.env.AWS_REGION || 'us-east-2' });
const BUCKET = process.env.S3_BUCKET;

async function putBuffer({ key, buffer, contentType }) {
  if (!BUCKET) throw new Error('S3 bucket not configured');
  await s3.send(new PutObjectCommand({
    Bucket: BUCKET,
    Key: key,
    Body: buffer,
    ContentType: contentType || 'application/octet-stream',
  }));
  return { bucket: BUCKET, key };
}

async function exists({ key }) {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

module.exports = { putBuffer, exists, BUCKET };
