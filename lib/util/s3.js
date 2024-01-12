module.exports = {
  uploadFromFile,
  uploadFromStream,
  filenameForBlob,
};

const Minio = require('minio');
const {
  server,
  accessKey,
  secretKey,
  bucketName,
} = require('config').get('default.s3blobStore');

const minioClient = (() => {
  const url = new URL(server);
  const useSSL = url.protocol === 'https:';
  const endPoint = (url.hostname + url.pathname).replace(/\/$/, '');
  const port = parseInt(url.port, 10);

  const clientConfig = { endPoint, port, useSSL, accessKey, secretKey };
  console.log('clientConfig:', clientConfig);
  return new Minio.Client(clientConfig);
})();

async function getUrl(objectName) {
  const presignedUrl = await minioClient.presignedGetObject(bucketName, objectName, 60/*seconds*/);
  console.log('presignedUrl:', presignedUrl);
}

async function uploadFromFile(filepath, objectName, contentType) {
  const metadata = getMetadata(contentType);
  const details = await minioClient.fPutObject(bucketName, objectName, filepath, metadata);
  console.log('File uploaded successfully; details:', details);

  return await getUrl(objectName);
}

async function uploadFromStream(readStream, objectName, contentType) {
  const metadata = getMetadata(contentType);
  const details = await minioClient.putObject(bucketName, objectName, readStream, metadata);
  console.log('File uploaded successfully; details:', details);

  return await getUrl(objectName);
}

function getMetadata(contentType) {
  return {
    'Content-Type': contentType,
  };
}

function filenameForBlob(blob) {
  if(blob.content) throw new Error('blob.content found.  Ideally this would be streamed to s3; consider rewriting query to avoid loading into memory.');

  const { md5, sha } = blob;

  if(!md5 || !sha) throw new Error(`blob missing required prop(s) from: md5, sha: ${blob}`);

  return `blob_md5_${md5}_sha_${sha}`;
}