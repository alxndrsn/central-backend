const tmp = require('tmp');
const yauzl = require('yauzl');
const { createWriteStream } = require('fs');

const streamTest = require('streamtest').v2;

const binaryParser = (res, callback) => {
  res.setEncoding('binary');
  res.data = ''; // TODO why res.data?  surely let.data is ok?
  res.on('data', (chunk) => { res.data += chunk; });
  res.on('end', () => {
    callback(null, Buffer.from(res.data, 'binary'));
  });
};

// unzip and detangle zipfiles.
// also, hooraaaayy callback hell.
// calls the callback with an object as follows:
// {
//      filenames: [ names of files in zip ],
//      {filename}: "contents",
//      {filename}: "contents",
//      …
// }
const processZipFile = (zipfile, callback) => {
  const result = { filenames: [] };
  const entries = [];
  let completed = 0;

  zipfile.on('entry', (entry) => entries.push(entry));
  zipfile.on('end', (err) => {
    if (err) return callback(err);

    if (entries.length === 0) {
      callback(null, result);
      zipfile.close();
    } else {
      entries.forEach((entry) => {
        result.filenames.push(entry.fileName);
        // eslint-disable-next-line no-shadow
        zipfile.openReadStream(entry, (err, resultStream) => {
          if (err) return callback(err);

          // eslint-disable-next-line no-shadow
          resultStream.pipe(streamTest.toText((err, contents) => {
            if (err) return callback(err);

            result[entry.fileName] = contents;
            completed += 1;
            if (completed === entries.length) {
              callback(null, result);
              zipfile.close();
            }
          }));
        });
      });
    }
  });
};

const zipStreamToFiles = (zipStream, callback) => {
  tmp.file((err, tmpfile) => {
    if (err) return callback(err);

    const writeStream = createWriteStream(tmpfile);
    zipStream.pipe(writeStream);
    zipStream.on('end', () => {
      setTimeout(() => {
        // eslint-disable-next-line no-shadow
        yauzl.open(tmpfile, { autoClose: false }, (err, zipfile) => {
          if (err) return callback(err);
          processZipFile(zipfile, callback);
        });
      }, 5); // otherwise sometimes the file doesn't fully drain
    });
  });
};

const httpZipResponseToFiles = (zipHttpResponse) => new Promise((resolve, reject) => {
  zipHttpResponse.buffer().parse(binaryParser).end((err, res) => {
    if (err) return reject(err);

    // eslint-disable-next-line no-shadow
    yauzl.fromBuffer(res.body, (err, zipfile) => {
      if (err) return reject(err);

      // eslint-disable-next-line no-shadow
      processZipFile(zipfile, (err, result) => { if (err) reject(err); else resolve(result); });
    });
  });
});

module.exports = { zipStreamToFiles, httpZipResponseToFiles };
